/**
 * AccountLimitsService - the server-wide account rate-limit cache.
 *
 * Fed passively: runtime ingestion forwards every
 * `account.rate-limits.updated` event here (Claude usage snapshots and
 * single-window events, Codex app-server notifications), so the cache costs
 * nothing while sessions run. When asked and Codex has no live snapshot, the
 * newest transcript snapshot is recovered from disk. Claude has no disk
 * fallback: its limits exist only on the live stream, which is why snapshots
 * are persisted across restarts.
 *
 * One snapshot per (provider, instance). Limits belong to provider
 * *accounts*, and the instance is the closest identity every event already
 * carries: with several instances configured (work + personal accounts, the
 * documented multi-account setup), a single per-provider slot makes the
 * accounts overwrite and suppress each other. Two instances logged into the
 * same account simply show the same numbers - honest, and free of credential
 * reads on the event path. Cache rows that predate instance attribution load
 * under the driver's default instance id, which is what the old single-slot
 * world semantically was - see `migratedSlots` for how long that lasts.
 *
 * @module AccountLimitsService
 */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  type AccountLimitsProviderKind,
  AccountLimitsSnapshot,
  type AccountLimitsSummary,
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  claudeUsageSnapshotFromUnknown,
  claudeWindowFromRateLimitEvent,
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
  sortWindows,
} from "./accountLimitsNormalize.ts";
import { pullClaudeLimits, pullCodexLimits, pullGrokBillingRefresh } from "./accountLimitsPull.ts";
import { readLatestCodexRateLimits, readLatestGrokCredits } from "./accountLimitsTranscripts.ts";

/** Failed or empty transcript scans are not retried more often than this. */
const CODEX_SEED_MIN_INTERVAL_MS = 60_000;
/** A grok log line younger than this needs no TUI boot on refresh. */
const GROK_BOOT_FRESH_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** On-disk shape of the snapshot cache: the contract array, JSON-encoded. */
const LimitsCacheFile = Schema.Array(AccountLimitsSnapshot);
const decodeLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const encodeLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

export interface AccountLimitsIngestInput {
  /** Driver kind off the runtime event (`claudeAgent`, `codex`, ...). */
  readonly provider: string;
  /** The event's `payload.rateLimits`, in whatever shape the adapter emitted. */
  readonly payload: unknown;
  readonly createdAt: string;
  /**
   * Instance routing key off the event envelope. Optional during the
   * driver/instance migration; an absent value means the driver's default
   * instance, exactly like the envelope field it mirrors.
   */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export class AccountLimitsService extends Context.Service<
  AccountLimitsService,
  {
    readonly readSummary: () => Effect.Effect<AccountLimitsSummary>;
    readonly ingest: (input: AccountLimitsIngestInput) => Effect.Effect<void>;
    /**
     * Pull fresh limits from every provider that has a query surface, run
     * the vendor-file pass unthrottled, and return the resulting summary -
     * the server side of the panel's refresh button.
     */
    readonly refresh: () => Effect.Effect<AccountLimitsSummary>;
  }
>()("t3/usage/AccountLimitsService") {}

/**
 * Per-provider live pullers, injectable so tests exercise the refresh
 * plumbing without vendor binaries. Requirements are closed: `make` wires
 * the spawner into the codex default.
 */
export interface AccountLimitsPullers {
  readonly claude: (
    settings: ClaudeSettings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<unknown>;
  readonly codex: (
    settings: CodexSettings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) => Effect.Effect<unknown>;
  /** Boots the grok TUI so its own billing fetch lands in the log. */
  readonly grok: (
    binaryPath: string,
    home: string,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<void>;
}

/** Empty cache, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  AccountLimitsService,
  AccountLimitsService.of({
    readSummary: () =>
      Effect.succeed({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        snapshots: [],
      }),
    ingest: () => Effect.void,
    refresh: () =>
      Effect.succeed({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        snapshots: [],
      }),
  }),
);

/**
 * Drivers whose adapters emit `account.rate-limits.updated`. Grok is
 * deliberately absent: its adapter speaks ACP, which carries no rate-limit
 * events - grok snapshots enter exclusively through the log seed below.
 */
function providerFromDriver(driver: string): AccountLimitsProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return null;
}

/**
 * The instance that owns data carrying no instance id: legacy emitters and
 * v1 cache rows. The legacy single-instance world used the driver kind
 * itself as the instance id (see `defaultInstanceIdForDriver`), so this is
 * not a guess - it is what that data always meant.
 */
function defaultInstanceIdForProvider(provider: AccountLimitsProviderKind): ProviderInstanceId {
  return defaultInstanceIdForDriver(
    ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : provider),
  );
}

/**
 * Map key for one (provider, instance) slot. Structured, not interpolated:
 * no spelling of an instance id can collide with another slot's key.
 */
function slotKey(provider: AccountLimitsProviderKind, instanceId: ProviderInstanceId): string {
  return JSON.stringify([provider, instanceId]);
}

/** One instance's resolved on-disk source of vendor-written limit data. */
export interface LimitsSeedTarget {
  readonly provider: AccountLimitsProviderKind;
  readonly instanceId: ProviderInstanceId;
  /** Codex: the shared `sessions/` dir. Grok: the CLI's `logs/` dir. */
  readonly sourceDir: string;
  /**
   * Disabled instances still own their files - their sessions share the dir
   * whether or not the instance currently runs - so they count for
   * ambiguity, and only enabled sole owners are actually seeded.
   */
  readonly enabled: boolean;
}

/**
 * Sole-owner sessions dirs only. Shadow homes share `sessions/` with the
 * home they overlay (see CodexHomeLayout), and a transcript names no
 * account - so a directory that several instances write cannot be
 * attributed honestly, and seeding it into any one of them invents data
 * (seeding it into all of them invents more). Those dirs are skipped: live
 * events still meter every instance; the transcripts just stop pretending
 * to know whose usage they hold. Pure and exported for tests.
 */
export function planLimitsSeeds(targets: readonly LimitsSeedTarget[]): readonly LimitsSeedTarget[] {
  const byDir = new Map<string, readonly LimitsSeedTarget[]>();
  for (const target of targets) {
    byDir.set(target.sourceDir, [...(byDir.get(target.sourceDir) ?? []), target]);
  }
  return [...byDir.values()].flatMap((owners) => (owners.length === 1 ? owners : []));
}

export const make = (pullers?: Partial<AccountLimitsPullers>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pull: AccountLimitsPullers = {
      claude:
        pullers?.claude ??
        ((settings, environment) =>
          pullClaudeLimits(settings, environment).pipe(Effect.provideService(Path.Path, path))),
      codex:
        pullers?.codex ??
        ((settings, environment, cwd) =>
          pullCodexLimits(settings, environment, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )),
      grok:
        pullers?.grok ??
        ((binaryPath, home, environment) =>
          pullGrokBillingRefresh(binaryPath, home, environment).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )),
    };

    const snapshots = new Map<string, AccountLimitsSnapshot>();
    /**
     * Slot keys holding rows migrated from the v1 single-slot cache. A v1 row
     * was "whichever account wrote last", not "the default instance" - the
     * default id is only the least-wrong home for it. The first live event
     * proves the point either way: landing on the default slot confirms the
     * row, landing on any other instance of the same provider proves the
     * migrated row may belong to somebody else, so it is evicted rather than
     * shown as a ghost account forever.
     */
    const migratedSlots = new Set<string>();
    const cachePath = path.join(config.stateDir, "account-limits.json");
    let lastCodexSeedAttemptAtMs = 0;

    // Restarts must not lose the Claude snapshot (stream-only, no disk source),
    // so the cache is persisted. Same Effect.cached trick as the usage scan
    // cache: concurrent first readers await one load.
    const ensureLoaded = yield* Effect.cached(
      Effect.gen(function* () {
        const stored = yield* fileSystem.readFileString(cachePath).pipe(
          Effect.flatMap((raw) => decodeLimitsCache(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (stored === null) return;
        for (const snapshot of stored) {
          // Rows written before instance attribution migrate to the default
          // instance rather than being discarded: Claude has no disk source,
          // so a wiped cache is an empty Limits strip until a session runs.
          const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
          const key = slotKey(snapshot.provider, instanceId);
          if (!snapshots.has(key)) {
            snapshots.set(key, { ...snapshot, instanceId });
            if (snapshot.instanceId === undefined) migratedSlots.add(key);
          }
        }
      }),
    );

    /**
     * All snapshot mutations - event ingest (worker fiber), the transcript
     * seed and instance eviction (RPC fiber) - run under this one permit, so
     * each ordering guard, map write, and persist is atomic with respect to
     * the others. Without it a concurrent pair can both pass their guard
     * against the same prior snapshot and land in either order, rolling the
     * state backwards. Reads stay lock-free.
     */
    const stateLock = yield* Semaphore.make(1);

    // A cache we cannot write is a colder next start, not a failure. Only
    // called while holding `stateLock`, which is what serializes writes; the
    // temp-file + rename keeps a crashed write from tearing the file.
    /**
     * Compare filesystem identity, not spellings: a symlinked home and its
     * target are one directory, and treating them as two would hand the same
     * account-ambiguous files to both.
     */
    const canonicalDir = (dir: string) =>
      fileSystem.realPath(dir).pipe(Effect.catchCause(() => Effect.succeed(dir)));

    const persist = Effect.fn("AccountLimitsService.persist")(function* () {
      yield* encodeLimitsCache([...snapshots.values()]).pipe(
        Effect.flatMap((serialized) =>
          writeFileStringAtomically({ filePath: cachePath, contents: serialized }),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchCause(() => Effect.void),
      );
    });

    const store = Effect.fn("AccountLimitsService.store")(function* (
      snapshot: AccountLimitsSnapshot & { readonly instanceId: ProviderInstanceId },
    ) {
      const key = slotKey(snapshot.provider, snapshot.instanceId);
      snapshots.set(key, snapshot);
      // Live data on a slot settles what that slot is; live data on any OTHER
      // instance of the provider evicts a still-unconfirmed migrated row (see
      // `migratedSlots`).
      migratedSlots.delete(key);
      const defaultKey = slotKey(
        snapshot.provider,
        defaultInstanceIdForProvider(snapshot.provider),
      );
      if (key !== defaultKey && migratedSlots.has(defaultKey)) {
        snapshots.delete(defaultKey);
        migratedSlots.delete(defaultKey);
      }
      yield* persist();
    });

    const ingestClaude = Effect.fn("AccountLimitsService.ingestClaude")(function* (
      payload: unknown,
      createdAt: string,
      instanceId: ProviderInstanceId,
    ) {
      const previous = snapshots.get(slotKey("claude", instanceId));
      const full = claudeUsageSnapshotFromUnknown(payload);
      if (full !== null) {
        // Rate limits do not apply to this account (API key / Bedrock / Vertex):
        // nothing to show, and nothing worth clearing a previous snapshot over.
        if (full.windows.length === 0) return;
        yield* store({
          provider: "claude",
          instanceId,
          plan: full.plan ?? previous?.plan ?? null,
          windows: full.windows,
          asOf: createdAt,
          source: "live",
        });
        return;
      }
      // The streamed event names one window; patch it into whatever set the
      // last full snapshot from the same instance established.
      const window = claudeWindowFromRateLimitEvent(payload);
      if (window === null) return;
      const windows = sortWindows([
        ...(previous?.windows ?? []).filter((existing) => existing.id !== window.id),
        window,
      ]);
      yield* store({
        provider: "claude",
        instanceId,
        plan: previous?.plan ?? null,
        windows,
        asOf: createdAt,
        source: "live",
      });
    });

    const ingestCodex = Effect.fn("AccountLimitsService.ingestCodex")(function* (
      payload: unknown,
      createdAt: string,
      instanceId: ProviderInstanceId,
    ) {
      const snapshot = codexSnapshotFromUnknown(payload);
      if (snapshot === null) return;
      // Per-model side meters (Spark) are not surfaced.
      if (!isPrimaryCodexLimit(snapshot.limitId)) return;
      if (snapshot.windows.length === 0) return;
      const previous = snapshots.get(slotKey("codex", instanceId));
      yield* store({
        provider: "codex",
        instanceId,
        plan: snapshot.plan ?? previous?.plan ?? null,
        windows: snapshot.windows,
        asOf: createdAt,
        source: "live",
      });
    });

    const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
      input: AccountLimitsIngestInput,
    ) {
      const provider = providerFromDriver(input.provider);
      if (provider === null) return;
      const instanceId = input.providerInstanceId ?? defaultInstanceIdForProvider(provider);
      yield* ensureLoaded;
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          // Guard against out-of-order delivery: an event older than what is
          // already stored must not roll the snapshot backwards. Per slot -
          // one instance's traffic must not suppress another's.
          const existing = snapshots.get(slotKey(provider, instanceId));
          if (existing !== undefined && input.createdAt < existing.asOf) return;
          if (provider === "claude") {
            yield* ingestClaude(input.payload, input.createdAt, instanceId);
          } else {
            yield* ingestCodex(input.payload, input.createdAt, instanceId);
          }
        }),
      );
    });

    /**
     * Recovers Codex snapshots from session transcripts when they are newer
     * than what the cache holds - which covers both a cold cache and Codex
     * sessions driven outside T3 Code. Instances are enumerated the same way
     * the registry derives them, so the legacy single-instance mirror is
     * included; only sessions dirs owned by exactly one instance are read
     * (see `planCodexTranscriptSeeds`).
     */
    /**
     * The default GROK_HOME, resolved the way the spawned CLI resolves it:
     * the driver builds the child env starting from process.env, so an
     * ambient GROK_HOME redirects the default instance's CLI - and this seed
     * must read where that CLI actually writes, not ~/.grok unconditionally.
     */
    const defaultGrokHome = () => expandHomePath(process.env["GROK_HOME"]?.trim() || "~/.grok");

    /**
     * A grok instance's home. `getSettings` has already materialized sensitive
     * environment values, so a present value is usable whether or not it is
     * flagged redacted. An EMPTY value cannot name a home - the instance's CLI
     * would fall back to the ambient default - so it contests the default dir
     * rather than minting a unique fake one, which would falsely hand the
     * default instance sole ownership of data these instances share.
     */
    const grokHomeFor = (entry: ProviderInstanceConfig): string => {
      const override = entry.environment?.find((variable) => variable.name === "GROK_HOME");
      const value = override?.value.trim() ?? "";
      return value === "" ? defaultGrokHome() : expandHomePath(value);
    };

    /**
     * Recovers snapshots from what the vendor CLIs already write to disk,
     * covering both a cold cache and sessions driven outside T3 Code: Codex
     * stores its rate-limit snapshot beside every token count in its session
     * transcripts, and the Grok CLI logs its fetched subscription window
     * (grok's adapter speaks ACP, which has no rate-limit events, so this is
     * grok's only source). Instances are enumerated the way the registry
     * derives them, so the legacy single-instance mirrors are included; only
     * dirs owned by exactly one instance are read (see `planLimitsSeeds`).
     */
    const maybeSeedFromVendorFiles = Effect.fn("AccountLimitsService.seedVendorFiles")(function* (
      nowMs: number,
      configMap: ProviderInstanceConfigMap | null,
    ) {
      if (configMap === null) return;
      if (nowMs - lastCodexSeedAttemptAtMs < CODEX_SEED_MIN_INTERVAL_MS) return;
      lastCodexSeedAttemptAtMs = nowMs;

      const targets: LimitsSeedTarget[] = [];
      for (const [rawInstanceId, entry] of Object.entries(configMap)) {
        if (entry.driver === "codex") {
          const codexSettings = yield* decodeCodexSettings(entry.config ?? {}).pipe(
            Effect.catchCause(() => Effect.succeed(null)),
          );
          if (codexSettings === null) continue;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          targets.push({
            provider: "codex",
            instanceId: ProviderInstanceId.make(rawInstanceId),
            sourceDir: yield* canonicalDir(path.join(layout.sharedHomePath, "sessions")),
            enabled: entry.enabled !== false,
          });
        } else if (entry.driver === "grok") {
          targets.push({
            provider: "grok",
            instanceId: ProviderInstanceId.make(rawInstanceId),
            sourceDir: yield* canonicalDir(path.join(grokHomeFor(entry), "logs")),
            enabled: entry.enabled !== false,
          });
        }
      }

      for (const target of planLimitsSeeds(targets)) {
        if (!target.enabled) continue;
        let found;
        if (target.provider === "grok") {
          const read = yield* Effect.promise(() =>
            readLatestGrokCredits(path.join(target.sourceDir, "unified.jsonl"), nowMs),
          );
          if (read._tag === "expired") {
            // The newest billing record's period has ended: whatever the cache
            // holds for this instance belongs to a window that no longer
            // exists, and keeping it would show a dead percentage "resetting
            // now" forever.
            yield* stateLock.withPermits(1)(
              Effect.gen(function* () {
                if (snapshots.delete(slotKey("grok", target.instanceId))) yield* persist();
              }),
            );
            continue;
          }
          if (read._tag === "none") continue;
          found = read.credits;
        } else {
          found = yield* Effect.promise(() => readLatestCodexRateLimits(target.sourceDir, nowMs));
        }
        if (found === null) continue;
        if (found.snapshot.windows.length === 0) continue;
        const asOf = DateTime.formatIso(DateTime.makeUnsafe(found.asOfMs));
        // The slow file reads happened outside the lock; only the
        // guard-and-store is serialized against live ingests.
        yield* stateLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = snapshots.get(slotKey(target.provider, target.instanceId));
            // ISO-8601 strings order lexicographically.
            if (existing !== undefined && existing.asOf >= asOf) return;
            yield* store({
              provider: target.provider,
              instanceId: target.instanceId,
              plan: found.snapshot.plan ?? existing?.plan ?? null,
              windows: found.snapshot.windows,
              asOf,
              source: "transcript",
            });
          }),
        );
      }
    });

    const readSummary = Effect.fn("AccountLimitsService.readSummary")(function* () {
      yield* ensureLoaded;
      const nowMs = yield* Clock.currentTimeMillis;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const configMap = settings === null ? null : deriveProviderInstanceConfigMap(settings);
      yield* maybeSeedFromVendorFiles(nowMs, configMap).pipe(Effect.catchCause(() => Effect.void));
      // A deleted instance takes its rows with it - anything else leaves a
      // ghost account forcing the captioned multi-row UI forever. A merely
      // disabled instance keeps its cache (re-enabling restores it) but stays
      // out of the summary. Default instances always derive, so single-account
      // setups are untouched by either rule.
      if (configMap !== null) {
        yield* stateLock.withPermits(1)(
          Effect.gen(function* () {
            let evicted = false;
            for (const [key, snapshot] of snapshots) {
              const instanceId =
                snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
              if (configMap[instanceId] === undefined) {
                snapshots.delete(key);
                migratedSlots.delete(key);
                evicted = true;
                continue;
              }
              // Grok readings die with their period (the seed rejects expired
              // lines for the same reason); a cached row can outlive its window
              // when the log rotates or its dir turns ambiguous, and serving it
              // would show a dead percentage "resetting now" forever.
              if (
                snapshot.provider === "grok" &&
                snapshot.windows.length > 0 &&
                snapshot.windows.every((window) => {
                  const end = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
                  return Number.isFinite(end) && end < nowMs;
                })
              ) {
                snapshots.delete(key);
                evicted = true;
              }
            }
            if (evicted) yield* persist();
          }),
        );
      }
      const visible = [...snapshots.values()].filter((snapshot) => {
        if (configMap === null) return true;
        const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
        return configMap[instanceId]?.enabled !== false;
      });
      return {
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        // Codepoint order, not localeCompare: instance ids are user-authored
        // slugs and the summary's order must not change with the host locale.
        snapshots: visible.sort((a, b) => {
          const left = `${a.provider} ${a.instanceId ?? ""}`;
          const right = `${b.provider} ${b.instanceId ?? ""}`;
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      } satisfies AccountLimitsSummary;
    });

    /**
     * The refresh button's contract: every provider with a query surface is
     * asked NOW (Claude via its SDK usage request, Codex via
     * account/rateLimits/read), the vendor-file pass runs unthrottled (Grok's
     * log, Codex transcripts), and the summary reflects all of it. Cursor and
     * OpenCode have no rate-limit surface to ask - the explicit per-adapter
     * decision is "not supported here". A failed pull skips; refresh must
     * never break the panel it refreshes.
     */
    const refresh = Effect.fn("AccountLimitsService.refresh")(function* () {
      yield* ensureLoaded;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      const configMap = settings === null ? null : deriveProviderInstanceConfigMap(settings);
      if (configMap !== null) {
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const jobs: Effect.Effect<void>[] = [];
        for (const [rawInstanceId, entry] of Object.entries(configMap)) {
          if (entry.enabled === false) continue;
          const environment = mergeProviderInstanceEnvironment(entry.environment);
          if (entry.driver === "claudeAgent") {
            const claudeSettings = yield* decodeClaudeSettings(entry.config ?? {}).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            );
            if (claudeSettings === null) continue;
            jobs.push(
              pull.claude(claudeSettings, environment).pipe(
                Effect.flatMap((payload) =>
                  payload === null || payload === undefined
                    ? Effect.void
                    : ingest({
                        provider: "claudeAgent",
                        payload,
                        createdAt: nowIso,
                        providerInstanceId: ProviderInstanceId.make(rawInstanceId),
                      }),
                ),
              ),
            );
          } else if (entry.driver === "grok") {
            const home = grokHomeFor(entry);
            jobs.push(
              Effect.gen(function* () {
                // Skip the boot when the log already holds a fresh line -
                // rapid clicks cost one boot, not many. An expired or absent
                // line is exactly what the boot exists to replace.
                const logPath = path.join(home, "logs", "unified.jsonl");
                const existing = yield* Effect.promise(() => readLatestGrokCredits(logPath, nowMs));
                if (
                  existing._tag === "credits" &&
                  nowMs - existing.credits.asOfMs < GROK_BOOT_FRESH_MS
                ) {
                  return;
                }
                const grokSettings = isRecord(entry.config) ? entry.config : {};
                const binaryPath =
                  typeof grokSettings["binaryPath"] === "string" &&
                  grokSettings["binaryPath"].trim() !== ""
                    ? grokSettings["binaryPath"]
                    : "grok";
                yield* pull.grok(binaryPath, home, environment);
              }),
            );
          } else if (entry.driver === "codex") {
            const codexSettings = yield* decodeCodexSettings(entry.config ?? {}).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            );
            if (codexSettings === null) continue;
            let codexEnvironment = environment;
            if (
              codexSettings.homePath.trim() !== "" ||
              codexSettings.shadowHomePath.trim() !== ""
            ) {
              // The shadow overlay keeps auth.json private per instance, so
              // the pull must run against the same effective home the
              // instance's own sessions use.
              const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
                Effect.provideService(Path.Path, path),
              );
              codexEnvironment = {
                ...environment,
                CODEX_HOME: layout.effectiveHomePath ?? layout.sharedHomePath,
              };
            }
            jobs.push(
              pull.codex(codexSettings, codexEnvironment, config.cwd).pipe(
                Effect.flatMap((payload) =>
                  payload === null || payload === undefined
                    ? Effect.void
                    : ingest({
                        provider: "codex",
                        payload,
                        createdAt: nowIso,
                        providerInstanceId: ProviderInstanceId.make(rawInstanceId),
                      }),
                ),
              ),
            );
          }
        }
        yield* Effect.all(jobs, { concurrency: 3 });
        // Unthrottled vendor-file pass: the refresh moment deserves a fresh
        // read of Grok's log and the Codex transcripts too.
        lastCodexSeedAttemptAtMs = 0;
        yield* maybeSeedFromVendorFiles(nowMs, configMap).pipe(
          Effect.catchCause(() => Effect.void),
        );
      }
      return yield* readSummary();
    });

    return { readSummary, ingest, refresh } as const;
  });

export const layer = Layer.effect(AccountLimitsService, make());
