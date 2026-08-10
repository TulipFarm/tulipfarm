import type { TooltipItem } from "chart.js";
import { describe, expect, it } from "vitest";
import { buildChartConfig, type ChartColors } from "./chart-canvas";

const colors: ChartColors = {
  primary: "primary",
  muted: "muted",
  border: "border",
  data: ["c1", "c2", "c3"],
};

function build(datasets: { label: string; values: (number | null)[] }[], kind: "line" | "bar") {
  return buildChartConfig({
    kind,
    labels: ["20:01", "20:02"],
    datasets,
    formatValue: (n) => `${n}%`,
    colors,
  });
}

const single = [{ label: "", values: [1, 2] }];
const multi = [
  { label: "api", values: [1, null] },
  { label: "worker", values: [3, 4] },
];

// A tooltip item is only partially constructed here; the callbacks under test read `raw`,
// `parsed.y` and `dataset.label`, which is all this needs to supply.
function item(raw: unknown, y: number | null, label: string) {
  return { raw, parsed: { y }, dataset: { label } } as unknown as TooltipItem<"line">;
}

// `ChartConfiguration` types datasets as a union across every chart type, which hides line-only
// options such as `pointRadius`. The values are present at runtime; this just reaches them.
function dsOpts(dataset: unknown): Record<string, unknown> {
  return dataset as Record<string, unknown>;
}

describe("buildChartConfig", () => {
  describe("hover", () => {
    it("uses index mode without requiring intersection, so an invisible point is still hoverable", () => {
      // `pointRadius: 0` means there is no marker to land on. With chart.js's default
      // `intersect: true` the chart would have no reachable hover target whatsoever.
      const opts = build(multi, "line").options;
      expect(opts?.interaction).toEqual({ mode: "index", intersect: false });
    });

    it("keeps points invisible at rest but renders them under the cursor", () => {
      const ds = dsOpts(build(single, "line").data.datasets[0]);
      expect(ds.pointRadius).toBe(0);
      expect(ds.pointHoverRadius).toBe(4);
    });

    it("hides a bucket the series reported nothing for instead of showing it as zero", () => {
      const filter = build(multi, "line").options?.plugins?.tooltip?.filter;
      expect(filter?.(item(null, null, "api"), 0, [], { datasets: [] })).toBe(false);
      expect(filter?.(item(undefined, null, "api"), 0, [], { datasets: [] })).toBe(false);
      expect(filter?.(item(0, 0, "api"), 0, [], { datasets: [] })).toBe(true);
      expect(filter?.(item(3, 3, "worker"), 0, [], { datasets: [] })).toBe(true);
    });

    it("names the series in a multi-series tooltip and omits the name when there is only one", () => {
      const label = (sets: typeof multi) =>
        build(sets, "line").options?.plugins?.tooltip?.callbacks?.label;

      const multiLabel = label(multi);
      expect(multiLabel?.call({} as never, item(3, 3, "worker"))).toBe("worker: 3%");

      const singleLabel = label(single);
      expect(singleLabel?.call({} as never, item(1, 1, ""))).toBe("1%");
    });
  });

  describe("series", () => {
    it("assigns a distinct palette colour per series when there are several", () => {
      const sets = build(multi, "line").data.datasets;
      expect(sets.map((d) => d.borderColor)).toEqual(["c1", "c2"]);
    });

    it("uses the primary colour for a lone series and shows no legend", () => {
      const cfg = build(single, "line");
      expect(cfg.data.datasets[0].borderColor).toBe("primary");
      expect(cfg.options?.plugins?.legend?.display).toBe(false);
    });

    it("shows a legend only once there is more than one series to tell apart", () => {
      expect(build(multi, "line").options?.plugins?.legend?.display).toBe(true);
    });

    it("never bridges a gap, so an outage cannot render as healthy activity", () => {
      for (const ds of build(multi, "line").data.datasets) {
        expect(dsOpts(ds).spanGaps).toBe(false);
      }
    });

    it("wraps back around the palette rather than running off the end of it", () => {
      const many = Array.from({ length: 4 }, (_, i) => ({ label: `s${i}`, values: [i] }));
      expect(build(many, "line").data.datasets.map((d) => d.borderColor)).toEqual([
        "c1",
        "c2",
        "c3",
        "c1",
      ]);
    });
  });

  it("formats axis ticks with the caller's formatter", () => {
    const cfg = build(single, "line");
    const tick = cfg.options?.scales?.y?.ticks?.callback;
    expect(tick?.call({} as never, 12, 0, [])).toBe("12%");
  });

  it("fills bars but not lines", () => {
    expect(build(single, "bar").data.datasets[0].backgroundColor).toBe("primary");
    expect(build(single, "line").data.datasets[0].backgroundColor).toBe("transparent");
  });
});
