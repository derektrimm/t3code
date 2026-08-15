/**
 * On-demand limit pulls, one per provider that has a query surface.
 *
 * The passive cache only moves while sessions run (Claude, Codex) or when
 * the vendor CLI happens to write its log (Grok). A refresh click deserves
 * more than a cache re-read, so each puller asks the vendor's own tooling
 * the way the provider probes already do:
 *
 * - Claude: a never-yielding Agent SDK query - no prompt ever reaches the
 *   API - whose usage control request returns the full window set. This is
 *   the same call the adapter makes in-session, from the same SDK.
 * - Codex: `codex app-server` JSON-RPC `account/rateLimits/read`, the pull
 *   twin of the `account/rateLimits/updated` notifications ingestion
 *   already consumes.
 * - Grok: no query surface exists - verified to the binary: the billing
 *   fetch lives in the TUI shell's billing extension, there is no
 *   `_x.ai/billing` ACP method, and a full agent handshake (initialize,
 *   authenticate, session/new) leaves the log untouched. So the grok pull
 *   boots the TUI itself for a few seconds under a pty (POSIX `script`) -
 *   the vendor's own interface doing the vendor's own fetch - and the
 *   unthrottled seed then reads the seconds-old line it wrote.
 * - Cursor / OpenCode: no rate-limit surface today - `agent about` reports
 *   identity and plan only, and the OpenCode SDK exposes no quota - so the
 *   decision per adapter is explicitly "not supported here".
 *
 * Every puller returns the provider's RAW payload (the same shapes the
 * normalizer already parses off the live stream) or null; a failed or
 * timed-out pull is a skip, never an error - refresh must not be able to
 * break the panel it refreshes.
 *
 * @module accountLimitsPull
 */
import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeSettings, type CodexSettings } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { buildClaudeCapabilitiesProbeQueryOptions } from "../provider/Layers/ClaudeProvider.ts";
import { codexAppServerArgs } from "../provider/Layers/codexLaunchArgs.ts";

const PULL_TIMEOUT_MS = 20_000;
const GROK_BOOT_SECONDS = 7;
const CODEX_PULL_FORCE_KILL_AFTER = "2 seconds" as const;

const waitForAbortSignal = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/**
 * The SDK's usage control response, raw - exactly what the adapter's
 * in-session call streams and `claudeUsageSnapshotFromUnknown` parses.
 */
export const pullClaudeLimits = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<unknown, never, Path.Path> => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield - only the usage control request runs, no prompt ever
        // reaches the Anthropic API (the capabilities probe's own pattern).
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd: undefined,
        }),
      });
      await q.initializationResult();
      return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeout(PULL_TIMEOUT_MS),
    Effect.catchCause(() => Effect.succeed(null)),
  );
};

/**
 * `account/rateLimits/read` off a short-lived `codex app-server`, raw - the
 * response wraps the same snapshot shape `codexSnapshotFromUnknown` parses
 * off the live notification stream.
 */
export const pullCodexLimits = (
  codexSettings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.Effect<unknown, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(
      codexSettings.binaryPath || "codex",
      codexAppServerArgs(codexSettings.launchArgs),
      { env: environment, extendEnv: true },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_PULL_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    );
    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    yield* client.request("initialize", {
      clientInfo: { name: "t3code_limits_refresh", title: "T3 Code limits refresh", version: "1" },
    });
    yield* client.notify("initialized", undefined);
    return yield* client.request("account/rateLimits/read", undefined);
  }).pipe(
    Effect.scoped,
    Effect.timeout(PULL_TIMEOUT_MS),
    Effect.catchCause(() => Effect.succeed(null)),
  );

/**
 * Boot the grok TUI just long enough for its billing extension to fetch and
 * log the credits config, then exit. A pty is required (the TUI refuses
 * plain pipes), so this rides POSIX `script` and is skipped on other
 * platforms - where the log seed simply serves the newest line it has. The
 * pre-check skips the boot entirely when the log is already fresh, so rapid
 * refresh clicks cost one boot, not many.
 */
export const pullGrokBillingRefresh = (
  binaryPath: string,
  home: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "linux" && platform !== "darwin") return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bootEnvironment = { ...environment, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" };
    // Single-quote the binary for the `sh -c` layer `script -c` runs it
    // through; a path with single quotes gets the standard '"'"' splice.
    const quoted = `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
    const args =
      platform === "linux"
        ? ["-qec", `exec timeout ${GROK_BOOT_SECONDS} ${quoted}`, "/dev/null"]
        : ["-q", "/dev/null", binaryPath];
    const child = yield* spawner.spawn(
      ChildProcess.make("script", args, {
        env: bootEnvironment,
        extendEnv: true,
        forceKillAfter: CODEX_PULL_FORCE_KILL_AFTER,
      }),
    );
    yield* child.exitCode;
  }).pipe(
    Effect.scoped,
    Effect.timeout((GROK_BOOT_SECONDS + 4) * 1000),
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  );
