import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OperationsModel } from "~/lib/operations";
import { OperationsConsole } from "./operations-console";

const model = {
  health: [
    {
      component: "worker",
      status: "degraded" as const,
      detail: "worker heartbeat is overdue",
      checkedAt: "2026-07-26T00:00:00Z",
    },
  ],
  incidents: [
    {
      id: "incident-1",
      severity: "high",
      title: "Queue stalled",
      createdAt: "2026-07-26T00:00:00Z",
    },
  ],
  quarantine: [{ id: "quarantine-1", reason: "ambiguous effect" }],
  killSwitches: [{ id: "all-mutations", enabled: false }],
  activity: [
    {
      id: "audit-1",
      action: "run.cancel",
      actorType: "user",
      targetType: "run",
      targetId: "0f5a23e8-42d7-7556-88d4-b544f361718b",
      summary: "Cancelled a stalled Run",
      status: "ok",
      createdAt: "2026-07-26T00:00:00Z",
      secret: "must-not-render",
    },
  ],
  recovery: { supportBundleAvailable: true, lastBackupAt: "2026-07-26T00:00:00Z" },
};

function renderConsole(consoleModel: OperationsModel, onCommand = vi.fn(), onRefresh = vi.fn()) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <OperationsConsole model={consoleModel} onCommand={onCommand} onRefresh={onRefresh} />
      ),
    },
    { path: "/business/activities", Component: () => null },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("OperationsConsole", () => {
  it("renders structured operational summaries without raw JSON or protected fields", () => {
    renderConsole(model);
    expect(screen.getByRole("heading", { name: "Queue stalled" })).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("worker heartbeat is overdue")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Recent operational activity" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scrollable operational activity" })).toHaveAttribute(
      "tabindex",
      "0"
    );
    expect(screen.getByRole("columnheader", { name: "Event" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all activities" })).toHaveAttribute(
      "href",
      "/business/activities"
    );
    expect(screen.getByText("Cancelled a stalled Run")).toBeInTheDocument();
    expect(screen.getByTitle("0f5a23e8-42d7-7556-88d4-b544f361718b")).toHaveTextContent("0f5a23e8");
    expect(screen.queryByText(/"component":/)).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  });

  it("refreshes health without issuing an operational command", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    const onRefresh = vi.fn();
    renderConsole(model, onCommand, onRefresh);

    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("uses compact, descriptive empty states", () => {
    renderConsole({
      health: [],
      incidents: [],
      quarantine: [],
      killSwitches: [],
      activity: [],
      recovery: { supportBundleAvailable: false, lastBackupAt: null },
    });
    expect(screen.getByText("No active incidents")).toBeInTheDocument();
    expect(screen.getByText("No quarantined items")).toBeInTheDocument();
    expect(screen.getByText("No deployment flags set")).toBeInTheDocument();
    expect(screen.getByText("No operational activity recorded")).toBeInTheDocument();
    expect(screen.getByText("No backup reported")).toBeInTheDocument();
    expect(screen.getByText("Health has not been reported")).toBeInTheDocument();
    expect(screen.queryByText("All reported systems operational")).not.toBeInTheDocument();
  });

  it("puts failed and unknown checks before reported healthy checks without hiding details", () => {
    renderConsole({
      ...model,
      health: [
        { component: "postgres", status: "ok", checkedAt: "2026-09-12T10:00:00Z" },
        {
          component: "llm",
          status: "unknown",
          detail: "No model provider is configured",
          checkedAt: "2026-09-12T10:00:00Z",
        },
        {
          component: "worker",
          status: "down",
          detail: "Worker is not responding",
          checkedAt: "2026-09-12T10:00:00Z",
        },
      ],
    });

    const health = screen.getByRole("region", { name: "Health" });
    const rows = within(health).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("worker"),
      expect.stringContaining("llm"),
      expect.stringContaining("postgres"),
    ]);
    expect(within(health).getByText("Unknown")).toBeInTheDocument();
    expect(within(health).getByText("Down")).toBeInTheDocument();
    expect(within(health).getByText("No model provider is configured")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings.indexOf("Recovery")).toBeLessThan(
      headings.indexOf("Recent operational activity")
    );
  });

  it("keeps unknown health distinct from a successful check", () => {
    renderConsole({
      ...model,
      incidents: [],
      quarantine: [],
      killSwitches: [],
      health: [{ component: "embeddings", status: "unknown", checkedAt: "2026-09-12T10:00:00Z" }],
    });
    expect(screen.getByText("1 item needs attention")).toBeInTheDocument();
    expect(screen.queryByText("All reported systems operational")).not.toBeInTheDocument();
  });

  it("filters operational activity using the rendered summary fields", async () => {
    const user = userEvent.setup();
    renderConsole({
      ...model,
      activity: [
        ...model.activity,
        {
          id: "audit-2",
          action: "job.run",
          actorType: "system",
          targetType: "job",
          targetId: "connector-sync",
          summary: "Connector sync ran",
          status: "ok",
          createdAt: "2026-07-26T01:00:00Z",
        },
      ],
    });

    await user.type(
      screen.getByRole("searchbox", { name: "Filter operational activity" }),
      "connector"
    );
    expect(screen.getByText("Connector sync ran")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled a stalled Run")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 events")).toBeInTheDocument();
  });

  it("previews support bundle creation before invoking server recovery authority", async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn();
    renderConsole(model, onCommand);
    await user.click(screen.getByRole("button", { name: "Create support bundle" }));
    expect(onCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create support bundle" }));
    await user.click(screen.getByRole("button", { name: "Confirm Create Support Bundle" }));
    expect(onCommand).toHaveBeenCalledWith("support-bundle.create", {});
  });

  it("shows command refusal without claiming a support bundle was created", async () => {
    const user = userEvent.setup();
    renderConsole(model, vi.fn().mockRejectedValue(new Error("Recovery permission denied")));
    await user.click(screen.getByRole("button", { name: "Create support bundle" }));
    await user.click(screen.getByRole("button", { name: "Confirm Create Support Bundle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recovery permission denied");
  });
});
