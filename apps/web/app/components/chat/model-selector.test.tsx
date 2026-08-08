import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  asPickerPreset,
  effectiveEffortPreset,
  ModelSelector,
} from "~/components/chat/model-selector";
import type { ChatModelSelector } from "~/lib/chat/types";

const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Effort preset:/ }));

const option = (name: string) => screen.getByRole("menuitemradio", { name: new RegExp(name) });

test("Auto is the visible default and the menu is closed until opened", () => {
  render(<ModelSelector value="auto" onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Effort preset: Auto (default)" })).toHaveTextContent(
    /Auto.*Default/
  );
  expect(screen.queryByRole("menuitemradio", { name: /Fast/ })).not.toBeInTheDocument();
});

test("opening the dropdown offers all four effort presets", async () => {
  const user = userEvent.setup();
  render(<ModelSelector value="auto" onChange={vi.fn()} />);
  await openMenu(user);
  for (const preset of ["Auto", "Fast", "Balanced", "Thorough"]) {
    expect(option(preset)).toBeInTheDocument();
  }
});

test("selecting a preset calls onChange with its preset id", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ModelSelector value="auto" onChange={onChange} />);
  await openMenu(user);
  await user.click(option("Thorough"));
  expect(onChange).toHaveBeenCalledWith("thorough");
});

describe("asPickerPreset", () => {
  test("passes through effort presets", () => {
    expect(asPickerPreset("auto")).toBe("auto");
    expect(asPickerPreset("fast")).toBe("fast");
    expect(asPickerPreset("balanced")).toBe("balanced");
    expect(asPickerPreset("thorough")).toBe("thorough");
  });

  test("maps retired aliases for one release and rejects raw model ids", () => {
    expect(asPickerPreset("quick")).toBe("fast");
    expect(asPickerPreset("standard")).toBe("balanced");
    expect(asPickerPreset("complex")).toBe("thorough");
    expect(asPickerPreset("gpt-4o")).toBeUndefined();
    expect(asPickerPreset(undefined)).toBeUndefined();
  });
});

describe("effectiveEffortPreset", () => {
  const presetById = (id: string): ChatModelSelector | undefined =>
    ({ Billing: "balanced", Architect: "thorough" })[id] as ChatModelSelector | undefined;

  test("the @mentioned agent's preset wins over the active agent's", () => {
    expect(
      effectiveEffortPreset({
        mentionedAgentId: "Architect",
        presetById,
        activeAgentPreset: "balanced",
        fallback: "auto",
      })
    ).toBe("thorough");
  });

  test("falls back to the active agent's preset when no mention is present", () => {
    expect(effectiveEffortPreset({ presetById, activeAgentPreset: "fast", fallback: "auto" })).toBe(
      "fast"
    );
  });

  test("falls back to Auto when a mention has no pickable preset and no active preset", () => {
    expect(
      effectiveEffortPreset({ mentionedAgentId: "Unknown", presetById, fallback: "auto" })
    ).toBe("auto");
  });
});

test("each option explains the effort, latency, and cost tradeoff", async () => {
  const user = userEvent.setup();
  render(<ModelSelector value="auto" onChange={vi.fn()} />);
  await openMenu(user);
  expect(
    screen.getByText("Lets TulipFarm balance effort, latency, and cost for this turn.")
  ).toBeInTheDocument();
  expect(screen.getByText("Lower effort for faster, lower-cost replies.")).toBeInTheDocument();
  expect(
    screen.getByText("Moderate effort for everyday depth, latency, and cost.")
  ).toBeInTheDocument();
  expect(
    screen.getByText("Higher effort for deeper work with more latency and cost.")
  ).toBeInTheDocument();
});

test("keyboard navigation can select a preset", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ModelSelector value="auto" onChange={onChange} />);

  screen.getByRole("button", { name: "Effort preset: Auto (default)" }).focus();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

  expect(onChange).toHaveBeenCalledWith("fast");
});
