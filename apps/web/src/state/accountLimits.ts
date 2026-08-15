/**
 * Multi-environment account-limits state.
 *
 * Every connected environment reports one snapshot per provider instance;
 * the client keeps ONE ROW PER (environment, provider, instance) and never
 * merges across environments: `asOf` comes from each environment's local
 * clock, and clock skew must not let one machine's reading replace another
 * machine's correct one. Within a single environment, a server predating
 * instance attribution answers with unkeyed snapshots - those fold onto the
 * driver's default instance, freshest wins, which is exactly what that data
 * meant when it was written.
 *
 * @module state/accountLimits
 */
import { useAtomValue } from "@effect/atom-react";
import {
  ACCOUNT_LIMITS_ACCEPTED_VERSIONS,
  type AccountLimitsSnapshot,
  type EnvironmentId,
  type ServerProvider,
  type AccountLimitsProviderKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { useAtomCommand } from "./use-atom-command";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentLimitsStatus {
  readonly environmentId: EnvironmentId;
  /** The environment's display label, for when several report. */
  readonly environmentLabel: string | null;
  readonly isPending: boolean;
  readonly snapshots: readonly AccountLimitsSnapshot[] | null;
  /** The server's own clock when it wrote the summary. */
  readonly readAt: string | null;
  /** This client's clock when the summary arrived - `readAt`'s local twin. */
  readonly receivedAtMs: number | null;
  /** Streamed provider config; the source of instance display names. */
  readonly providers: readonly ServerProvider[] | null;
}

/**
 * When each summary object was first seen, keyed by identity: the atom
 * re-evaluates on unrelated changes, and re-stamping a cached summary would
 * quietly grow the skew estimate until fresh rows rendered as future ones.
 */
const summaryReceivedAtMs = new WeakMap<object, number>();
function receivedAtFor(summary: object): number {
  let at = summaryReceivedAtMs.get(summary);
  if (at === undefined) {
    at = Date.now();
    summaryReceivedAtMs.set(summary, at);
  }
  return at;
}

const accountLimitsAtom = Atom.make((get): readonly EnvironmentLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.accountLimits({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    const accepted =
      summary !== null && ACCOUNT_LIMITS_ACCEPTED_VERSIONS.includes(summary.contractVersion);
    statuses.push({
      environmentId,
      environmentLabel: presentation.entry.target.label ?? null,
      providers: presentation.serverConfig?.providers ?? null,
      isPending: result.waiting,
      snapshots: accepted ? summary.snapshots : null,
      readAt: accepted ? summary.readAt : null,
      receivedAtMs: accepted ? receivedAtFor(summary) : null,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-account-limits"));

/** One rendered limits row: a provider instance seen from one environment. */
export interface AccountLimitsRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  /**
   * The authenticated account email for this instance, when the provider
   * probe reports one - rendering shows it ONLY through the same
   * blur-until-clicked treatment the provider settings use.
   */
  readonly accountEmail: string | null;
  /**
   * Instance display name off the provider config already streaming to the
   * client, else the raw instance id. Never the account email: the provider
   * UI deliberately blurs emails until clicked, and a caption must not leak
   * what that redaction protects. Rendering decides when a caption is worth
   * showing.
   */
  readonly instanceLabel: string;
  /**
   * Client clock minus server clock, estimated at arrival. `asOf` is stamped
   * by the environment's server; ages rendered against this client's clock
   * add this correction so a machine hours off does not paint every fresh
   * row stale (or every stale row fresh).
   */
  readonly clockSkewMs: number;
  readonly snapshot: AccountLimitsSnapshot;
}

/** What an unkeyed (pre-instance-attribution) snapshot always meant. */
const legacyInstanceIdFor = (provider: AccountLimitsProviderKind): string =>
  provider === "claude" ? "claudeAgent" : provider;

/**
 * Pure merge, exported for tests: dedupe freshest-wins per instance WITHIN
 * an environment, never across environments (see module doc), grouped per
 * provider for rendering.
 */
export function mergeEnvironmentLimits(
  statuses: readonly EnvironmentLimitsStatus[],
): ReadonlyMap<AccountLimitsProviderKind, readonly AccountLimitsRow[]> {
  const byProvider = new Map<AccountLimitsProviderKind, AccountLimitsRow[]>();
  // Two environments on one machine (worktree servers) can hold identical
  // snapshots. Byte-identical rows carry no extra information, so exact
  // duplicates collapse; rows that differ at all - clocks included - stay,
  // because cross-environment freshness cannot be arbitrated (see module doc).
  const seen = new Set<string>();
  for (const status of statuses) {
    const byInstance = new Map<string, AccountLimitsSnapshot>();
    for (const snapshot of status.snapshots ?? []) {
      const key = JSON.stringify([
        snapshot.provider,
        snapshot.instanceId ?? legacyInstanceIdFor(snapshot.provider),
      ]);
      const current = byInstance.get(key);
      // ISO-8601 strings order lexicographically.
      if (current === undefined || snapshot.asOf > current.asOf) {
        byInstance.set(key, snapshot);
      }
    }
    const skewMs =
      status.readAt !== null && status.receivedAtMs !== null
        ? status.receivedAtMs - Date.parse(status.readAt)
        : Number.NaN;
    for (const snapshot of byInstance.values()) {
      const instanceId = snapshot.instanceId ?? legacyInstanceIdFor(snapshot.provider);
      const provider = status.providers?.find((candidate) => candidate.instanceId === instanceId);
      const authEmail =
        provider?.auth.status === "authenticated" ? (provider.auth.email ?? null) : null;
      const accountEmail = authEmail !== null && authEmail.trim() !== "" ? authEmail : null;
      // "Byte-identical" must mean the whole row: keying on the stamp alone
      // would let two environments' same-instant-but-different readings
      // collapse into one, silently deleting a real account's numbers.
      const duplicateKey = JSON.stringify([
        snapshot.provider,
        instanceId,
        snapshot.asOf,
        snapshot.source,
        snapshot.plan,
        snapshot.windows,
        accountEmail,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const rows = byProvider.get(snapshot.provider) ?? [];
      rows.push({
        environmentId: status.environmentId,
        environmentLabel: status.environmentLabel,
        accountEmail,
        instanceLabel: provider?.displayName ?? instanceId,
        clockSkewMs: Number.isFinite(skewMs) ? skewMs : 0,
        snapshot,
      });
      byProvider.set(snapshot.provider, rows);
    }
  }
  for (const rows of byProvider.values()) {
    // A display name shared by two DIFFERENT instances identifies nothing -
    // two unnamed Codex accounts must not both caption as "Codex". Those
    // rows fall back to their raw instance id, which is unique per
    // environment. Rows sharing one instance across environments keep the
    // shared name; the environment label disambiguates them in rendering.
    const instancesPerLabel = new Map<string, Set<string>>();
    for (const row of rows) {
      const instanceId = row.snapshot.instanceId ?? legacyInstanceIdFor(row.snapshot.provider);
      const ids = instancesPerLabel.get(row.instanceLabel) ?? new Set<string>();
      ids.add(instanceId);
      instancesPerLabel.set(row.instanceLabel, ids);
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row === undefined) continue;
      if ((instancesPerLabel.get(row.instanceLabel)?.size ?? 0) > 1) {
        rows[index] = {
          ...row,
          instanceLabel: row.snapshot.instanceId ?? legacyInstanceIdFor(row.snapshot.provider),
        };
      }
    }
    rows.sort(
      (a, b) =>
        a.instanceLabel.localeCompare(b.instanceLabel) ||
        a.environmentId.localeCompare(b.environmentId),
    );
  }
  return byProvider;
}

export interface AccountLimitsView {
  /**
   * Rows grouped per provider. Several rows under one provider mean several
   * instances (or several environments), each labeled; most setups have
   * exactly one.
   */
  readonly byProvider: ReadonlyMap<AccountLimitsProviderKind, readonly AccountLimitsRow[]>;
  /** Environments that have answered - >1 means rows need their environment named. */
  readonly reportingEnvironments: number;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while any environment is still answering. A provider with no
   * snapshot is "loading" while this holds and "no data" once it clears -
   * the first environment to answer must not decide that for the rest.
   */
  readonly isSettling: boolean;
  /**
   * Pull fresh limits from every provider with a query surface, on every
   * environment, then re-read - the panel's refresh button. Resolves when
   * the pulls have landed, so callers can hold a spinner honestly.
   */
  readonly refresh: () => Promise<void>;
}

export function useAccountLimits(): AccountLimitsView {
  const environments = useAtomValue(accountLimitsAtom);

  const byProvider = useMemo(() => mergeEnvironmentLimits(environments), [environments]);

  const runRefresh = useAtomCommand(serverEnvironment.refreshAccountLimits, {
    reportFailure: false,
  });
  const refresh = useCallback(async () => {
    // Ask every environment's server to pull NOW (SDK usage request, codex
    // account/rateLimits/read, unthrottled vendor-file pass)...
    await Promise.all(
      environments.map((environment) =>
        runRefresh({ environmentId: environment.environmentId, input: {} }),
      ),
    );
    // ...then re-read the query atoms so the panel shows what landed.
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.accountLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments, runRefresh]);

  const answered = environments.filter((environment) => environment.snapshots !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshots === null && environment.isPending,
  ).length;

  return {
    byProvider,
    reportingEnvironments: answered,
    isPending: answered === 0 && stillReporting > 0,
    isSettling: stillReporting > 0,
    refresh,
  };
}
