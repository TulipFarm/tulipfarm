import { Chart, type ChartConfiguration } from "chart.js/auto";
import { useEffect, useRef } from "react";

/** Resolve a theme CSS variable (oklch) to a concrete color string for canvas drawing. */
function themeColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export type Series = { labels: string[]; values: number[] };

/**
 * Minimal first-party chart.js canvas (line or bar) for the observability dashboard. Owns the Chart
 * lifecycle (create on mount/data change, destroy on cleanup) so there are no leaked instances. Flat
 * styling, ruby for the data series, muted axes — consistent with the design language.
 */
export function ChartCanvas({
  kind,
  data,
  formatValue,
  ariaLabel,
}: {
  kind: "line" | "bar";
  data: Series;
  formatValue?: (n: number) => string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const sig = `${data.labels.join("|")}::${data.values.join(",")}`;

  // Keyed on data *content* (`sig`), not the object identity (a fresh literal every render), so the
  // chart rebuilds only when the series actually changes — not on every parent re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: data is captured via `sig`.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const primary = themeColor("--primary", "oklch(0.55 0.21 18)");
    const muted = themeColor("--muted-foreground", "#888");
    const border = themeColor("--border", "#3334");
    const fmt = formatValue ?? ((n: number) => String(n));

    const config: ChartConfiguration = {
      type: kind,
      data: {
        labels: data.labels,
        datasets: [
          {
            data: data.values,
            borderColor: primary,
            backgroundColor: kind === "bar" ? primary : "transparent",
            borderWidth: kind === "line" ? 2 : 0,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            maxBarThickness: 28,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => fmt(c.parsed.y ?? 0) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: muted, font: { size: 10 } } },
          y: {
            grid: { color: border },
            ticks: { color: muted, font: { size: 10 }, callback: (v) => fmt(Number(v)) },
            beginAtZero: true,
          },
        },
      },
    };
    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [kind, sig, formatValue]);

  return (
    <div className="h-56 w-full">
      <canvas ref={ref} aria-label={ariaLabel} role="img" />
    </div>
  );
}
