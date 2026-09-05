import { useLoaderData, useRouteError } from "@remix-run/react";
import { useRef, useState } from "react";
import { FormStatus } from "~/components/form-status";
import { ChartCanvas, type MultiSeries } from "~/components/observability/chart-canvas";
import { ErrorState } from "~/components/states";
import { Link } from "~/components/ui/link";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ApiError } from "~/lib/api";
import {
  formatCost,
  getObservabilitySummary,
  type ObsSummary,
  type SummaryRange,
} from "~/lib/observability";
import { getBusinessProfile } from "~/lib/settings";
import { cn } from "~/lib/utils";

const RANGES: { key: SummaryRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const TABS = [
  { id: "summary", label: "Summary", disabled: false },
  { id: "model", label: "By Model", disabled: false },
  { id: "agents", label: "By Agents", disabled: false },
  { id: "members", label: "By Members", disabled: false },
  { id: "team", label: "Team", disabled: true },
] as const;

/** Bucket label: hour-of-day for 24h, month/day otherwise. */
function bucketLabel(iso: string, range: SummaryRange): string {
  const d = new Date(iso);
  return range === "24h"
    ? d.toLocaleTimeString(undefined, { hour: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Palette is an 8-color closed set (see chart-canvas.tsx); cap at 7 named models plus "Other" so a
 * legend never grows past what the palette can distinguish. */
const MAX_NAMED_MODELS = 7;

/** Pivots flat (bucket, model, cost) rows into one stacked series per model, folding every model
 * past the palette cap into a single "Other" series so the legend stays readable. */
function buildModelSeries(
  modelSeries: ObsSummary["modelSeries"],
  range: SummaryRange
): MultiSeries {
  const buckets = Array.from(new Set(modelSeries.map((r) => r.bucket))).sort();
  const totalsByModel = new Map<string, number>();
  for (const r of modelSeries) {
    totalsByModel.set(r.model, (totalsByModel.get(r.model) ?? 0) + r.cost);
  }
  const topModels = [...totalsByModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NAMED_MODELS)
    .map(([model]) => model);
  const topSet = new Set(topModels);
  const hasOther = [...totalsByModel.keys()].some((model) => !topSet.has(model));
  const modelOrder = hasOther ? [...topModels, "Other"] : topModels;

  const grid = new Map<string, Map<string, number>>();
  for (const bucket of buckets) grid.set(bucket, new Map());
  for (const r of modelSeries) {
    const label = topSet.has(r.model) ? r.model : "Other";
    const row = grid.get(r.bucket);
    if (!row) continue;
    row.set(label, (row.get(label) ?? 0) + r.cost);
  }

  return {
    labels: buckets.map((b) => bucketLabel(b, range)),
    series: modelOrder.map((model) => ({
      label: model,
      values: buckets.map((b) => grid.get(b)?.get(model) ?? 0),
    })),
  };
}

export async function clientLoader() {
  const [initial, profile] = await Promise.all([
    getObservabilitySummary("7d"),
    getBusinessProfile(),
  ]);
  return {
    initial,
    businessCurrency: profile.businessCurrency,
    businessCurrencyRate: profile.businessCurrencyRate,
  };
}

export default function SettingsCost() {
  const { initial, businessCurrency, businessCurrencyRate } = useLoaderData<typeof clientLoader>();
  const toDisplay = (usd: number) => usd * businessCurrencyRate;
  const formatDisplay = (usd: number) => formatCost(toDisplay(usd), businessCurrency);
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

  const { totals, series, byAgent, byMember, byModel, modelSeries } = summary;
  const modelSeriesData = buildModelSeries(modelSeries, range);
  const hasModelSeries = modelSeriesData.series.some((s) => s.values.some((v) => (v ?? 0) > 0));

  return (
    <div className={cn("flex flex-col gap-6", loading && "opacity-60 transition-opacity")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Costs shown in {businessCurrency}. Change the currency or rate in{" "}
          <Link
            to="/business/profile"
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            Business profile
          </Link>
          .
        </p>
        <nav className="flex shrink-0 gap-2">
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

      <Tabs defaultValue="summary">
        <TabsList aria-label="Cost breakdown">
          {TABS.map((candidate) => (
            <TabsTrigger key={candidate.id} value={candidate.id} disabled={candidate.disabled}>
              {candidate.label}
              {candidate.disabled ? (
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground/70">
                  Soon
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="summary" className="flex flex-col gap-6">
          {/* Headline metric card */}
          <div className="grid grid-cols-1 gap-3 sm:w-56">
            <MetricCard label="Spend" value={formatDisplay(totals.cost)} />
          </div>

          {/* Spend over time */}
          <Panel title="Spend over time">
            {series.length === 0 ? (
              <EmptyHint />
            ) : (
              <ChartCanvas
                kind="line"
                ariaLabel="Spend over time"
                formatValue={formatDisplay}
                data={{
                  labels: series.map((p) => bucketLabel(p.bucket, range)),
                  values: series.map((p) => p.cost),
                }}
              />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="model" className="flex flex-col gap-6">
          {/* Spend by model, over time */}
          <Panel title="Spend by model">
            {!hasModelSeries ? (
              <EmptyHint />
            ) : (
              <ChartCanvas
                kind="bar"
                stacked
                ariaLabel="Spend by model over time"
                formatValue={formatDisplay}
                data={modelSeriesData}
              />
            )}
          </Panel>

          {/* By model */}
          <Panel title="By model">
            {byModel.length === 0 ? (
              <EmptyHint />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border border-b text-left text-xs text-muted-foreground">
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
                          <span className="flex flex-col items-end gap-0.5">
                            unpriced
                            <span className="text-xs text-muted-foreground/70">
                              (add a pricing override in observability.config.yaml)
                            </span>
                          </span>
                        ) : (
                          formatDisplay(m.cost)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="agents">
          <Panel title="Spend by agent">
            {byAgent.length === 0 ? (
              <EmptyHint />
            ) : (
              <SpendBarList
                rows={byAgent.map((a) => ({ id: a.agentId, label: a.agentId, cost: a.cost }))}
                formatValue={formatDisplay}
              />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="members">
          <Panel title="Spend by member">
            {byMember.length === 0 ? (
              <EmptyHint />
            ) : (
              <SpendBarList
                rows={byMember.map((m) => ({ id: m.memberId, label: m.member, cost: m.cost }))}
                formatValue={formatDisplay}
              />
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="team">
          <Panel title="By team">
            <EmptyHint />
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SpendBarList({
  rows,
  formatValue,
}: {
  rows: Array<{ id: string; label: string; cost: number }>;
  formatValue: (usd: number) => string;
}) {
  const maxCost = Math.max(1e-9, ...rows.map((r) => r.cost));
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-sm text-foreground sm:w-44" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-sm bg-muted/40">
            <span
              className="block h-full bg-primary"
              style={{ width: `${Math.max(2, (r.cost / maxCost) * 100)}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
            {formatValue(r.cost)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border px-4 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{value}</p>
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
    return <FormStatus tone="error">Only an admin can see cost.</FormStatus>;
  }
  return <ErrorState section="business" status={status} message={message} />;
}
