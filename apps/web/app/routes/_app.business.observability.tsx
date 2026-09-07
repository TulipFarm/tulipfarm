import { useLoaderData, useRouteError } from "@remix-run/react";
import { type FormEvent, useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { LogsPanel } from "~/components/observability/logs-panel";
import { ResourcesPanel } from "~/components/observability/resources-panel";
import { ErrorState } from "~/components/states";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Sheet } from "~/components/ui/sheet";
import { ApiError } from "~/lib/api";
import { getLogs, type LogPage } from "~/lib/logs";
import {
  formatCost,
  formatTokens,
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
  updateObservabilityConfig,
} from "~/lib/observability";
import { EMPTY_RESOURCE_USAGE, getResources, type ResourceUsage } from "~/lib/resources";
import { getBusinessProfile } from "~/lib/settings";
import { cn } from "~/lib/utils";

const RANGES: { key: SummaryRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

export async function clientLoader() {
  const [initial, config, recent, logs, resources, profile] = await Promise.all([
    getObservabilitySummary("7d"),
    getObservabilityConfig(),
    getRecentTurns(25),
    // Tolerated rather than awaited strictly: the log spine is the newest surface here, and a
    // failure to read it must not blank the reliability dashboard the page primarily exists to show.
    getLogs({ limit: 50 }).catch((): LogPage => ({ items: [], nextCursor: null })),
    // Same tolerance, same reason: resource samples are supplementary to the reliability view.
    getResources("1h").catch((): ResourceUsage => EMPTY_RESOURCE_USAGE),
    getBusinessProfile(),
  ]);
  return {
    initial,
    config,
    recent,
    logs,
    resources,
    businessCurrency: profile.businessCurrency,
    businessCurrencyRate: profile.businessCurrencyRate,
  };
}

export default function SettingsObservability() {
  const { initial, config, recent, logs, resources, businessCurrency, businessCurrencyRate } =
    useLoaderData<typeof clientLoader>();
  const toDisplay = (usd: number) => usd * businessCurrencyRate;
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

  const { totals, reliability } = summary;

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
                "cursor-pointer rounded-sm border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
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
      <div className="grid grid-cols-3 gap-3">
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

      <ResourcesPanel initial={resources} />

      <LogsPanel initial={logs} />

      <RecentTurnsPanel recent={recent} businessCurrency={businessCurrency} toDisplay={toDisplay} />

      <GrafanaExportPanel config={config} />
    </div>
  );
}

function RecentTurnsPanel({
  recent,
  businessCurrency,
  toDisplay,
}: {
  recent: RecentTurn[];
  businessCurrency: string;
  toDisplay: (usd: number) => number;
}) {
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
              <TraceRow
                key={`${e.type}-${e.ts}-${i}`}
                e={e}
                businessCurrency={businessCurrency}
                toDisplay={toDisplay}
              />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No trace events for this conversation.</p>
        )}
      </Sheet>
    </Panel>
  );
}

function TraceRow({
  e,
  businessCurrency,
  toDisplay,
}: {
  e: TraceEvent;
  businessCurrency: string;
  toDisplay: (usd: number) => number;
}) {
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
          <span className="text-xs capitalize text-muted-foreground">{e.type}</span>
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
          {e.costUsd != null ? (
            <span>{formatCost(toDisplay(e.costUsd), businessCurrency)}</span>
          ) : null}
          {e.durationMs != null ? <span>{e.durationMs} ms</span> : null}
        </span>
      </span>
    </li>
  );
}

function GrafanaExportPanel({ config }: { config: ObsConfigStatus }) {
  const [current, setCurrent] = useState(config);
  const [enabled, setEnabled] = useState(config.enabled);
  const [otlpConfigured, setOtlpConfigured] = useState(config.otlpConfigured);
  const [endpoint, setEndpoint] = useState(config.endpoint ?? "");
  const [instanceId, setInstanceId] = useState(config.instanceId ?? "");
  const [tokenRef, setTokenRef] = useState("");
  const [retentionDays, setRetentionDays] = useState(String(config.retentionDays));
  const [captureContent, setCaptureContent] = useState(config.captureContent);
  const [spendAlertUsd, setSpendAlertUsd] = useState(
    config.spendAlertUsd === null ? "" : String(config.spendAlertUsd)
  );
  const [pricingOverrides, setPricingOverrides] = useState(
    JSON.stringify(config.pricingOverrides, null, 2)
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (current.baseCommit === null) {
      setResult({ tone: "error", message: "Config writing is not available." });
      return;
    }

    let parsedOverrides: Record<string, { in: number; out: number }>;
    try {
      const parsed = JSON.parse(pricingOverrides) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Price overrides must be a JSON object.");
      }
      parsedOverrides = parsed as Record<string, { in: number; out: number }>;
    } catch (error) {
      setResult({
        tone: "error",
        message: error instanceof Error ? error.message : "Price overrides are invalid.",
      });
      return;
    }

    setSaving(true);
    setResult(null);
    try {
      const saved = await updateObservabilityConfig({
        baseCommit: current.baseCommit,
        enabled,
        retentionDays: Number(retentionDays),
        captureContent,
        spendAlertUsd: spendAlertUsd.trim() === "" ? null : Number(spendAlertUsd),
        otlp: otlpConfigured
          ? {
              endpoint,
              instanceId,
              ...(tokenRef.trim() === "" ? {} : { tokenRef: tokenRef.trim() }),
            }
          : null,
        pricingOverrides: parsedOverrides,
      });
      setCurrent((value) => ({
        ...value,
        enabled,
        otlpConfigured,
        endpoint: otlpConfigured ? endpoint : null,
        instanceId: otlpConfigured ? instanceId : null,
        retentionDays: Number(retentionDays),
        captureContent,
        spendAlertUsd: spendAlertUsd.trim() === "" ? null : Number(spendAlertUsd),
        pricingOverrides: parsedOverrides,
        baseCommit: saved.commitSha,
        exporterActive: saved.exporterActive,
        restartRequired: saved.restartRequired,
      }));
      setTokenRef("");
      setResult(
        saved.published
          ? {
              tone: "success",
              message: saved.restartRequired
                ? "Saved. Restart the API and Worker to apply exporter settings."
                : "Saved. Running services already match this configuration.",
            }
          : {
              tone: "error",
              message: `Saved, but publication failed: ${saved.publicationError ?? "unknown error"}`,
            }
      );
    } catch (error) {
      setResult({
        tone: "error",
        message: error instanceof ApiError ? error.message : "Failed to save observability config.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Grafana Cloud export">
      <form className="flex flex-col gap-4 text-sm" onSubmit={save}>
        <fieldset disabled={saving} className="contents">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-block size-2 rounded-full",
                current.exporterActive ? "bg-primary" : "bg-muted-foreground"
              )}
              aria-hidden
            />
            <span className="text-foreground">
              Exporter is{" "}
              <span className="font-bold">
                {current.exporterActive ? "running" : "not running"}
              </span>
            </span>
          </div>
          {current.restartRequired ? (
            <FormStatus tone="error">
              Saved settings differ from the running services. Restart the API and Worker to apply
              them.
            </FormStatus>
          ) : null}
          {result ? <FormStatus tone={result.tone}>{result.message}</FormStatus> : null}

          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
            Enable OTLP export after restart
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={otlpConfigured}
              onChange={(event) => setOtlpConfigured(event.currentTarget.checked)}
            />
            Configure an OTLP destination
          </label>

          {otlpConfigured ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <ConfigInput
                label="OTLP endpoint"
                value={endpoint}
                onChange={setEndpoint}
                placeholder="https://otlp.example.com/otlp"
                type="url"
              />
              <ConfigInput label="Instance ID" value={instanceId} onChange={setInstanceId} />
              <div className="sm:col-span-2">
                <ConfigInput
                  label="Token reference"
                  value={tokenRef}
                  onChange={setTokenRef}
                  placeholder={
                    current.otlpConfigured
                      ? "Leave blank to keep the saved reference"
                      : "secret://grafana-otlp-token"
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Use <code>secret://name</code> or <code>env://VARIABLE</code>. Plain tokens are
                  rejected.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <ConfigInput
              label="Retention days"
              value={retentionDays}
              onChange={setRetentionDays}
              type="number"
              min="1"
              max="3650"
            />
            <ConfigInput
              label="24-hour spend alert (USD)"
              value={spendAlertUsd}
              onChange={setSpendAlertUsd}
              type="number"
              min="0"
              step="0.01"
              placeholder="No alert"
            />
          </div>

          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              checked={captureContent}
              onChange={(event) => setCaptureContent(event.currentTarget.checked)}
            />
            Capture prompt, completion, and Tool content
          </label>
          <p className="-mt-2 text-xs text-muted-foreground">
            Keep this off unless your data policy allows business content in telemetry.
          </p>

          <label className="flex flex-col gap-1 text-foreground">
            Model price overrides (USD per 1M tokens)
            <textarea
              value={pricingOverrides}
              onChange={(event) => setPricingOverrides(event.currentTarget.value)}
              rows={5}
              spellCheck={false}
              className="rounded-sm border border-border bg-background px-2.5 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
          </label>

          <div>
            <button
              type="submit"
              disabled={saving || current.baseCommit === null}
              className="cursor-pointer rounded-sm bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save configuration"}
            </button>
          </div>
        </fieldset>
      </form>
    </Panel>
  );
}

function ConfigInput({
  label,
  value,
  onChange,
  type = "text",
  ...inputProps
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  step?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-foreground">
      {label}
      <input
        {...inputProps}
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="rounded-sm border border-border bg-background px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
    </label>
  );
}

function MetricCard({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-sm border border-border px-3 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
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
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", danger && "text-destructive")}>
        {value}
      </p>
      {sub ? <p className="text-xs tabular-nums text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function EmptyHint() {
  return <PanelEmpty>No activity in this window yet.</PanelEmpty>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  // The API enforces admin-only reads here. "403 forbidden" names the mechanism, not the reason.
  if (status === 403) {
    return <FormStatus tone="error">Only an admin can see observability.</FormStatus>;
  }
  return <ErrorState section="business" status={status} message={message} />;
}
