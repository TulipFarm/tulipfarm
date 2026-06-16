import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { asTier, effectiveTier, ModelSelector } from "~/components/chat/model-selector";
import type { ModelTier } from "~/lib/chat/types";

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

describe("asTier", () => {
  test("passes through the three pickable tiers", () => {
    expect(asTier("quick")).toBe("quick");
    expect(asTier("standard")).toBe("standard");
    expect(asTier("complex")).toBe("complex");
  });

  test("rejects 'auto', raw model ids, and undefined (dropdown left unchanged)", () => {
    expect(asTier("auto")).toBeUndefined();
    expect(asTier("gpt-4o")).toBeUndefined();
    expect(asTier(undefined)).toBeUndefined();
    expect(asTier("")).toBeUndefined();
  });
});

describe("effectiveTier", () => {
  const tierById = (id: string): ModelTier | undefined =>
    ({ Billing: "standard", Architect: "complex" })[id] as ModelTier | undefined;

  test("the @mentioned agent's tier wins over the active agent's", () => {
    expect(
      effectiveTier({
        mentionedAgentId: "Architect",
        tierById,
        activeAgentTier: "standard",
        fallback: "standard",
      })
    ).toBe("complex");
  });

  test("falls back to the active agent's tier when no mention is present", () => {
    expect(effectiveTier({ tierById, activeAgentTier: "complex", fallback: "standard" })).toBe(
      "complex"
    );
  });

  test("falls back to the fallback when a mention has no pickable tier and no active tier", () => {
    // 'Unknown' is not in tierById → undefined; no activeAgentTier → fallback.
    expect(effectiveTier({ mentionedAgentId: "Unknown", tierById, fallback: "standard" })).toBe(
      "standard"
    );
  });
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
