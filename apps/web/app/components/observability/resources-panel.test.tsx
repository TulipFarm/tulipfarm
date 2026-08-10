import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceUsage } from "~/lib/resources";
import { ResourcesPanel } from "./resources-panel";

vi.mock("~/lib/resources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/resources")>()),
  getResources: vi.fn(),
}));

// jsdom has no canvas 2d context, so chart.js cannot instantiate. The chart's own behaviour is not
// under test here — what is, is the data the panel hands it.
vi.mock("~/components/observability/chart-canvas", () => ({
  ChartCanvas: ({
    data,
    formatValue,
    ariaLabel,
  }: {
    data: { labels: string[]; series: { label: string; values: (number | null)[] }[] };
    formatValue?: (n: number) => string;
    ariaLabel: string;
  }) => (
    <div
      data-testid="chart"
      data-aria-label={ariaLabel}
      data-labels={data.labels.join("|")}
      data-series={data.series.map((s) => `${s.label}=${s.values.join(",")}`).join(";")}
      data-formatted={formatValue ? formatValue(1024 * 1024 * 100) : ""}
    />
  ),
}));

import { getResources } from "~/lib/resources";

function usage(overrides: Partial<ResourceUsage> = {}): ResourceUsage {
  return {
    window: "1h",
    bucketSeconds: 60,
    buckets: ["2025-01-01T09:00:00.000Z", "2025-01-01T09:01:00.000Z"],
    series: [
      { service: "api", cpuPct: [10, 20], rssBytes: [1000, 2000] },
      { service: "worker", cpuPct: [30, null], rssBytes: [3000, null] },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getResources).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders the samples it was given without fetching", () => {
  render(<ResourcesPanel initial={usage()} />);

  const chart = screen.getByTestId("chart");
  expect(chart).toHaveAttribute("data-series", "api=10,20;worker=30,");
  expect(getResources).not.toHaveBeenCalled();
});

test("shows CPU first and swaps the whole dataset on the metric toggle", async () => {
  const user = userEvent.setup();
  render(<ResourcesPanel initial={usage()} />);

  expect(screen.getByTestId("chart")).toHaveAttribute(
    "data-aria-label",
    "CPU usage per service over time"
  );

  await user.click(screen.getByRole("button", { name: "Memory" }));

  const chart = screen.getByTestId("chart");
  expect(chart).toHaveAttribute("data-series", "api=1000,2000;worker=3000,");
  expect(chart).toHaveAttribute("data-aria-label", "Memory usage per service over time");
  // The formatter must swap with the metric, or bytes render as a percentage.
  expect(chart).toHaveAttribute("data-formatted", "100 MB");
  // Switching metric re-reads data already loaded; it must not cost a request.
  expect(getResources).not.toHaveBeenCalled();
});

test("carries a null through as a gap rather than a zero", () => {
  render(<ResourcesPanel initial={usage()} />);
  // "30," — the trailing empty is the null. A 0 here would draw an outage as an idle process.
  expect(screen.getByTestId("chart").getAttribute("data-series")).toContain("worker=30,");
});

test("refetches when the window changes", async () => {
  const user = userEvent.setup();
  vi.mocked(getResources).mockResolvedValue(
    usage({
      window: "6h",
      bucketSeconds: 300,
      buckets: ["2025-01-01T09:00:00.000Z"],
      series: [{ service: "api", cpuPct: [55], rssBytes: [5000] }],
    })
  );

  render(<ResourcesPanel initial={usage()} />);
  await user.click(screen.getByRole("button", { name: "6h" }));

  expect(getResources).toHaveBeenCalledWith("6h");
  expect(await screen.findByTestId("chart")).toHaveAttribute("data-series", "api=55");
});

test("surfaces a failed refresh without discarding the samples already on screen", async () => {
  const user = userEvent.setup();
  vi.mocked(getResources).mockRejectedValue(new Error("boom"));

  render(<ResourcesPanel initial={usage()} />);
  await user.click(screen.getByRole("button", { name: "24h" }));

  expect(await screen.findByText("Could not load resource usage.")).toBeInTheDocument();
  expect(screen.getByTestId("chart")).toHaveAttribute("data-series", "api=10,20;worker=30,");
});

test("explains the empty state instead of rendering a blank chart", () => {
  render(<ResourcesPanel initial={usage({ buckets: [], series: [] })} />);

  expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  expect(screen.getByText(/No samples in this window/)).toBeInTheDocument();
});

test("auto-refreshes on the sampling cadence", async () => {
  vi.useFakeTimers();
  vi.mocked(getResources).mockResolvedValue(usage());

  render(<ResourcesPanel initial={usage()} />);
  expect(getResources).not.toHaveBeenCalled();

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(getResources).toHaveBeenCalledWith("1h");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(getResources).toHaveBeenCalledTimes(2);
});

test("skips the auto-refresh while the tab is hidden", async () => {
  vi.useFakeTimers();
  vi.mocked(getResources).mockResolvedValue(usage());
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

  render(<ResourcesPanel initial={usage()} />);
  await act(() => vi.advanceTimersByTimeAsync(180_000));
  expect(getResources).not.toHaveBeenCalled();

  hidden.mockReturnValue(false);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(getResources).toHaveBeenCalledTimes(1);
});

test("stops polling once unmounted", async () => {
  vi.useFakeTimers();
  vi.mocked(getResources).mockResolvedValue(usage());

  const { unmount } = render(<ResourcesPanel initial={usage()} />);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(180_000));
  expect(getResources).not.toHaveBeenCalled();
});
