import { Chart, type ChartConfiguration } from "chart.js/auto";
import { useEffect, useRef } from "react";

/** Resolve a theme CSS variable (oklch) to a concrete color string for canvas drawing. */
function themeColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export type Series = { labels: string[]; values: number[] };

/** `null` is a real missing bucket and must break the line, not interpolate. */
export type MultiSeries = {
  labels: string[];
  series: { label: string; values: (number | null)[] }[];
};

/** The closed categorical palette. Beyond eight datasets colours would have to repeat, and a chart
 * with nine indistinguishable lines is not one anybody reads, so the design system stops here. */
const DATA_TOKENS = [
  "--data-1",
  "--data-2",
  "--data-3",
  "--data-4",
  "--data-5",
  "--data-6",
  "--data-7",
  "--data-8",
] as const;

const DATA_FALLBACKS = [
  "oklch(0.55 0.13 250)",
  "oklch(0.56 0.13 160)",
  "oklch(0.6 0.13 65)",
  "oklch(0.55 0.14 320)",
  "oklch(0.58 0.12 200)",
  "oklch(0.56 0.14 30)",
  "oklch(0.57 0.11 120)",
  "oklch(0.52 0.1 285)",
];

function isMulti(data: Series | MultiSeries): data is MultiSeries {
  return "series" in data;
}

export type ChartColors = {
  primary: string;
  muted: string;
  border: string;
  data: readonly string[];
};

/** Pure builder keeps chart readability options testable without a jsdom canvas. */
export function buildChartConfig({
  kind,
  labels,
  datasets,
  formatValue,
  colors,
  stacked,
}: {
  kind: "line" | "bar";
  labels: string[];
  datasets: { label: string; values: (number | null)[] }[];
  formatValue?: (n: number) => string;
  colors: ChartColors;
  /** Bar-only: stack datasets into one column per bucket instead of drawing them side by side. */
  stacked?: boolean;
}): ChartConfiguration {
  const fmt = formatValue ?? ((n: number) => String(n));
  const multi = datasets.length > 1;

  return {
    type: kind,
    data: {
      labels,
      datasets: datasets.map((series, i) => {
        const color = multi
          ? (colors.data[i % colors.data.length] ?? colors.primary)
          : colors.primary;
        return {
          label: series.label,
          data: series.values,
          borderColor: color,
          backgroundColor: kind === "bar" ? color : "transparent",
          borderWidth: kind === "line" ? 2 : 0,
          pointRadius: 0,
          // Points are invisible at rest but must materialise under the cursor, otherwise there is
          // no feedback about which bucket the tooltip is describing.
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBackgroundColor: color,
          tension: 0.3,
          fill: false,
          maxBarThickness: 28,
          // A missing sample means the source was silent; bridging it would draw an outage as
          // healthy activity.
          spanGaps: false,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // `pointRadius: 0` leaves nothing to intersect, so chart.js's default `intersect: true`
      // gives the chart no reachable hover target at all. Index mode keys off the x position
      // instead, which also lets one hover compare every series at the same bucket.
      interaction: { mode: "index", intersect: false },
      plugins: {
        // A single series is already named by its panel heading; a legend there is noise.
        legend: multi
          ? {
              display: true,
              position: "bottom",
              labels: {
                color: colors.muted,
                boxWidth: 8,
                boxHeight: 8,
                usePointStyle: true,
                pointStyle: "circle",
                font: { size: 11 },
              },
            }
          : { display: false },
        tooltip: {
          // Index mode would otherwise list a series that reported nothing for this bucket, and
          // `?? 0` would render its absence as a genuine zero.
          filter: (item) => item.raw !== null && item.raw !== undefined,
          callbacks: {
            label: (c) =>
              multi ? `${c.dataset.label}: ${fmt(c.parsed.y ?? 0)}` : fmt(c.parsed.y ?? 0),
          },
        },
      },
      scales: {
        x: {
          stacked: stacked === true,
          grid: { display: false },
          ticks: { color: colors.muted, font: { size: 10 } },
        },
        y: {
          stacked: stacked === true,
          grid: { color: colors.border },
          ticks: { color: colors.muted, font: { size: 10 }, callback: (v) => fmt(Number(v)) },
          beginAtZero: true,
        },
      },
    },
  };
}

/** Owns Chart lifecycle so instances are destroyed on cleanup. */
export function ChartCanvas({
  kind,
  data,
  formatValue,
  ariaLabel,
  stacked,
}: {
  kind: "line" | "bar";
  data: Series | MultiSeries;
  formatValue?: (n: number) => string;
  ariaLabel: string;
  /** Bar-only: stack datasets into one column per bucket instead of drawing them side by side. */
  stacked?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const datasets = isMulti(data)
    ? data.series
    : [{ label: "", values: data.values as (number | null)[] }];
  const sig = `${data.labels.join("|")}::${datasets
    .map((d) => `${d.label}=${d.values.join(",")}`)
    .join(";")}`;

  // Keyed on data *content* (`sig`), not the object identity (a fresh literal every render), so the
  // chart rebuilds only when the series actually changes — not on every parent re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: data is captured via `sig`.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const multi = datasets.length > 1;
    const config = buildChartConfig({
      kind,
      labels: data.labels,
      datasets,
      formatValue,
      stacked,
      colors: {
        primary: themeColor("--primary", "oklch(0.55 0.21 18)"),
        muted: themeColor("--muted-foreground", "#888"),
        border: themeColor("--border", "#3334"),
        data: multi ? DATA_TOKENS.map((t, i) => themeColor(t, DATA_FALLBACKS[i])) : [],
      },
    });
    const chart = new Chart(canvas, config);
    return () => chart.destroy();
  }, [kind, sig, formatValue, stacked]);

  const fmt = formatValue ?? ((n: number) => String(n));

  return (
    <div className="h-56 w-full">
      <canvas ref={ref} aria-label={ariaLabel} role="img" />
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>Bucket</th>
            {datasets.map((d) => (
              <th key={d.label || "value"}>{d.label || ariaLabel}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((label, i) => (
            <tr key={label}>
              <td>{label}</td>
              {datasets.map((d) => (
                <td key={d.label || "value"}>
                  {d.values[i] == null ? "—" : fmt(d.values[i] as number)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
