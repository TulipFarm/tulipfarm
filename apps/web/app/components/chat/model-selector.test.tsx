import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ModelSelector } from "~/components/chat/model-selector";

vi.mock("~/lib/settings", () => ({
  getLlmConfig: vi.fn().mockResolvedValue({
    tiers: {
      quick: { providers: [{ provider: "azure", model: "gpt-4o-mini" }] },
      standard: {
        providers: [
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          { provider: "openai", model: "gpt-4o" },
        ],
      },
      complex: { providers: [] },
    },
  }),
}));

const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Model:/ }));

test("the trigger shows the active tier and the menu is closed until opened", () => {
  render(<ModelSelector value="standard" onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Model: standard" })).toBeInTheDocument();
  // Options only exist once the dropdown is open.
  expect(screen.queryByRole("button", { name: "quick" })).not.toBeInTheDocument();
});

test("opening the dropdown offers all three tiers including quick", async () => {
  const user = userEvent.setup();
  render(<ModelSelector value="standard" onChange={vi.fn()} />);
  await openMenu(user);
  for (const tier of ["quick", "standard", "complex"]) {
    expect(screen.getByRole("button", { name: tier })).toBeInTheDocument();
  }
});

test("selecting a tier calls onChange with its id", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ModelSelector value="standard" onChange={onChange} />);
  await openMenu(user);
  await user.click(screen.getByRole("button", { name: "quick" }));
  expect(onChange).toHaveBeenCalledWith("quick");
});

test("each option explains the tier (line 1) and lists its models (line 2)", async () => {
  const user = userEvent.setup();
  render(<ModelSelector value="standard" onChange={vi.fn()} />);
  await openMenu(user);
  // Line 1: what the tier means.
  expect(screen.getByText("Fast & low-cost — short answers, simple tasks")).toBeInTheDocument();
  // Line 2: the models configured for the tier (all providers, comma-joined).
  await waitFor(() => {
    expect(screen.getByText("azure / gpt-4o-mini")).toBeInTheDocument();
  });
  expect(screen.getByText("anthropic / claude-sonnet-4-6, openai / gpt-4o")).toBeInTheDocument();
  // A tier with no providers configured.
  expect(screen.getByText("not configured")).toBeInTheDocument();
});
