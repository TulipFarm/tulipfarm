import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/lib/api";
import type { KillSwitchModel } from "~/lib/kill-switches";
import { KillSwitchPanel } from "./kill-switch-panel";

const { armKillSwitch, standDownKillSwitch } = vi.hoisted(() => ({
  armKillSwitch: vi.fn(),
  standDownKillSwitch: vi.fn(),
}));

vi.mock("~/lib/kill-switches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/kill-switches")>()),
  armKillSwitch,
  standDownKillSwitch,
}));

const model: KillSwitchModel = {
  killSwitches: [],
  enforceableScopeKinds: ["all_mutations", "tool", "integration"],
};

const live: KillSwitchModel = {
  ...model,
  killSwitches: [
    {
      id: "ks-1",
      scopeKind: "integration",
      scopeValue: "slack",
      reasonCode: "leaking DMs",
      enabledAt: "2026-08-14T15:24:18Z",
      enabledBy: "ops@tulipfarm.dev",
      enabled: true,
    },
  ],
};

beforeEach(() => {
  armKillSwitch.mockReset().mockResolvedValue({ killSwitch: {} });
  standDownKillSwitch.mockReset().mockResolvedValue(undefined);
});

describe("KillSwitchPanel", () => {
  it("keeps stop configuration collapsed without claiming the system is healthy", () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    expect(screen.getByText(/no kill switch is armed/i)).toBeInTheDocument();
    expect(screen.queryByText("All clear")).not.toBeInTheDocument();
    expect(screen.getByText("Configure emergency stop").closest("details")).not.toHaveAttribute(
      "open"
    );
    expect(screen.getByRole("button", { name: /arm kill switch/i })).not.toBeVisible();
  });

  it("offers only the scopes a guard can enforce", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Every mutating effect", "One Tool", "One Integration"]);
  });

  it("will not arm without a reason", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/reason/i), "runaway agent");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeEnabled();
  });

  it("requires the identifier when the scope is not every mutation", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.selectOptions(screen.getByLabelText(/scope/i), "tool");
    await userEvent.type(screen.getByLabelText(/reason/i), "bad tool");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/which one/i), "github.create_issue");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeEnabled();
  });

  it("arms the scope the operator chose and refreshes", async () => {
    const onChanged = vi.fn();
    render(<KillSwitchPanel model={model} onChanged={onChanged} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.selectOptions(screen.getByLabelText(/scope/i), "integration");
    await userEvent.type(screen.getByLabelText(/which one/i), "slack");
    await userEvent.type(screen.getByLabelText(/reason/i), "leaking DMs");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));
    expect(armKillSwitch).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Arm kill switch?" });
    expect(within(confirmation).getByText("One Integration: slack")).toBeInTheDocument();
    expect(within(confirmation).getByText("leaking DMs")).toBeInTheDocument();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Confirm arm kill switch" })
    );

    expect(armKillSwitch).toHaveBeenCalledWith({
      scopeKind: "integration",
      scopeValue: "slack",
      reasonCode: "leaking DMs",
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("sends no identifier when every mutation is stopped", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm arm kill switch" }));

    expect(armKillSwitch).toHaveBeenCalledWith({
      scopeKind: "all_mutations",
      reasonCode: "incident 42",
    });
  });

  it("shows an active stop, its reason and recovery even while configuration is collapsed", () => {
    render(<KillSwitchPanel model={live} onChanged={vi.fn()} />);
    expect(screen.getByText("One Integration: slack")).toBeInTheDocument();
    expect(screen.getByText(/leaking DMs/)).toBeInTheDocument();
    expect(screen.getByText(/ops@tulipfarm\.dev/)).toBeInTheDocument();
    expect(screen.getByText("1 active stop")).toBeInTheDocument();
    expect(screen.getByText("Configure emergency stop").closest("details")).not.toHaveAttribute(
      "open"
    );
    expect(screen.getByRole("button", { name: /stand down/i })).toBeVisible();
    expect(screen.getByText(/reads and in-flight work/i)).toBeVisible();
  });

  it("stands a switch down and refreshes", async () => {
    const onChanged = vi.fn();
    render(<KillSwitchPanel model={live} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: /stand down/i }));

    expect(standDownKillSwitch).toHaveBeenCalledWith("ks-1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("surfaces a failure instead of implying the stop took effect", async () => {
    const onChanged = vi.fn();
    armKillSwitch.mockRejectedValue(new Error("boom"));
    render(<KillSwitchPanel model={model} onChanged={onChanged} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm arm kill switch" }));

    expect(await screen.findByText(/could not reach the api/i)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("hides stood-down switches from the live list", () => {
    render(
      <KillSwitchPanel
        model={{
          ...model,
          killSwitches: [
            {
              ...live.killSwitches[0],
              enabled: false,
              disabledAt: "2026-08-14T16:00:00Z",
              disabledBy: "ops@tulipfarm.dev",
            },
          ],
        }}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText(/no kill switch is armed/i)).toBeInTheDocument();
    expect(screen.queryByText("1 active stop")).not.toBeInTheDocument();
  });

  it("cancels arming without sending a mutation and restores focus", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    const trigger = screen.getByRole("button", { name: "Arm kill switch" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(armKillSwitch).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("preserves the active stop and shows the refusal when standing down is forbidden", async () => {
    const onChanged = vi.fn();
    standDownKillSwitch.mockRejectedValue(new ApiError(403, "Permission denied"));
    render(<KillSwitchPanel model={live} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: /stand down/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByText("1 active stop")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not offer an unsupported all-mutations scope as the default", async () => {
    render(
      <KillSwitchPanel
        model={{ killSwitches: [], enforceableScopeKinds: ["integration"] }}
        onChanged={vi.fn()}
      />
    );
    await userEvent.click(screen.getByText("Configure emergency stop"));
    expect(screen.getByLabelText("Scope")).toHaveValue("integration");
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    expect(screen.getByRole("button", { name: "Arm kill switch" })).toBeDisabled();
  });

  it("keeps the confirmation and reason available after an arming refusal", async () => {
    const onChanged = vi.fn();
    armKillSwitch.mockRejectedValue(new ApiError(403, "Permission denied"));
    render(<KillSwitchPanel model={model} onChanged={onChanged} />);
    await userEvent.click(screen.getByText("Configure emergency stop"));
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    await userEvent.click(screen.getByRole("button", { name: "Arm kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm arm kill switch" }));
    const dialog = screen.getByRole("dialog", { name: "Arm kill switch?" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Permission denied");
    expect(within(dialog).getByText("incident 42")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
