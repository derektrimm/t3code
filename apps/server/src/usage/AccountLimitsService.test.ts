// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  AccountLimitsService,
  type LimitsSeedTarget,
  layer as accountLimitsLayer,
  make as makeService,
  planLimitsSeeds,
} from "./AccountLimitsService.ts";

const asInstanceId = (value: string): ProviderInstanceId => ProviderInstanceId.make(value);
const asDriver = (value: string): ProviderDriverKind => ProviderDriverKind.make(value);

/** A codex app-server notification, shaped after a real transcript line. */
const codexPayload = (usedPercent: number) => ({
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1_786_677_720 },
  secondary: null,
  plan_type: "pro",
});

/** A full Claude usage snapshot (the SDK usage control response). */
const claudeUsagePayload = (fiveHour: number, weekly: number) => ({
  subscription_type: "max",
  rate_limits: {
    five_hour: { utilization: fiveHour, resets_at: "2026-08-08T23:00:00.000Z" },
    seven_day: { utilization: weekly, resets_at: "2026-08-11T17:00:00.000Z" },
  },
});

/** The streamed single-window Claude event. */
const claudeWindowPayload = (utilization: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    rateLimitType: "five_hour",
    utilization,
    resetsAt: 1_786_600_800,
  },
});

/**
 * Every instance the tests ingest for must exist in settings: readSummary
 * evicts rows for deleted instances. Codex homes point at paths that do not
 * exist so the transcript seed can never touch this machine's real
 * ~/.codex/sessions mid-test.
 */
const instanceRoster = (): Partial<ServerSettings> => ({
  providerInstances: {
    [asInstanceId("codex")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-default" },
    },
    [asInstanceId("codex_a")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-a" },
    },
    [asInstanceId("codex_b")]: {
      driver: asDriver("codex"),
      config: { homePath: "/nonexistent/t3-test-codex-b" },
    },
    [asInstanceId("claude_main")]: { driver: asDriver("claudeAgent") },
    [asInstanceId("claude_partner")]: { driver: asDriver("claudeAgent") },
  },
});

const makeLayer = (overrides: Partial<ServerSettings> = instanceRoster()) =>
  accountLimitsLayer.pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest(overrides)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-account-limits-test-",
        }),
      ),
    ),
  );

const accountLimitsLayerWith = (
  pullers: Parameters<typeof makeService>[0],
  overrides: Partial<ServerSettings>,
) =>
  Layer.effect(AccountLimitsService, makeService(pullers)).pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest(overrides)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-account-limits-test-",
        }),
      ),
    ),
  );

const makeLayerAt = (baseDir: string, overrides: Partial<ServerSettings> = instanceRoster()) =>
  accountLimitsLayer.pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest(overrides)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
  );

it.layer(NodeServices.layer)("account limits service", (it) => {
  it.effect("keeps one snapshot per instance - accounts no longer overwrite each other", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(10),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      // Older than codex_a's event: the per-slot ordering guard must not let
      // one instance's traffic suppress another's - that is the bug.
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(55),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_b"),
      });
      const summary = yield* service.readSummary();
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.instanceId,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([
        ["codex_a", 10],
        ["codex_b", 55],
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("still guards ordering within one instance", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(20),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(90),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.windows[0]?.usedPercent)).toEqual([20]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("events without an instance id flow to the driver's default instance", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(33),
        createdAt: "2026-08-15T12:00:00.000Z",
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["codex"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("claude window events patch their own instance's window set only", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeUsagePayload(24, 18),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("claude_main"),
      });
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeWindowPayload(87.5),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("claude_partner"),
      });
      const summary = yield* service.readSummary();
      const main = summary.snapshots.find((snapshot) => snapshot.instanceId === "claude_main");
      const partner = summary.snapshots.find(
        (snapshot) => snapshot.instanceId === "claude_partner",
      );
      // Main keeps its full two-window snapshot untouched; partner's streamed
      // window must not have been patched into main's set.
      expect(main?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 24],
        ["seven_day", 18],
      ]);
      expect(partner?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 87.5],
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("v1 cache rows load under the default instance until live data settles them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      // A row written before instance attribution: no instanceId field. It
      // held "whichever account wrote last", so the default instance is only
      // its least-wrong home, not its identity.
      yield* fileSystem.writeFileString(
        path.join(config.stateDir, "account-limits.json"),
        `[
          {
            "provider": "claude",
            "plan": "max",
            "windows": [
              {
                "id": "five_hour",
                "label": "5h",
                "usedPercent": 62,
                "resetsAt": "2026-08-08T23:00:00.000Z",
                "windowMinutes": 300
              }
            ],
            "asOf": "2026-08-08T22:00:00.000Z",
            "source": "live"
          }
        ]`,
      );
      const service = yield* AccountLimitsService;
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => [snapshot.instanceId, snapshot.plan])).toEqual([
        ["claudeAgent", "max"],
      ]);
      // Live data for a DIFFERENT instance of the same provider proves the
      // migrated row may belong to somebody else: it is evicted, not kept
      // as a ghost account beside the real one.
      yield* service.ingest({
        provider: "claudeAgent",
        payload: claudeUsagePayload(10, 5),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("claude_partner"),
      });
      const after = yield* service.readSummary();
      expect(after.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["claude_partner"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("instance-keyed rows survive a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-account-limits-reload-",
      });
      yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        yield* service.ingest({
          provider: "codex",
          payload: codexPayload(10),
          createdAt: "2026-08-15T12:00:00.000Z",
          providerInstanceId: asInstanceId("codex_a"),
        });
        yield* service.ingest({
          provider: "codex",
          payload: codexPayload(55),
          createdAt: "2026-08-15T12:00:01.000Z",
          providerInstanceId: asInstanceId("codex_b"),
        });
      }).pipe(Effect.provide(makeLayerAt(baseDir)));
      // A fresh service over the same state dir - the restart.
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(Effect.provide(makeLayerAt(baseDir)));
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual([
        "codex_a",
        "codex_b",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rows for deleted instances are evicted; disabled instances are hidden", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      // codex_gone is not in settings at all; codex_b is disabled for this
      // test's roster below.
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(10),
        createdAt: "2026-08-15T12:00:00.000Z",
        providerInstanceId: asInstanceId("codex_gone"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(20),
        createdAt: "2026-08-15T12:00:01.000Z",
        providerInstanceId: asInstanceId("codex_b"),
      });
      yield* service.ingest({
        provider: "codex",
        payload: codexPayload(30),
        createdAt: "2026-08-15T12:00:02.000Z",
        providerInstanceId: asInstanceId("codex_a"),
      });
      const summary = yield* service.readSummary();
      expect(summary.snapshots.map((snapshot) => snapshot.instanceId)).toEqual(["codex_a"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          providerInstances: {
            [asInstanceId("codex_a")]: {
              driver: asDriver("codex"),
              config: { homePath: "/nonexistent/t3-test-codex-a" },
            },
            [asInstanceId("codex_b")]: {
              driver: asDriver("codex"),
              enabled: false,
              config: { homePath: "/nonexistent/t3-test-codex-b" },
            },
          },
        }),
      ),
    ),
  );
});

// Plain `it`: the seed consults the real clock for its retry floor and
// transcript-recency window, which the suite's virtual test clock (epoch
// 0) would defeat.
it("transcript seeding attributes a sole-owner dir and skips shared or disabled dirs", () =>
  Effect.gen(function* () {
    const soleDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-sole-"));
    const sharedDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-shared-"));
    const disabledDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-disabled-"));
    const grokHomeA = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-a-"));
    const grokHomeB = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-b-"));
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw transcript line.
    const line = JSON.stringify({
      timestamp: "2026-08-15T10:00:00.000Z",
      payload: { rate_limits: codexPayload(37) },
    });
    for (const dir of [soleDir, sharedDir, disabledDir]) {
      NodeFS.mkdirSync(NodePath.join(dir, "sessions"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "sessions", "rollout-1.jsonl"), `${line}\n`);
    }
    // Grok: the CLI's own log line, one per home. The second home's period
    // has already ended - an expired window's percentage is not a reading.
    const grokLine = (percent: number, end: string) =>
      JSON.stringify({
        ts: "2026-08-15T10:00:00.000Z",
        msg: "billing: fetched credits config",
        ctx: {
          config: {
            creditUsagePercent: percent,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end },
          },
          subscriptionTier: "SuperGrok Heavy",
        },
      });
    // @effect-diagnostics-next-line globalDateInEffect:off - a period end in the real clock's future; the reader under test consults the real clock.
    const farEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    NodeFS.mkdirSync(NodePath.join(grokHomeA, "logs"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(grokHomeA, "logs", "unified.jsonl"),
      `${grokLine(58, farEnd)}\n`,
    );
    NodeFS.mkdirSync(NodePath.join(grokHomeB, "logs"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(grokHomeB, "logs", "unified.jsonl"),
      `${grokLine(44, "2026-01-01T00:00:00.000Z")}\n`,
    );
    // A codex instance with no homePath, homed by its environment's
    // CODEX_HOME - the spawned CLI writes there, so the seed must read there.
    const codexEnvHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-envhome-"));
    NodeFS.mkdirSync(NodePath.join(codexEnvHome, "sessions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(codexEnvHome, "sessions", "rollout-1.jsonl"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw transcript line.
      `${JSON.stringify({
        timestamp: "2026-08-15T10:00:00.000Z",
        payload: { rate_limits: codexPayload(29) },
      })}\n`,
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              // Pin the auto-derived default instance away from the real
              // ~/.codex - under the live clock this test's seed actually
              // runs, and it must never read this machine's transcripts.
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("codex_env")]: {
                driver: asDriver("codex"),
                environment: [{ name: "CODEX_HOME", value: codexEnvHome, sensitive: false }],
              },
              [asInstanceId("codex_sole")]: {
                driver: asDriver("codex"),
                config: { homePath: soleDir },
              },
              // Two instances share one home: the dir has no honest owner.
              [asInstanceId("codex_s1")]: {
                driver: asDriver("codex"),
                config: { homePath: sharedDir, shadowHomePath: `${sharedDir}-shadow-1` },
              },
              [asInstanceId("codex_s2")]: {
                driver: asDriver("codex"),
                config: { homePath: sharedDir, shadowHomePath: `${sharedDir}-shadow-2` },
              },
              // Sole owner, but disabled: counted for ownership, never read.
              [asInstanceId("codex_off")]: {
                driver: asDriver("codex"),
                enabled: false,
                config: { homePath: disabledDir },
              },
              // Grok homes come from the instance environment - GrokSettings
              // has no homePath field.
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: grokHomeA, sensitive: false }],
              },
              [asInstanceId("grok_expired")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: grokHomeB, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.provider,
          snapshot.instanceId,
          snapshot.source,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([
        ["codex", "codex_env", "transcript", 29],
        ["codex", "codex_sole", "transcript", 37],
        ["grok", "grok", "transcript", 58],
      ]);
    } finally {
      for (const dir of [soleDir, sharedDir, disabledDir, grokHomeA, grokHomeB, codexEnvHome]) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("finds a grok billing line buried megabytes behind chattier logging", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-deep-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // @effect-diagnostics-next-line globalDateInEffect:off - a period end in the real clock's future; the reader under test consults the real clock.
    const farEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates raw log lines.
    const billing = JSON.stringify({
      ts: "2026-08-15T10:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 63,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: farEnd },
        },
        subscriptionTier: "SuperGrok Heavy",
      },
    });
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates raw log lines.
    const noise = JSON.stringify({
      ts: "2026-08-15T11:00:00.000Z",
      msg: "shell: something chatty",
      ctx: { pad: "x".repeat(400) },
    });
    const logPath = NodePath.join(home, "logs", "unified.jsonl");
    NodeFS.writeFileSync(
      logPath,
      `${billing}\n${Array.from({ length: 3000 }, () => noise).join("\n")}\n`,
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              // Pin the synthesized default codex instance away from the real
              // ~/.codex - the seed runs under the live clock here.
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.windows[0]?.usedPercent]),
      ).toEqual([["grok", 63]]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("refresh pulls every enabled claude and codex instance and ingests per instance", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const summary = yield* Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      return yield* service.refresh();
    }).pipe(
      Effect.provide(
        accountLimitsLayerWith(
          {
            claude: (settings, environment) =>
              Effect.sync(() => {
                pulled.push(`claude:${environment["MARKER"] ?? "none"}`);
                return claudeUsagePayload(11, 7);
              }),
            codex: (_settings, environment) =>
              Effect.sync(() => {
                pulled.push(`codex:${environment["MARKER"] ?? "none"}`);
                return codexPayload(41);
              }),
          },
          {
            providerInstances: {
              // The registry synthesizes default instances from the legacy
              // settings mirror; disabling them keeps this roster exact.
              [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent"), enabled: false },
              [asInstanceId("codex")]: { driver: asDriver("codex"), enabled: false },
              [asInstanceId("grok")]: { driver: asDriver("grok"), enabled: false },
              [asInstanceId("claude_main")]: {
                driver: asDriver("claudeAgent"),
                environment: [{ name: "MARKER", value: "main", sensitive: false }],
              },
              [asInstanceId("claude_off")]: {
                driver: asDriver("claudeAgent"),
                enabled: false,
              },
              [asInstanceId("codex_a")]: {
                driver: asDriver("codex"),
                environment: [{ name: "MARKER", value: "a", sensitive: false }],
                config: { homePath: "/nonexistent/t3-test-codex-a" },
              },
            },
          },
        ),
      ),
    );
    // Disabled instances are never pulled; each pull ingests under its own
    // instance id with the refresh moment as asOf.
    expect(pulled.sort()).toEqual(["claude:main", "codex:a"]);
    expect(
      summary.snapshots.map((snapshot) => [
        snapshot.provider,
        snapshot.instanceId,
        snapshot.source,
        snapshot.windows[0]?.usedPercent,
      ]),
    ).toEqual([
      ["claude", "claude_main", "live", 11],
      ["codex", "codex_a", "live", 41],
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("refresh boots the grok TUI so the log gains a fresh line - and grok reads just-now too", () =>
  Effect.gen(function* () {
    const startedAtMs = yield* Clock.currentTimeMillis;
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-boot-"));
    const home = NodePath.join(dir, "grok-home");
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // A fake grok TUI: booting it writes a current billing line, exactly
    // like the real one's billing extension does at startup.
    const fakeGrok = NodePath.join(dir, "grok");
    NodeFS.writeFileSync(
      fakeGrok,
      [
        "#!/bin/sh",
        "ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
        `printf '{"ts":"'"$ts"'","msg":"billing: fetched credits config","ctx":{"config":{"creditUsagePercent":52,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"'"$(date -u -d @$(($(date +%s) + 86400)) +%Y-%m-%dT%H:%M:%S.000Z)"'"}},"subscriptionTier":"SuperGrok Heavy"}}\n' >> "$GROK_HOME/logs/unified.jsonl"`,
        "sleep 30",
        "",
      ].join("\n"),
    );
    NodeFS.chmodSync(fakeGrok, 0o755);
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        const first = yield* service.refresh();
        // A second click inside the freshness window must not boot again.
        yield* service.refresh();
        return first;
      }).pipe(
        Effect.provide(
          accountLimitsLayerWith(
            {
              claude: () => Effect.succeed(null),
              codex: () => Effect.succeed(null),
            },
            {
              providerInstances: {
                [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent"), enabled: false },
                [asInstanceId("codex")]: { driver: asDriver("codex"), enabled: false },
                [asInstanceId("grok")]: {
                  driver: asDriver("grok"),
                  config: { binaryPath: fakeGrok },
                  environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
                },
              },
            },
          ),
        ),
      );
      const grokRow = summary.snapshots.find((snapshot) => snapshot.provider === "grok");
      expect(grokRow?.windows[0]?.usedPercent).toBe(52);
      // The reading was fetched by the boot, not replayed from an old line.
      expect(Date.parse(grokRow?.asOf ?? "")).toBeGreaterThanOrEqual(startedAtMs - 1000);
      const logLines = NodeFS.readFileSync(NodePath.join(home, "logs", "unified.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(logLines).toHaveLength(1);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("resolves the default grok home the way the spawned CLI does - ambient GROK_HOME wins", () =>
  Effect.gen(function* () {
    const ambient = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-ambient-"));
    NodeFS.mkdirSync(NodePath.join(ambient, "logs"), { recursive: true });
    // @effect-diagnostics-next-line globalDateInEffect:off - a period end in the real clock's future; the reader under test consults the real clock.
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw log line.
    const line = JSON.stringify({
      ts: "2026-08-15T10:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 41,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end },
        },
      },
    });
    NodeFS.writeFileSync(NodePath.join(ambient, "logs", "unified.jsonl"), `${line}\n`);
    const previous = process.env["GROK_HOME"];
    process.env["GROK_HOME"] = ambient;
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              // The default grok instance: no instance-level GROK_HOME. Its
              // CLI inherits the ambient value, so the seed must read there.
              [asInstanceId("grok")]: { driver: asDriver("grok") },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.windows[0]?.usedPercent]),
      ).toEqual([["grok", 41]]);
    } finally {
      if (previous === undefined) delete process.env["GROK_HOME"];
      else process.env["GROK_HOME"] = previous;
      NodeFS.rmSync(ambient, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("evicts a cached grok row once its period has ended instead of resurrecting it", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-stale-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw log line.
    const expiredLine = JSON.stringify({
      ts: "2026-01-01T10:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 63,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-01-05T00:00:00.000Z" },
        },
      },
    });
    NodeFS.writeFileSync(NodePath.join(home, "logs", "unified.jsonl"), `${expiredLine}\n`);
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-stale-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    // The persisted row a past seed wrote while the period was still live.
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "grok",
          instanceId: "grok",
          plan: "SuperGrok Heavy",
          windows: [
            {
              id: "seven_day",
              label: "Week",
              usedPercent: 63,
              resetsAt: "2026-01-05T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-01-01T10:00:00.000Z",
          source: "transcript",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(summary.snapshots).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("stops at the newest billing record - an unmetered seat must not show an older paid reading", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-unmetered-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // @effect-diagnostics-next-line globalDateInEffect:off - a period end in the real clock's future; the reader under test consults the real clock.
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates raw log lines.
    const paid = JSON.stringify({
      ts: "2026-08-15T09:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 63,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end },
        },
      },
    });
    // The newest record carries no percentage - the shape an unmetered seat
    // (or a reshaped payload) produces.
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates raw log lines.
    const unmetered = JSON.stringify({
      ts: "2026-08-15T10:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: { config: { onDemandCap: { val: 0 } } },
    });
    NodeFS.writeFileSync(NodePath.join(home, "logs", "unified.jsonl"), `${paid}\n${unmetered}\n`);
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(summary.snapshots).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("uses a materialized sensitive GROK_HOME and lets an empty one contest the default dir", () =>
  Effect.gen(function* () {
    const secretHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-secret-"));
    const ambientHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-amb2-"));
    // @effect-diagnostics-next-line globalDateInEffect:off - a period end in the real clock's future; the reader under test consults the real clock.
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const write = (home: string, percent: number) => {
      NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, "logs", "unified.jsonl"),
        `${JSON.stringify({
          ts: "2026-08-15T10:00:00.000Z",
          msg: "billing: fetched credits config",
          ctx: {
            config: {
              creditUsagePercent: percent,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end },
            },
          },
        })}\n`,
      );
    };
    write(secretHome, 22);
    write(ambientHome, 77);
    const previous = process.env["GROK_HOME"];
    process.env["GROK_HOME"] = ambientHome;
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayer({
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              // getSettings materializes sensitive values before this code
              // runs, so a flagged-redacted value that is present is usable.
              [asInstanceId("grok_secret")]: {
                driver: asDriver("grok"),
                environment: [
                  { name: "GROK_HOME", value: secretHome, sensitive: true, valueRedacted: true },
                ],
              },
              // An empty value falls back to the ambient default - and must
              // therefore CONTEST the default dir, not vanish: otherwise the
              // default instance would be handed sole ownership of shared data.
              [asInstanceId("grok")]: { driver: asDriver("grok") },
              [asInstanceId("grok_blank")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: "", sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.instanceId,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([["grok_secret", 22]]);
    } finally {
      if (previous === undefined) delete process.env["GROK_HOME"];
      else process.env["GROK_HOME"] = previous;
      NodeFS.rmSync(secretHome, { recursive: true, force: true });
      NodeFS.rmSync(ambientHome, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("a newer unmetered line evicts the cached paid reading it supersedes", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-superseded-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // The newest record parses but carries no percent window: the seat went
    // unmetered. The cached paid reading it supersedes must not keep serving.
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw log line.
    const unmeteredLine = JSON.stringify({
      ts: "2026-01-02T00:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: { config: {} },
    });
    NodeFS.writeFileSync(NodePath.join(home, "logs", "unified.jsonl"), `${unmeteredLine}\n`);
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-superseded-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "grok",
          instanceId: "grok",
          plan: "SuperGrok Heavy",
          windows: [
            {
              id: "seven_day",
              label: "Week",
              usedPercent: 63,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-01-01T10:00:00.000Z",
          source: "transcript",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(summary.snapshots).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("a log with no billing record keeps the cache - rotation must not wipe rows", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-rotated-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // A freshly rotated log: chatter only, no billing record anywhere.
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates raw log lines.
    const chatter = JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", msg: "session: started" });
    NodeFS.writeFileSync(NodePath.join(home, "logs", "unified.jsonl"), `${chatter}\n${chatter}\n`);
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-rotated-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "grok",
          instanceId: "grok",
          plan: "SuperGrok Heavy",
          windows: [
            {
              id: "seven_day",
              label: "Week",
              usedPercent: 63,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-01-01T10:00:00.000Z",
          source: "transcript",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.windows[0]?.usedPercent]),
      ).toEqual([["grok", 63]]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("a streamed traffic-less window cannot resurface what full snapshots suppress", () =>
  Effect.gen(function* () {
    const summary = yield* Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: asDriver("claudeAgent"),
        payload: claudeUsagePayload(11, 7),
        createdAt: "2026-08-15T10:00:00.000Z",
        providerInstanceId: asInstanceId("claude_main"),
      });
      // The vendor now reports five_hour as untouched: 0% and no reset
      // clock. The patch must apply the same traffic filter full snapshots
      // do - not park a permanent bare 0% row on the card.
      yield* service.ingest({
        provider: asDriver("claudeAgent"),
        payload: {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0 },
        },
        createdAt: "2026-08-15T10:05:00.000Z",
        providerInstanceId: asInstanceId("claude_main"),
      });
      return yield* service.readSummary();
    }).pipe(
      Effect.provide(
        makeLayer({
          providerInstances: {
            [asInstanceId("codex")]: {
              driver: asDriver("codex"),
              config: { homePath: "/nonexistent/t3-test-codex-default" },
            },
            [asInstanceId("grok")]: { driver: asDriver("grok"), enabled: false },
            [asInstanceId("claude_main")]: { driver: asDriver("claudeAgent") },
          },
        }),
      ),
    );
    const claudeRow = summary.snapshots.find((snapshot) => snapshot.provider === "claude");
    expect(claudeRow?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["seven_day", 7],
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("a stale expired verdict does not delete a newer live reading", () =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-seed-grok-race-"));
    NodeFS.mkdirSync(NodePath.join(home, "logs"), { recursive: true });
    // The log's newest line is an OLD expired reading; the cache already
    // holds a newer live-period one (the refresh-boot race, replayed flat).
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates one raw log line.
    const expiredLine = JSON.stringify({
      ts: "2026-01-01T10:00:00.000Z",
      msg: "billing: fetched credits config",
      ctx: {
        config: {
          creditUsagePercent: 63,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-01-05T00:00:00.000Z" },
        },
      },
    });
    NodeFS.writeFileSync(NodePath.join(home, "logs", "unified.jsonl"), `${expiredLine}\n`);
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-race-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "grok",
          instanceId: "grok",
          plan: "SuperGrok Heavy",
          windows: [
            {
              id: "seven_day",
              label: "Week",
              usedPercent: 41,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-01-02T00:00:00.000Z",
          source: "transcript",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(
        summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.windows[0]?.usedPercent]),
      ).toEqual([["grok", 41]]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("evicts a row whose instance now runs a different driver", () =>
  Effect.gen(function* () {
    const emptyHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-empty-"));
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-flip-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    // A codex row cached while "personal" ran codex; the instance has since
    // been reconfigured to grok, so the row's account no longer exists here.
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "account-limits.json"),
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "codex",
          instanceId: "personal",
          plan: "pro",
          windows: [
            {
              id: "codex",
              label: "Week",
              usedPercent: 45,
              resetsAt: "2099-01-01T00:00:00.000Z",
              windowMinutes: 10080,
            },
          ],
          asOf: "2026-08-15T10:00:00.000Z",
          source: "live",
        },
      ]),
    );
    try {
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(
        Effect.provide(
          makeLayerAt(baseDir, {
            providerInstances: {
              [asInstanceId("codex")]: {
                driver: asDriver("codex"),
                config: { homePath: "/nonexistent/t3-test-codex-default" },
              },
              [asInstanceId("grok")]: { driver: asDriver("grok"), enabled: false },
              [asInstanceId("personal")]: {
                driver: asDriver("grok"),
                environment: [{ name: "GROK_HOME", value: emptyHome, sensitive: false }],
              },
            },
          }),
        ),
      );
      expect(summary.snapshots).toEqual([]);
    } finally {
      NodeFS.rmSync(emptyHome, { recursive: true, force: true });
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("an unconfirmed migrated row keeps its v1 shape across restarts - the ghost eviction survives", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-limits-restart-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    const cachePath = NodePath.join(baseDir, "userdata", "account-limits.json");
    // A v1 cache: one claude row, no instanceId.
    NodeFS.writeFileSync(
      cachePath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fabricates the raw cache file.
      JSON.stringify([
        {
          provider: "claude",
          plan: "max",
          windows: [
            {
              id: "five_hour",
              label: "5h",
              usedPercent: 12,
              resetsAt: "2026-08-08T23:00:00.000Z",
              windowMinutes: 300,
            },
          ],
          asOf: "2026-08-01T00:00:00.000Z",
          source: "live",
        },
      ]),
    );
    const roster = {
      providerInstances: {
        [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent") },
        [asInstanceId("claude_partner")]: { driver: asDriver("claudeAgent") },
        [asInstanceId("codex")]: {
          driver: asDriver("codex"),
          config: { homePath: "/nonexistent/t3-test-codex-default" },
        },
        [asInstanceId("grok")]: { driver: asDriver("grok"), enabled: false },
      },
    };
    try {
      // First run: an UNRELATED codex ingest persists the cache. The migrated
      // claude row must be written back in its v1 shape, still unconfirmed.
      yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        yield* service.readSummary();
        yield* service.ingest({
          provider: asDriver("codex"),
          payload: codexPayload(41),
          createdAt: "2026-08-15T09:00:00.000Z",
          providerInstanceId: asInstanceId("codex"),
        });
      }).pipe(Effect.provide(makeLayerAt(baseDir, roster)));
      // @effect-diagnostics-next-line preferSchemaOverJson:off - reads the raw cache file back.
      const persisted = JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as {
        provider: string;
        instanceId?: string;
      }[];
      expect(
        persisted.map((row) => [row.provider, "instanceId" in row ? row.instanceId : "(none)"]),
      ).toEqual([
        ["claude", "(none)"],
        ["codex", "codex"],
      ]);
      // Second run - a restart. Live claude data on ANOTHER instance must
      // still evict the migrated default row instead of leaving a ghost.
      const summary = yield* Effect.gen(function* () {
        const service = yield* AccountLimitsService;
        yield* service.ingest({
          provider: asDriver("claudeAgent"),
          payload: claudeUsagePayload(31, 9),
          createdAt: "2026-08-15T10:00:00.000Z",
          providerInstanceId: asInstanceId("claude_partner"),
        });
        return yield* service.readSummary();
      }).pipe(Effect.provide(makeLayerAt(baseDir, roster)));
      expect(summary.snapshots.map((snapshot) => [snapshot.provider, snapshot.instanceId])).toEqual(
        [
          ["claude", "claude_partner"],
          ["codex", "codex"],
        ],
      );
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

it("concurrent refreshes share one execution, stamped at completion", () =>
  Effect.gen(function* () {
    let claudePulls = 0;
    const t0 = yield* Clock.currentTimeMillis;
    const summaries = yield* Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      return yield* Effect.all([service.refresh(), service.refresh()], { concurrency: 2 });
    }).pipe(
      Effect.provide(
        accountLimitsLayerWith(
          {
            claude: () =>
              Effect.gen(function* () {
                claudePulls++;
                // Long enough that a start-time stamp is measurably wrong.
                yield* Effect.sleep(150);
                return claudeUsagePayload(11, 7);
              }),
            codex: () => Effect.succeed(null),
          },
          {
            providerInstances: {
              [asInstanceId("claudeAgent")]: { driver: asDriver("claudeAgent"), enabled: false },
              [asInstanceId("codex")]: { driver: asDriver("codex"), enabled: false },
              [asInstanceId("grok")]: { driver: asDriver("grok"), enabled: false },
              [asInstanceId("claude_main")]: { driver: asDriver("claudeAgent") },
            },
          },
        ),
      ),
    );
    // Two simultaneous clicks, one pull - and both callers got the result.
    expect(claudePulls).toBe(1);
    expect(summaries).toHaveLength(2);
    const row = summaries[0]?.snapshots.find((snapshot) => snapshot.provider === "claude");
    // Completion-stamped: at least the pull's own duration after the start.
    expect(Date.parse(row?.asOf ?? "")).toBeGreaterThanOrEqual(t0 + 100);
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

describe("planLimitsSeeds", () => {
  const target = (instanceId: string, sourceDir: string, enabled = true): LimitsSeedTarget => ({
    provider: "codex",
    instanceId: asInstanceId(instanceId),
    sourceDir,
    enabled,
  });

  it("keeps sole-owner sessions dirs and attributes them to their instance", () => {
    expect(planLimitsSeeds([target("codex", "/home/user/.codex/sessions")])).toEqual([
      target("codex", "/home/user/.codex/sessions"),
    ]);
  });

  it("skips a dir that several instances write - no honest attribution exists", () => {
    // The reported setup: three instances share one homePath (shadow homes
    // symlink sessions/ back to it) - seeding any of them invents data.
    expect(
      planLimitsSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_b", "/home/user/.codex/sessions"),
        target("codex_c", "/home/user/.codex/sessions"),
      ]),
    ).toEqual([]);
  });

  it("counts disabled instances as owners - their transcripts share the dir", () => {
    expect(
      planLimitsSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_off", "/home/user/.codex/sessions", false),
      ]),
    ).toEqual([]);
  });

  it("plans independent dirs independently", () => {
    expect(
      planLimitsSeeds([
        target("codex_a", "/home/user/.codex/sessions"),
        target("codex_b", "/home/user/.codex/sessions"),
        target("codex_work", "/home/user/.codex-work/sessions"),
      ]),
    ).toEqual([target("codex_work", "/home/user/.codex-work/sessions")]);
  });
});
