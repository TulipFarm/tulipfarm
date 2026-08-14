import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChartCanvas } from "~/components/observability/chart-canvas";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import {
  formatBucketLabel,
  formatBytes,
  formatCpuPct,
  getResources,
  RESOURCE_WINDOWS,
  type ResourceMetric,
  type ResourceUsage,
  type ResourceWindow,
} from "~/lib/resources";
import { cn } from "~/lib/utils";

/** Matches the sampling cadence: refreshing faster only re-fetches points that cannot have moved. */
const REFRESH_MS = 60_000;

const METRICS: { key: ResourceMetric; label: string }[] = [
  { key: "cpu", label: "CPU" },
  { key: "memory", label: "Memory" },
];

/**
 * The two metrics share a chart but not an axis — percent and bytes have no common scale, and
 * plotting them together would make one of them unreadable — so a toggle swaps which is shown.
 */
export function ResourcesPanel({ initial }: { initial: ResourceUsage }) {
  const [usage, setUsage] = useState<ResourceUsage>(initial);
  const [window_, setWindow] = useState<ResourceWindow>(initial.window);
  const [metric, setMetric] = useState<ResourceMetric>("cpu");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  const load = useCallback(async (next: ResourceWindow): Promise<void> => {
    const id = ++req.current;
    setLoading(true);
    try {
      const data = await getResources(next);
      if (id !== req.current) return;
      setUsage(data);
      setError(null);
    } catch (e) {
      if (id !== req.current) return;
      setError(e instanceof ApiError ? e.message : "Could not load resource usage.");
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(window_);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, window_]);

  function applyWindow(next: ResourceWindow): void {
    setWindow(next);
    void load(next);
  }

  const isCpu = metric === "cpu";
  const format = isCpu ? formatCpuPct : formatBytes;
  const data = {
    labels: usage.buckets.map(formatBucketLabel),
    series: usage.series.map((s) => ({
      label: s.service,
      values: isCpu ? s.cpuPct : s.rssBytes,
    })),
  };

  return (
    <Panel
      title="Resource usage"
      description={
        isCpu
          ? "CPU per service, as a percentage of one core — a process saturating two cores reads 200%."
          : "Resident memory per service."
      }
      actions={
        <button
          type="button"
          onClick={() => void load(window_)}
          disabled={loading}
          aria-label="Refresh resource usage"
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              "size-3.5",
              loading && "motion-safe:animate-spin motion-reduce:opacity-70"
            )}
          />
        </button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          label="Metric"
          options={METRICS.map((m) => m.key)}
          labels={METRICS.map((m) => m.label)}
          value={metric}
          onChange={(next) => setMetric(next as ResourceMetric)}
        />
        <ToggleGroup
          label="Time window"
          options={RESOURCE_WINDOWS}
          labels={RESOURCE_WINDOWS}
          value={window_}
          onChange={(next) => applyWindow(next as ResourceWindow)}
        />
      </div>

      {error ? (
        <p className="mt-4 rounded-sm bg-run-error/10 px-3 py-2 text-run-error text-sm">{error}</p>
      ) : null}

      {usage.series.length === 0 && !error ? (
        <div className="mt-4">
          <PanelEmpty>
            No samples in this window. Services record CPU and memory once a minute, so a freshly
            started process takes a couple of minutes to appear.
          </PanelEmpty>
        </div>
      ) : (
        <div className={cn("mt-4", loading && "opacity-60 transition-opacity")}>
          <ChartCanvas
            kind="line"
            data={data}
            formatValue={format}
            ariaLabel={
              isCpu ? "CPU usage per service over time" : "Memory usage per service over time"
            }
          />
        </div>
      )}
    </Panel>
  );
}

function ToggleGroup({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  labels: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {options.map((option, i) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "cursor-pointer rounded-sm border px-2 py-1 text-xs transition-colors",
            value === option
              ? "border-primary text-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );
}
