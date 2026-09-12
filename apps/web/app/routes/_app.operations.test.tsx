import { Outlet } from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/lib/api";
import { getKillSwitches, type KillSwitchModel } from "~/lib/kill-switches";
import { getOperations, type OperationsModel } from "~/lib/operations";
import OperationsRoute, { clientLoader, ErrorBoundary } from "./_app.operations";

vi.mock("~/lib/operations", () => ({
  getOperations: vi.fn(),
  commandOperation: vi.fn(),
}));
vi.mock("~/lib/kill-switches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/kill-switches")>()),
  getKillSwitches: vi.fn(),
}));
vi.mock("~/components/operations/audit-ledger-panel", () => ({
  AuditLedgerPanel: () => <h2>Audit ledger</h2>,
}));

const model: OperationsModel = {
  health: [
    {
      component: "llm",
      status: "unknown",
      detail: "No model provider is configured",
      checkedAt: "2026-09-12T10:00:00Z",
    },
    {
      component: "embeddings",
      status: "unknown",
      detail: "No embedding provider is configured",
      checkedAt: "2026-09-12T10:00:00Z",
    },
  ],
  incidents: [],
  quarantine: [],
  killSwitches: [],
  activity: [],
  recovery: { supportBundleAvailable: false, lastBackupAt: null },
};
const stops: KillSwitchModel = {
  killSwitches: [],
  enforceableScopeKinds: ["all_mutations", "tool", "integration"],
};

function renderRoute(isAdmin = true) {
  const Stub = createRemixStub([
    {
      id: "routes/_app",
      path: "/",
      loader: () => ({ user: { role: "member", isAdmin } }),
      Component: Outlet,
      children: [
        { path: "operations", loader: clientLoader, Component: OperationsRoute, ErrorBoundary },
        { path: "business/models", Component: () => <h1>Model settings</h1> },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/operations"]} />);
}

beforeEach(() => {
  vi.mocked(getOperations).mockReset().mockResolvedValue(model);
  vi.mocked(getKillSwitches).mockReset().mockResolvedValue(stops);
});

describe("Operations route", () => {
  it("leads with health and recovery before collapsed emergency controls", async () => {
    renderRoute();
    await screen.findByText("No model provider is configured");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings.indexOf("Health")).toBeLessThan(headings.indexOf("Emergency stop"));
    expect(headings.indexOf("Incidents")).toBeLessThan(headings.indexOf("Emergency stop"));
    expect(headings.indexOf("Quarantine")).toBeLessThan(headings.indexOf("Emergency stop"));
    expect(headings.indexOf("Recovery")).toBeLessThan(headings.indexOf("Audit ledger"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Configure emergency stop").closest("details")).not.toHaveAttribute(
      "open"
    );
    expect(screen.getByRole("link", { name: "Review model settings" })).toHaveAttribute(
      "href",
      "/business/models"
    );
    expect(screen.getByRole("link", { name: "Review embedding settings" })).toHaveAttribute(
      "href",
      "/business/models"
    );
  });

  it("keeps an active stop prominent above health and names its scope", async () => {
    vi.mocked(getKillSwitches).mockResolvedValue({
      ...stops,
      killSwitches: [
        {
          id: "stop-1",
          scopeKind: "integration",
          scopeValue: "slack",
          reasonCode: "incident 42",
          enabled: true,
          enabledAt: "2026-09-12T10:00:00Z",
          enabledBy: "ops@tulipfarm.dev",
        },
      ],
    });
    renderRoute();
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("1 active emergency stop");
    expect(warning).toHaveTextContent("One Integration: slack");
    expect(within(warning).getByRole("link", { name: "Review emergency stop" })).toHaveAttribute(
      "href",
      "#operations-emergency-stop"
    );
    const health = screen.getByRole("heading", { name: "Health" });
    expect(warning.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not reveal controls or admin recovery links without admin authority", async () => {
    vi.mocked(getKillSwitches).mockRejectedValue(new ApiError(403, "Permission denied"));
    renderRoute(false);
    await screen.findByText("No model provider is configured");
    expect(screen.queryByText("Configure emergency stop")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review model settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses admin authority rather than allowing controls from a returned stop model alone", async () => {
    renderRoute(false);
    await screen.findByText("No model provider is configured");
    expect(screen.queryByText("Configure emergency stop")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Review embedding settings" })
    ).not.toBeInTheDocument();
  });

  it("shows an unreadable stop state rather than claiming no stops are armed", async () => {
    vi.mocked(getKillSwitches).mockRejectedValue(new ApiError(503, "Service unavailable"));
    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Emergency stop status is unavailable"
    );
    expect(screen.getByText("No model provider is configured")).toBeInTheDocument();
    expect(screen.queryByText(/no kill switch is armed/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
  });

  it("preserves existing health and announces a refresh while the request is pending", async () => {
    renderRoute();
    await screen.findByText("No model provider is configured");
    let finish: (value: OperationsModel) => void = () => {};
    vi.mocked(getOperations).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(screen.getByRole("button", { name: "Refreshing status…" })).toBeDisabled();
    expect(screen.getByText("No model provider is configured")).toBeInTheDocument();
    finish(model);
    expect(await screen.findByRole("button", { name: "Refresh status" })).toBeEnabled();
  });

  it("does not turn a failed health request into a healthy or empty model", async () => {
    const error = new ApiError(503, "Operations unavailable");
    vi.mocked(getOperations).mockRejectedValue(error);
    await expect(clientLoader()).rejects.toBe(error);
  });

  it("keeps the Operations frame on a failed load and retries through the page", async () => {
    vi.mocked(getOperations).mockRejectedValueOnce(new ApiError(503, "Operations unavailable"));
    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("Operations unavailable");
    expect(screen.getByRole("heading", { level: 1, name: "Operations" })).toBeInTheDocument();
    expect(screen.queryByText("All reported health checks passed")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No model provider is configured")).toBeInTheDocument();
  });

  it("keeps a permission refusal visible without offering emergency controls", async () => {
    vi.mocked(getOperations).mockRejectedValue(new ApiError(403, "Permission denied"));
    renderRoute(false);
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(
      screen.getByRole("heading", { name: "Operations access is unavailable" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Configure emergency stop")).not.toBeInTheDocument();
  });
});
