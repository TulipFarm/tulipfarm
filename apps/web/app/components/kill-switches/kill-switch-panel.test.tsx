import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("says mutations are running when nothing is armed", () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    expect(screen.getByText(/no kill switch is armed/i)).toBeInTheDocument();
    expect(screen.getByText("All clear")).toBeInTheDocument();
  });

  it("offers only the scopes a guard can enforce", () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Every mutating effect", "One Tool", "One Integration"]);
  });

  it("will not arm without a reason", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/reason/i), "runaway agent");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeEnabled();
  });

  it("requires the identifier when the scope is not every mutation", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/scope/i), "tool");
    await userEvent.type(screen.getByLabelText(/reason/i), "bad tool");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/which one/i), "github.create_issue");
    expect(screen.getByRole("button", { name: /arm kill switch/i })).toBeEnabled();
  });

  it("arms the scope the operator chose and refreshes", async () => {
    const onChanged = vi.fn();
    render(<KillSwitchPanel model={model} onChanged={onChanged} />);
    await userEvent.selectOptions(screen.getByLabelText(/scope/i), "integration");
    await userEvent.type(screen.getByLabelText(/which one/i), "slack");
    await userEvent.type(screen.getByLabelText(/reason/i), "leaking DMs");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));

    expect(armKillSwitch).toHaveBeenCalledWith({
      scopeKind: "integration",
      scopeValue: "slack",
      reasonCode: "leaking DMs",
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("sends no identifier when every mutation is stopped", async () => {
    render(<KillSwitchPanel model={model} onChanged={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));

    expect(armKillSwitch).toHaveBeenCalledWith({
      scopeKind: "all_mutations",
      reasonCode: "incident 42",
    });
  });

  it("shows a live switch with who armed it and why", () => {
    render(<KillSwitchPanel model={live} onChanged={vi.fn()} />);
    expect(screen.getByText("One Integration: slack")).toBeInTheDocument();
    expect(screen.getByText(/leaking DMs/)).toBeInTheDocument();
    expect(screen.getByText(/ops@tulipfarm\.dev/)).toBeInTheDocument();
    expect(screen.getByText("1 live")).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText(/reason/i), "incident 42");
    await userEvent.click(screen.getByRole("button", { name: /arm kill switch/i }));

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
    expect(screen.getByText("All clear")).toBeInTheDocument();
  });
});
