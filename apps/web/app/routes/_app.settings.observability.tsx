import { useLoaderData, useRouteError } from "@remix-run/react";
import { useRef, useState } from "react";
import { ChartCanvas } from "~/components/observability/chart-canvas";
import { ErrorState } from "~/components/states";
import { Sheet } from "~/components/ui/sheet";
import { ApiError } from "~/lib/api";
import {
  formatTokens,
  formatUsd,
  getObservabilityConfig,
  getObservabilitySummary,
  getRecentTurns,
  getTrace,
  type ObsConfigStatus,
  type ObsSummary,
  type RecentTurn,
  rate,
  type SummaryRange,
  type TraceEvent,
} from "~/lib/observability";
import { cn } from "~/lib/utils";

const RANGES: { key: SummaryRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

/** Bucket label: hour-of-day for 24h, month/day otherwise. */
function bucketLabel(iso: string, range: SummaryRange): string {
  const d = new Date(iso);
  return range === "24h"
    ? d.toLocaleTimeString(undefined, { hour: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export async function clientLoader() {
  const [initial, config, recent] = await Promise.all([
    getObservabilitySummary("7d"),
    getObservabilityConfig(),
    getRecentTurns(25),
  ]);
  return { initial, config, recent };
}

export default function SettingsObservability() {
  const { initial, config, recent } = useLoaderData<typeof clientLoader>();
  const [summary, setSummary] = useState<ObsSummary>(initial);
  const [range, setRange] = useState<SummaryRange>("7d");
  const [loading, setLoading] = useState(false);
  // Generation guard: drop a summary fetch whose response loses the race to a newer range click.
  const rangeReq = useRef(0);

  async function applyRange(next: SummaryRange): Promise<void> {
    setRange(next);
    const id = ++rangeReq.current;
    setLoading(true);
    try {
      const data = await getObservabilitySummary(next);
      if (id === rangeReq.current) setSummary(data);
    } finally {
      if (id === rangeReq.current) setLoading(false);
    }
  }

  const { totals, series, byAgent, byModel, reliability } = summary;
  const maxAgentCost = Math.max(1e-9, ...byAgent.map((a) => a.costUsd));

  return (
    <div className={cn("flex flex-col gap-6", loading && "opacity-60 transition-opacity")}>
      <div className="flex items-center justify-end">
        <nav className="flex shrink-0 gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => applyRange(r.key)}
              className={cn(
                "cursor-pointer rounded-sm border px-2.5 py-1 text-xs transition-colors",
                r.key === range
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {r.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Headline metric cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Spend" value={formatUsd(totals.costUsd)} />
        <MetricCard label="Tokens" value={formatTokens(totals.tokens)} />
        <MetricCard label="Turns" value={String(totals.turns)} />
        <MetricCard
          label="Unpriced calls"
          value={String(totals.unpricedCalls)}
          muted={totals.unpricedCalls === 0}
        />
      </div>

      {/* Reliability */}
      <Panel title="Reliability">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat
            label="Turn errors"
            value={rate(reliability.turnErrors, reliability.turns)}
            danger={reliability.turnErrors > 0}
            sub={`${reliability.turnErrors}/${reliability.turns}`}
          />
          <Stat
            label="Fallbacks"
            value={rate(reliability.fallbacks, reliability.llmCalls)}
            danger={reliability.fallbacks > 0}
            sub={`${reliability.fallbacks}/${reliability.llmCalls}`}
          />
          <Stat
            label="Tool errors"
            value={rate(reliability.toolErrors, reliability.toolCalls)}
            danger={reliability.toolErrors > 0}
            sub={`${reliability.toolErrors}/${reliability.toolCalls}`}
          />
          <Stat label="Step latency p95" value={`${reliability.p95DurationMs} ms`} />
        </div>
      </Panel>

      {/* Spend over time */}
      <Panel title="Spend over time">
        {series.length === 0 ? (
          <EmptyHint />
        ) : (
          <ChartCanvas
            kind="line"
            ariaLabel="Spend over time"
            formatValue={formatUsd}
            data={{
              labels: series.map((p) => bucketLabel(p.bucket, range)),
              values: series.map((p) => p.costUsd),
            }}
          />
        )}
      </Panel>

      {/* Spend by agent */}
      <Panel title="Spend by agent">
        {byAgent.length === 0 ? (
          <EmptyHint />
        ) : (
          <ul className="flex flex-col gap-2">
            {byAgent.map((a) => (
              <li key={a.agentId} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm text-foreground" title={a.agentId}>
                  {a.agentId}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-sm bg-muted/40">
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.max(2, (a.costUsd / maxAgentCost) * 100)}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  {formatUsd(a.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* By model */}
      <Panel title="By model">
        {byModel.length === 0 ? (
          <EmptyHint />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 font-normal">Model</th>
                <th className="py-1.5 text-right font-normal">Calls</th>
                <th className="py-1.5 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.model} className="border-border/60 border-b">
                  <td className="py-1.5 text-foreground">{m.model}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {m.calls}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {m.unpriced ? (
                      <span title="No price found for this model — add a pricing override in observability.config.yaml">
                        unpriced
                      </span>
                    ) : (
                      formatUsd(m.costUsd)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <RecentTurnsPanel recent={recent} />

      <GrafanaExportPanel config={config} />
    </div>
  );
}

function RecentTurnsPanel({ recent }: { recent: RecentTurn[] }) {
  const [open, setOpen] = useState<RecentTurn | null>(null);
  const [trace, setTrace] = useState<TraceEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generation guard: a slower earlier trace fetch must not overwrite the one the user just opened.
  const traceReq = useRef(0);

  async function openTrace(turn: RecentTurn): Promise<void> {
    setOpen(turn);
    setTrace(null);
    setError(null);
    if (!turn.conversationId) return;
    const id = ++traceReq.current;
    setLoading(true);
    try {
      const events = await getTrace(turn.conversationId);
      if (id === traceReq.current) setTrace(events);
    } catch (err) {
      // A server/network failure must read as an error, not as "no trace events".
      if (id === traceReq.current) {
        setError(err instanceof ApiError ? err.message : "Failed to load trace");
      }
    } finally {
      if (id === traceReq.current) setLoading(false);
    }
  }

  return (
    <Panel title="Recent turns">
      {recent.length === 0 ? (
        <EmptyHint />
      ) : (
        <ul className="flex flex-col">
          {recent.map((t, i) => (
            <li key={`${t.conversationId}-${t.ts}-${i}`}>
              <button
                type="button"
                onClick={() => openTrace(t)}
                disabled={!t.conversationId}
                className="flex w-full cursor-pointer items-center gap-3 border-border/60 border-b py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-default"
              >
                <span
                  className={cn(
                    "inline-block size-2 shrink-0 rounded-full",
                    t.status === "error" ? "bg-destructive" : "bg-primary"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {t.agentId ?? "agent"}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t.steps} steps · {formatTokens(t.tokensIn + t.tokensOut)} tok
                </span>
                <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">
                  {new Date(t.ts).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={open !== null} onClose={() => setOpen(null)} title="Turn trace">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading trace…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : trace && trace.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {trace.map((e, i) => (
              <TraceRow key={`${e.type}-${e.ts}-${i}`} e={e} />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No trace events for this conversation.</p>
        )}
      </Sheet>
    </Panel>
  );
}

function TraceRow({ e }: { e: TraceEvent }) {
  const isError = e.status === "error";
  const label =
    e.type === "llm_call"
      ? `${e.model ?? "model"}${e.tier ? ` · ${e.tier}` : ""}`
      : e.type === "tool_call"
        ? (e.toolName ?? "tool")
        : e.type;
  return (
    <li className="flex items-start gap-3 border-border/60 border-b pb-2">
      <span
        className={cn(
          "mt-1 inline-block size-2 shrink-0 rounded-full",
          isError || e.status === "fallback" ? "bg-destructive" : "bg-primary"
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{e.type}</span>
          <span className="truncate text-sm text-foreground">{label}</span>
          {e.status && e.status !== "ok" ? (
            <span className="rounded-sm bg-destructive/10 px-1 text-xs text-destructive">
              {e.status}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
          {e.tokensIn != null ? (
            <span>
              {e.tokensIn}↑ / {e.tokensOut ?? 0}↓ tok
            </span>
          ) : null}
          {e.costUsd != null ? <span>{formatUsd(e.costUsd)}</span> : null}
          {e.durationMs != null ? <span>{e.durationMs} ms</span> : null}
        </span>
      </span>
    </li>
  );
}

function GrafanaExportPanel({ config }: { config: ObsConfigStatus }) {
  const status = config.enabled && config.otlpConfigured ? "On" : "Off";
  return (
    <Panel title="Grafana Cloud export">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              status === "On" ? "bg-primary" : "bg-muted-foreground"
            )}
            aria-hidden
          />
          <span className="text-foreground">
            OTLP metrics export is <span className="font-bold">{status}</span>
          </span>
          {config.otlpConfigured && config.endpoint ? (
            <span className="truncate text-xs text-muted-foreground">→ {config.endpoint}</span>
          ) : null}
        </div>
        <p className="text-muted-foreground">
          Push cost, token, error, fallback, and tool metrics to Grafana Cloud (Mimir) for richer
          dashboards and alerting. Configure <code className="text-foreground">otlp</code> in{" "}
          <code className="text-foreground">soul/observability.config.yaml</code> with your
          endpoint, instance id, and token (a secret ref), then restart. Import the ready-made
          dashboard and alert rules from{" "}
          <code className="text-foreground">apps/api/src/observability/grafana/</code>.
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <ConfigRow label="Retention" value={`${config.retentionDays} days`} />
          <ConfigRow label="Content capture" value={config.captureContent ? "On" : "Off"} />
          <ConfigRow
            label="Spend alert"
            value={config.spendAlertUsd != null ? formatUsd(config.spendAlertUsd) : "unset"}
          />
        </dl>
      </div>
    </Panel>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-border/60 border-b py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function MetricCard({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-sm border border-border px-3 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums",
          muted ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-bold tabular-nums", danger && "text-destructive")}>
        {value}
      </p>
      {sub ? <p className="text-xs tabular-nums text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-sm border border-border p-4">
      <h2 className="mb-3 text-sm font-bold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function EmptyHint() {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">
      No activity in this window yet.
    </p>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="settings" status={status} message={message} />;
}
