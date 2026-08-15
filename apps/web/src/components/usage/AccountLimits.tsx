/**
 * Account rate-limit views: the sidebar hover card and the usage page's
 * "Limits" strip. Both render whatever windows the server reports, so a
 * window a provider adds or brings back (Codex's paused 5-hour) appears
 * without a client change.
 *
 * One block per provider; one row group per (environment, instance) under
 * it. With a single row - the common case - nothing is captioned and the
 * markup is identical to the single-account rendering. With several, each
 * group is captioned with the instance's display name (and the environment
 * label when more than one environment reports) so two accounts' numbers
 * can never be mistaken for one another.
 *
 * Every percentage is labelled `used` inline - a bare number cannot say
 * whether it is used or remaining. Every row states its snapshot age -
 * a meter's trust is its freshness - warming in tone once it goes stale.
 *
 * @module AccountLimits
 */
import type {
  AccountLimitsProviderKind,
  AccountLimitsSnapshot,
  AccountLimitsWindow,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { type AccountLimitsRow, useAccountLimits } from "../../state/accountLimits";
import { formatAgo, formatPlan, formatResetAt } from "../../usage/limitsFormat";
import { ClaudeAI, GrokIcon, type Icon, OpenAI } from "../Icons";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";

/**
 * Presentation for the Limits panel - deliberately its own roster rather than
 * `usageProviders`': limits cover providers (Grok) the transcript cost
 * analytics does not, and the two lists must be free to grow apart. Claude
 * and Codex reuse the exact colours and marks of the analytics page so the
 * two surfaces keep reading as one system; Grok's mark is monochrome, so its
 * bars take the muted foreground - distinct from Codex's full-strength
 * neutral in both themes.
 */
const LIMITS_PROVIDERS: readonly {
  readonly kind: AccountLimitsProviderKind;
  readonly label: string;
  readonly color: string;
  readonly Mark: Icon;
}[] = [
  { kind: "codex", label: "Codex", color: "#e6e6e6", Mark: OpenAI },
  { kind: "claude", label: "Claude Code", color: "#d97757", Mark: ClaudeAI },
  { kind: "grok", label: "Grok", color: "var(--muted-foreground)", Mark: GrokIcon },
];

/** Age past which a snapshot's caption shifts to the warning tone. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Reset countdowns and snapshot ages drift as time passes, not as data
 * changes; a coarse tick keeps them honest without re-fetching.
 */
function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function usageTone(usedPercent: number): string | undefined {
  if (usedPercent >= 95) return "text-red-400";
  if (usedPercent >= 80) return "text-amber-400";
  return undefined;
}

function LimitMeter({ window, color }: { window: AccountLimitsWindow; color: string }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

/**
 * Every row states its age: a meter's trust IS its freshness, and "no
 * caption" made a two-minute-old reading and a fourteen-minute-old one
 * indistinguishable. Past the staleness threshold the tone warms so an
 * aging snapshot is visible before it is a problem.
 */
function SnapshotAge({ snapshot, nowMs }: { snapshot: AccountLimitsSnapshot; nowMs: number }) {
  const ageMs = nowMs - Date.parse(snapshot.asOf);
  if (!Number.isFinite(ageMs)) return null;
  return (
    <span
      className={cn(
        "text-[10px] tabular-nums",
        ageMs >= STALE_AFTER_MS ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      {formatAgo(snapshot.asOf, nowMs)}
    </span>
  );
}

/** Stable key for one (environment, instance) row group. */
function rowKey(row: AccountLimitsRow): string {
  // The merge folds unkeyed snapshots onto the driver's default instance id,
  // so the key must use the same spelling or an instance literally named
  // "default" could collide with a legacy row.
  const instanceId =
    row.snapshot.instanceId ??
    (row.snapshot.provider === "claude" ? "claudeAgent" : row.snapshot.provider);
  return `${row.environmentId}:${instanceId}`;
}

/**
 * Who a row group belongs to: instance name (when several rows could be
 * conflated), plan, and the account email - the email through the same
 * blur-until-clicked treatment the provider settings use, so the caption
 * never leaks what that redaction protects.
 */
function AccountCaption({
  row,
  showInstance,
  nameEnvironment,
  showAge,
  nowMs,
  className,
  emailClassName,
}: {
  row: AccountLimitsRow;
  showInstance: boolean;
  nameEnvironment: boolean;
  showAge: boolean;
  nowMs: number;
  className: string;
  emailClassName: string;
}) {
  const plan = formatPlan(row.snapshot.plan);
  const parts: string[] = [];
  if (showInstance) {
    parts.push(
      nameEnvironment && row.environmentLabel !== null
        ? `${row.instanceLabel} · ${row.environmentLabel}`
        : row.instanceLabel,
    );
  }
  if (plan !== null) parts.push(plan);
  if (parts.length === 0 && row.accountEmail === null) return null;
  return (
    <div className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      {parts.length > 0 ? <span className="truncate">{parts.join(" · ")}</span> : null}
      {/* Matches the caption's type instead of the settings page's mono:
          this line reads as one sentence, not a form field. */}
      <RedactedSensitiveText
        value={row.accountEmail}
        ariaLabel="Account email"
        revealTooltip="Click to reveal"
        hideTooltip="Click to hide"
        className={emailClassName}
      />
      {showAge ? (
        <span className="ml-auto shrink-0">
          <SnapshotAge snapshot={row.snapshot} nowMs={nowMs} />
        </span>
      ) : null}
    </div>
  );
}

/** True when a caption would carry any account information at all. */
function hasAccountInfo(row: AccountLimitsRow): boolean {
  return formatPlan(row.snapshot.plan) !== null || row.accountEmail !== null;
}

// ---------------------------------------------------------------------------
// Sidebar hover card
// ---------------------------------------------------------------------------

function HoverWindowRow({
  window,
  color,
  nowMs,
}: {
  window: AccountLimitsWindow;
  color: string;
  nowMs: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-9 shrink-0 truncate whitespace-nowrap text-[10px] text-muted-foreground"
        title={window.label}
      >
        {window.label}
      </span>
      <LimitMeter window={window} color={color} />
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-foreground",
          usageTone(window.usedPercent),
        )}
      >
        {Math.round(window.usedPercent)}% used
      </span>
      <span className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground">
        {formatResetAt(window.resetsAt, nowMs) ?? ""}
      </span>
    </div>
  );
}

/** Compact per-provider availability, shown on hovering the Usage button. */
export function AccountLimitsHoverCard() {
  const { byProvider, reportingEnvironments, isPending, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  if (isPending && byProvider.size === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading limits…</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2.5 p-1.5">
      {LIMITS_PROVIDERS.map(({ kind: provider, label, color, Mark }) => {
        const rows = byProvider.get(provider) ?? [];
        const only = rows.length === 1 ? rows[0] : undefined;
        return (
          <div key={provider} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <Mark className="size-3 shrink-0 self-center" />
              <span className="text-xs font-medium text-foreground">{label}</span>
              <span className="ml-auto">
                {only !== undefined ? <SnapshotAge snapshot={only.snapshot} nowMs={nowMs} /> : null}
              </span>
            </div>
            {rows.length === 0 || (only !== undefined && only.snapshot.windows.length === 0) ? (
              <p className="text-[11px] text-muted-foreground">
                {rows.length === 0 && isSettling ? "Loading…" : "No limit data yet"}
              </p>
            ) : only !== undefined ? (
              <>
                {/* One account: name it (plan + blurred email) when known -
                    an API-key setup with neither renders exactly as before. */}
                {hasAccountInfo(only) ? (
                  <AccountCaption
                    row={only}
                    showInstance={false}
                    nameEnvironment={false}
                    showAge={false}
                    nowMs={nowMs}
                    className="text-[10px] text-muted-foreground"
                    emailClassName="font-sans text-[10px] leading-normal"
                  />
                ) : null}
                {only.snapshot.windows.map((window) => (
                  <HoverWindowRow key={window.id} window={window} color={color} nowMs={nowMs} />
                ))}
              </>
            ) : (
              rows.map((row) => (
                <div key={rowKey(row)} className="flex flex-col gap-1">
                  <AccountCaption
                    row={row}
                    showInstance
                    nameEnvironment={reportingEnvironments > 1}
                    showAge
                    nowMs={nowMs}
                    className="text-[10px] text-muted-foreground"
                    emailClassName="font-sans text-[10px] leading-normal"
                  />
                  {row.snapshot.windows.map((window) => (
                    <HoverWindowRow key={window.id} window={window} color={color} nowMs={nowMs} />
                  ))}
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage page section
// ---------------------------------------------------------------------------

function SectionWindowRow({
  window,
  color,
  nowMs,
}: {
  window: AccountLimitsWindow;
  color: string;
  nowMs: number;
}) {
  const resetAt = formatResetAt(window.resetsAt, nowMs);
  return (
    <div className="flex items-center gap-3">
      <span
        className="w-10 shrink-0 truncate whitespace-nowrap text-xs text-muted-foreground"
        title={window.label}
      >
        {window.label}
      </span>
      <LimitMeter window={window} color={color} />
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-right text-xs font-medium tabular-nums text-foreground",
          usageTone(window.usedPercent),
        )}
      >
        {Math.round(window.usedPercent)}% used
      </span>
      <span className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
        {resetAt === null ? "" : `resets ${resetAt}`}
      </span>
    </div>
  );
}

/** The "Limits" strip above the analytics: one column per provider. */
export function AccountLimitsSection() {
  const { byProvider, reportingEnvironments, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Limits</h2>
      <div className="grid gap-x-12 gap-y-4 sm:grid-cols-2">
        {LIMITS_PROVIDERS.map(({ kind: provider, label, color, Mark }) => {
          const rows = byProvider.get(provider) ?? [];
          const only = rows.length === 1 ? rows[0] : undefined;
          return (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <Mark className="size-3.5 shrink-0 self-center" />
                <span className="text-sm font-medium text-foreground">{label}</span>
                <span className="ml-auto">
                  {only !== undefined ? (
                    <SnapshotAge snapshot={only.snapshot} nowMs={nowMs} />
                  ) : null}
                </span>
              </div>
              {rows.length === 0 || (only !== undefined && only.snapshot.windows.length === 0) ? (
                <p className="text-xs text-muted-foreground">
                  {rows.length === 0 && isSettling ? "Loading…" : "No limit data yet"}
                </p>
              ) : only !== undefined ? (
                <>
                  {/* One account: name it (plan + blurred email) when known -
                      an API-key setup with neither renders exactly as before. */}
                  {hasAccountInfo(only) ? (
                    <AccountCaption
                      row={only}
                      showInstance={false}
                      nameEnvironment={false}
                      showAge={false}
                      nowMs={nowMs}
                      className="text-xs text-muted-foreground"
                      emailClassName="font-sans text-xs leading-normal"
                    />
                  ) : null}
                  {only.snapshot.windows.map((window) => (
                    <SectionWindowRow key={window.id} window={window} color={color} nowMs={nowMs} />
                  ))}
                </>
              ) : (
                rows.map((row) => (
                  <div key={rowKey(row)} className="flex flex-col gap-1.5">
                    <AccountCaption
                      row={row}
                      showInstance
                      nameEnvironment={reportingEnvironments > 1}
                      showAge
                      nowMs={nowMs}
                      className="text-xs text-muted-foreground"
                      emailClassName="font-sans text-xs leading-normal"
                    />
                    {row.snapshot.windows.map((window) => (
                      <SectionWindowRow
                        key={window.id}
                        window={window}
                        color={color}
                        nowMs={nowMs}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
