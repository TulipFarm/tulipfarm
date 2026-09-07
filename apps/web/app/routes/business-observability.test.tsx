import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { getLogs } from "~/lib/logs";
import {
  getObservabilityConfig,
  getObservabilitySummary,
  getRecentTurns,
  updateObservabilityConfig,
} from "~/lib/observability";
import { getResources } from "~/lib/resources";
import { getBusinessProfile } from "~/lib/settings";
import SettingsObservability, { clientLoader } from "./_app.business.observability";

vi.mock("~/lib/logs", async () => {
  const actual = await vi.importActual<typeof import("~/lib/logs")>("~/lib/logs");
  return { ...actual, getLogs: vi.fn() };
});
vi.mock("~/lib/resources", async () => {
  const actual = await vi.importActual<typeof import("~/lib/resources")>("~/lib/resources");
  return { ...actual, getResources: vi.fn() };
});
vi.mock("~/lib/settings", () => ({ getBusinessProfile: vi.fn() }));
vi.mock("~/lib/observability", async () => {
  const actual = await vi.importActual<typeof import("~/lib/observability")>("~/lib/observability");
  return {
    ...actual,
    getObservabilityConfig: vi.fn(),
    getObservabilitySummary: vi.fn(),
    getRecentTurns: vi.fn(),
    updateObservabilityConfig: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getObservabilitySummary).mockResolvedValue({
    totals: { cost: 0, tokens: 0, turns: 0, unpricedCalls: 0 },
    series: [],
    byAgent: [],
    byMember: [],
    byModel: [],
    modelSeries: [],
    reliability: {
      turns: 0,
      turnErrors: 0,
      llmCalls: 0,
      llmErrors: 0,
      fallbacks: 0,
      toolCalls: 0,
      toolErrors: 0,
      p95DurationMs: 0,
    },
  });
  vi.mocked(getObservabilityConfig).mockResolvedValue({
    enabled: true,
    otlpConfigured: true,
    endpoint: "https://otlp.example.test/otlp",
    instanceId: "123",
    retentionDays: 30,
    captureContent: false,
    spendAlertUsd: null,
    pricingOverrides: {},
    baseCommit: "base-sha",
    exporterActive: false,
    restartRequired: true,
  });
  vi.mocked(getRecentTurns).mockResolvedValue([]);
  vi.mocked(getLogs).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(getResources).mockResolvedValue({
    window: "1h",
    bucketSeconds: 60,
    buckets: [],
    series: [],
  });
  vi.mocked(getBusinessProfile).mockResolvedValue({
    name: "TulipFarm",
    description: "",
    website: "",
    businessCurrency: "USD",
    businessCurrencyRate: 1,
  });
});

test("shows saved exporter settings separately from the running exporter state", async () => {
  const Stub = createRemixStub([
    { path: "/", Component: SettingsObservability, loader: clientLoader },
  ]);
  render(<Stub initialEntries={["/"]} />);

  expect(await screen.findByText(/Exporter is/)).toHaveTextContent("not running");
  expect(screen.getByText(/Saved settings differ from the running services/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  expect(screen.queryByText(/edit.*observability\.config\.yaml/i)).toBeNull();
});

test("locks edits during save and does not show the new destination as already running", async () => {
  vi.mocked(getObservabilityConfig).mockResolvedValue({
    ...(await getObservabilityConfig()),
    exporterActive: true,
    restartRequired: false,
  });
  vi.mocked(updateObservabilityConfig).mockResolvedValue({
    commitSha: "next-sha",
    published: true,
    exporterActive: true,
    restartRequired: true,
  });
  const Stub = createRemixStub([
    { path: "/", Component: SettingsObservability, loader: clientLoader },
  ]);
  render(<Stub initialEntries={["/"]} />);

  fireEvent.change(await screen.findByLabelText("OTLP endpoint"), {
    target: { value: "https://next.example.test/otlp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  expect(screen.getByLabelText("Token reference")).toBeDisabled();

  expect(
    await screen.findByText("Saved. Restart the API and Worker to apply exporter settings.")
  ).toBeVisible();
  expect(updateObservabilityConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      baseCommit: "base-sha",
      otlp: { endpoint: "https://next.example.test/otlp", instanceId: "123" },
    })
  );
  expect(screen.getByLabelText("Token reference")).toBeEnabled();
  expect(screen.queryByText(/next\.example\.test/)).toBeNull();
});
