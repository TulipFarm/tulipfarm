import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { apiGet, apiWrite } from "~/lib/api";
import type { TelemetrySettings } from "~/lib/telemetry";
import { useIsAdmin } from "~/lib/use-session-user";
import TelemetryRoute, { clientLoader, ErrorBoundary } from "./_app.settings.telemetry";

vi.mock("~/lib/api", async () => ({
  ...(await vi.importActual<typeof import("~/lib/api")>("~/lib/api")),
  apiGet: vi.fn(),
  apiWrite: vi.fn(),
}));
vi.mock("~/lib/use-session-user", () => ({ useIsAdmin: vi.fn(() => true) }));

const initial: TelemetrySettings = {
  level: 2,
  effectiveLevel: 2,
  maxLevel: 2,
  enabled: true,
  configured: false,
  installationId: "a7094dca-f74c-49eb-b9a7-a4c008a14d89",
  bootstrapSentAt: null,
  lastSnapshotAt: null,
  preview: {
    bootstrap: {
      event_type: "instance_bootstrapped",
      data: { business_name: "Tulip Operations", version: "1.0.0" },
    },
    snapshot: { event_type: "instance_snapshot", data: { agents: 1, agent_names: ["Support"] } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue(initial);
  vi.mocked(apiWrite).mockResolvedValue({
    ...initial,
    level: 0,
    effectiveLevel: 0,
    configured: true,
    preview: { ...initial.preview, snapshot: null },
  });
  vi.mocked(useIsAdmin).mockReturnValue(true);
});

function renderRoute() {
  const Stub = createRemixStub([
    { path: "/", Component: TelemetryRoute, loader: clientLoader, ErrorBoundary },
  ]);
  render(
    <StrictMode>
      <Stub />
    </StrictMode>
  );
}

test("discloses mandatory bootstrap, paused upgraded installs and exact server payload", async () => {
  renderRoute();
  expect(await screen.findByText(/mandatory one-time bootstrap report/)).toBeInTheDocument();
  expect(screen.getByText(/daily reports are paused until you save/i)).toBeInTheDocument();
  expect(screen.getByLabelText("Bootstrap payload").textContent).toBe(
    JSON.stringify(initial.preview.bootstrap, null, 2)
  );
  expect(screen.getByLabelText("Daily payload").textContent).toBe(
    JSON.stringify(initial.preview.snapshot, null, 2)
  );
  expect(screen.getByRole("button", { name: "Save preference" })).toBeEnabled();
});

test("previews a level without saving, then sends exactly one PUT with the selected body", async () => {
  renderRoute();
  await screen.findByRole("radio", { name: /Level 0/ });
  vi.mocked(apiGet).mockResolvedValue({
    ...initial,
    effectiveLevel: 0,
    preview: { ...initial.preview, snapshot: null },
  });
  await userEvent.click(screen.getByRole("radio", { name: /Level 0/ }));
  await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith("/api/v1/system/telemetry?level=0"));
  expect(apiWrite).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Daily payload")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save preference" }));
  await waitFor(() =>
    expect(apiWrite).toHaveBeenCalledWith("PUT", "/api/v1/system/telemetry", { level: 0 })
  );
  expect(apiWrite).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Telemetry preference saved.")).toBeInTheDocument();
  expect(screen.queryByText(/daily reports are paused until you save/i)).not.toBeInTheDocument();
});

test("disables levels above the cap and displays disabled dev delivery", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    ...initial,
    maxLevel: 1,
    effectiveLevel: 1,
    enabled: false,
  });
  renderRoute();
  expect(await screen.findByRole("radio", { name: /Level 2/ })).toBeDisabled();
  expect(screen.getByRole("radio", { name: /Level 1/ })).toBeChecked();
  expect(screen.getByText(/disabled in development and tests/i)).toBeInTheDocument();
  expect(screen.getByText(/Deployment limit: Level 1/)).toBeInTheDocument();
});

test("a failed preview hides stale data, blocks saving, and offers retry", async () => {
  renderRoute();
  await screen.findByRole("radio", { name: /Level 1/ });
  vi.mocked(apiGet).mockRejectedValueOnce(new Error("Preview unavailable"));
  await userEvent.click(screen.getByRole("radio", { name: /Level 1/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview unavailable");
  expect(screen.queryByLabelText("Daily payload")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save preference" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  expect(await screen.findByLabelText("Daily payload")).toBeInTheDocument();
});

test("late responses cannot replace the most recently selected level preview", async () => {
  renderRoute();
  await screen.findByRole("radio", { name: /Level 1/ });
  let resolveOlder: (value: TelemetrySettings) => void = () => {};
  vi.mocked(apiGet).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOlder = resolve;
      })
  );
  await userEvent.click(screen.getByRole("radio", { name: /Level 1/ }));
  vi.mocked(apiGet).mockResolvedValueOnce({
    ...initial,
    effectiveLevel: 0,
    preview: { ...initial.preview, snapshot: null },
  });
  await userEvent.click(screen.getByRole("radio", { name: /Level 0/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save preference" })).toBeEnabled()
  );
  await act(async () => resolveOlder(initial));
  expect(screen.queryByLabelText("Daily payload")).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Level 0/ })).toBeChecked();
});

test("does not expose report contents or controls to a non-admin", async () => {
  vi.mocked(useIsAdmin).mockReturnValue(false);
  renderRoute();
  expect(await screen.findByText(/Only an administrator/)).toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Bootstrap payload")).not.toBeInTheDocument();
});

test("shows loading failures without presenting a save form", async () => {
  vi.mocked(apiGet).mockRejectedValue(new Error("Telemetry unavailable"));
  renderRoute();
  expect(await screen.findByText(/Telemetry unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save preference" })).not.toBeInTheDocument();
});

test("a rejected save keeps optional reporting paused and preserves the choice for retry", async () => {
  renderRoute();
  await screen.findByRole("button", { name: "Save preference" });
  vi.mocked(apiWrite).mockRejectedValueOnce(new Error("Could not save preference"));
  await userEvent.click(screen.getByRole("button", { name: "Save preference" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save preference");
  expect(screen.getByText(/daily reports are paused until you save/i)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Level 2/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Save preference" })).toBeEnabled();
  expect(screen.queryByText("Telemetry preference saved.")).not.toBeInTheDocument();
});

test("shows server-confirmed delivery timestamps and installation identity", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    ...initial,
    configured: true,
    bootstrapSentAt: "2026-09-13T10:00:00.000Z",
    lastSnapshotAt: "2026-09-14T10:00:00.000Z",
  });
  renderRoute();
  const installation = await screen.findByText(initial.installationId);
  const history = installation.closest("dl");
  expect(history?.querySelectorAll("time")).toHaveLength(2);
  expect(history?.querySelectorAll("time")[0]).toHaveAttribute(
    "datetime",
    "2026-09-13T10:00:00.000Z"
  );
  expect(history?.querySelectorAll("time")[1]).toHaveAttribute(
    "datetime",
    "2026-09-14T10:00:00.000Z"
  );
  expect(screen.getByRole("button", { name: "Save preference" })).toBeDisabled();
});
