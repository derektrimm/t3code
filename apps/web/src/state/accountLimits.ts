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

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentLimitsStatus {
  readonly environmentId: EnvironmentId;
  /** The environment's display label, for when several report. */
  readonly environmentLabel: string | null;
  readonly isPending: boolean;
  readonly snapshots: readonly AccountLimitsSnapshot[] | null;
  /** Streamed provider config; the source of instance display names. */
  readonly providers: readonly ServerProvider[] | null;
}

const accountLimitsAtom = Atom.make((get): readonly EnvironmentLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.accountLimits({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    statuses.push({
      environmentId,
      environmentLabel: presentation.entry.target.label ?? null,
      providers: presentation.serverConfig?.providers ?? null,
      isPending: result.waiting,
      snapshots:
        summary === null || !ACCOUNT_LIMITS_ACCEPTED_VERSIONS.includes(summary.contractVersion)
          ? null
          : summary.snapshots,
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
    for (const snapshot of byInstance.values()) {
      const instanceId = snapshot.instanceId ?? legacyInstanceIdFor(snapshot.provider);
      const duplicateKey = JSON.stringify([
        snapshot.provider,
        instanceId,
        snapshot.asOf,
        snapshot.source,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const provider = status.providers?.find((candidate) => candidate.instanceId === instanceId);
      const rows = byProvider.get(snapshot.provider) ?? [];
      const authEmail =
        provider?.auth.status === "authenticated" ? (provider.auth.email ?? null) : null;
      rows.push({
        environmentId: status.environmentId,
        environmentLabel: status.environmentLabel,
        accountEmail: authEmail !== null && authEmail.trim() !== "" ? authEmail : null,
        instanceLabel: provider?.displayName ?? instanceId,
        snapshot,
      });
      byProvider.set(snapshot.provider, rows);
    }
  }
  for (const rows of byProvider.values()) {
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
  readonly refresh: () => void;
}

export function useAccountLimits(): AccountLimitsView {
  const environments = useAtomValue(accountLimitsAtom);

  const byProvider = useMemo(() => mergeEnvironmentLimits(environments), [environments]);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.accountLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

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
