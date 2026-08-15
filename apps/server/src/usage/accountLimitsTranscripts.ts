// @effect-diagnostics nodeBuiltinImport:off
/**
 * Codex transcript recovery for account limits.
 *
 * Codex writes its full rate-limit snapshot beside every `token_count` line in
 * `~/.codex/sessions/**\/*.jsonl`, so the latest snapshot survives on disk even
 * when no session has run through T3 Code. Claude has no equivalent: its
 * limits exist only on the live SDK stream.
 *
 * Only file tails are read: the newest lines carry the newest snapshot, and a
 * session file can be tens of megabytes. Direct `node:fs` is deliberate, same
 * as `usageTranscriptReader`: this is bulk raw-file access on a request path.
 *
 * @module accountLimitsTranscripts
 */
import * as NodeFSP from "node:fs/promises";

import {
  codexSnapshotFromUnknown,
  grokSnapshotFromCreditsConfig,
  isPrimaryCodexLimit,
  type CodexRateLimitsSnapshot,
  type GrokCreditsSnapshot,
} from "./accountLimitsNormalize.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

const TAIL_BYTES = 256 * 1024;
const SCAN_WINDOW_DAYS = 14;
/**
 * Newest-first cutoff bounding the scan on the RPC path. The newest file
 * almost always hits; the margin covers runs of files without a main-meter
 * snapshot (Spark-only sessions, sessions abandoned before any token count).
 * If this many consecutive files lack one, the data is genuinely absent.
 */
const MAX_FILES = 32;

export interface CodexTranscriptRateLimits {
  readonly snapshot: CodexRateLimitsSnapshot;
  readonly asOfMs: number;
}

export async function readLatestCodexRateLimits(
  sessionsDir: string,
  nowMs: number,
): Promise<CodexTranscriptRateLimits | null> {
  let files;
  try {
    files = await listTranscriptFiles(sessionsDir, nowMs - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  } catch {
    return null;
  }
  const newestFirst = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  // The newest-mtime file does not necessarily hold the newest snapshot: a
  // session can keep appending non-token events after its last rate-limit
  // line. A file's snapshot can never be newer than the file's mtime, so
  // keep scanning only while a remaining file's mtime could still beat the
  // best snapshot found - which usually stops after one or two files.
  let best: CodexTranscriptRateLimits | null = null;
  for (const file of newestFirst) {
    if (best !== null && file.mtimeMs <= best.asOfMs) break;
    const found = await readTailRateLimits(file.path, file.mtimeMs);
    if (found !== null && (best === null || found.asOfMs > best.asOfMs)) best = found;
  }
  return best;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readTailRateLimits(
  filePath: string,
  mtimeMs: number,
): Promise<CodexTranscriptRateLimits | null> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    // The first line may be cut mid-record by the tail offset; JSON.parse
    // rejects it and the scan moves on.
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || !line.includes('"rate_limits"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : null;
      if (!payload) continue;
      const snapshot = codexSnapshotFromUnknown(payload.rate_limits);
      // Side meters (Spark) write their own snapshot lines; keep scanning
      // back for the main meter.
      if (!snapshot || !isPrimaryCodexLimit(snapshot.limitId) || snapshot.windows.length === 0) {
        continue;
      }
      const timestamp =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      return { snapshot, asOfMs: Number.isFinite(timestamp) ? timestamp : mtimeMs };
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

export interface GrokLogCredits {
  readonly snapshot: GrokCreditsSnapshot;
  readonly asOfMs: number;
}

/**
 * Tri-state read: `credits` is a usable reading; `expired` means the newest
 * billing record's period has already ended, which the caller must treat as
 * "drop any cached reading" - not merely "no new data" - or a stale
 * percentage resurrects from the persisted cache forever; `none` means the
 * log holds no billing record at all (or the newest one is unusable).
 */
export type GrokLogRead =
  | { readonly _tag: "credits"; readonly credits: GrokLogCredits }
  | { readonly _tag: "expired"; readonly asOfMs: number }
  | { readonly _tag: "superseded"; readonly asOfMs: number }
  | { readonly _tag: "none" };

/**
 * The Grok CLI logs far more than billing between fetches - a busy session
 * pushes the last `billing:` line megabytes from the end - so unlike the
 * Codex tail read, this walks backward in bounded chunks. The cap keeps a
 * pathological log from stalling the RPC path; a billing line older than
 * the cap's reach is stale enough that skipping it is honest.
 */
const GROK_CHUNK_BYTES = 256 * 1024;
const GROK_MAX_CHUNKS = 32;

/**
 * Newest usable `billing: fetched credits config` line in the Grok CLI's own
 * log. The CLI fetches its subscription window during ordinary interactive
 * use and logs the whole config - the same "the vendor already wrote it to
 * disk" contract the Codex transcript seed relies on. A reading whose period
 * has already ended is not a reading (the percentage belongs to a window
 * that no longer exists), so scanning stops there.
 */
export async function readLatestGrokCredits(logPath: string, nowMs: number): Promise<GrokLogRead> {
  let handle;
  try {
    handle = await NodeFSP.open(logPath, "r");
  } catch {
    return { _tag: "none" };
  }
  try {
    const stat = await handle.stat();
    // Carries the (possibly line-split) head of the previous chunk so a
    // billing line straddling a boundary is seen whole on the next pass.
    let carry = "";
    for (let chunk = 0; chunk < GROK_MAX_CHUNKS; chunk++) {
      const end = stat.size - chunk * GROK_CHUNK_BYTES;
      if (end <= 0) break;
      const start = Math.max(0, end - GROK_CHUNK_BYTES);
      const { buffer, bytesRead } = await handle.read({
        buffer: Buffer.alloc(end - start),
        position: start,
      });
      const text = buffer.subarray(0, bytesRead).toString("utf8") + carry;
      const lines = text.split("\n");
      // The first element may be the tail of a line that starts in the next
      // (earlier) chunk; hold it back unless this chunk reaches the file start.
      carry = start === 0 ? "" : (lines.shift() ?? "");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line || !line.includes("billing: fetched credits config")) continue;
        let parsed: unknown;
        try {
          // A parse failure here can only be a chunk-boundary artifact (the
          // carry covers real splits) or corruption - keep scanning.
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        // The substring can occur inside another record's payload; only the
        // actual msg field marks a billing record.
        if (!isRecord(parsed) || parsed.msg !== "billing: fetched credits config") continue;
        // This IS the newest billing record, and it alone decides. Falling
        // through to an older line would show the last paid percentage after
        // a seat goes unmetered, or old-shape numbers after xAI reshapes the
        // payload - a wrong reading dressed as a reading.
        const timestamp = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
        const asOfMs = Number.isFinite(timestamp) ? timestamp : stat.mtimeMs;
        const snapshot = grokSnapshotFromCreditsConfig(parsed.ctx);
        // The newest record exists but offers no usable reading (an unmetered
        // seat, or a reshaped payload): it SUPERSEDES older lines without
        // replacing them. The caller must stop serving any cached reading at
        // least this old - "none" is reserved for finding no record at all,
        // so log rotation can never wipe a good cache.
        if (!snapshot || snapshot.windows.length === 0) return { _tag: "superseded", asOfMs };
        const resetsAt = snapshot.windows[0]?.resetsAt;
        const periodEndMs = resetsAt == null ? Number.NaN : Date.parse(resetsAt);
        // The expired arm still names WHEN the dead reading was written, so a
        // caller can tell "this verdict is older than my cache" from "newer".
        if (Number.isFinite(periodEndMs) && periodEndMs < nowMs) return { _tag: "expired", asOfMs };
        return {
          _tag: "credits",
          credits: { snapshot, asOfMs },
        };
      }
    }
    return { _tag: "none" };
  } catch {
    return { _tag: "none" };
  } finally {
    await handle.close().catch(() => {});
  }
}
