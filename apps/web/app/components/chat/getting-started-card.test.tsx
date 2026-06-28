import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { OnboardingChecklist } from "~/lib/onboarding";
import { GettingStartedCard } from "./getting-started-card";

afterEach(cleanup);

function checklist(over: Partial<OnboardingChecklist> = {}): OnboardingChecklist {
  return {
    dismissed: false,
    steps: [
      { id: "resource", label: "Create a resource type", status: "todo", prompt: "Help resource." },
      { id: "agent", label: "Create an agent", status: "done" },
      { id: "routine", label: "Set up a routine", status: "coming-soon" },
    ],
    recommendations: [],
    ...over,
  };
}

test("a todo step seeds its prompt via onPick", () => {
  const onPick = vi.fn();
  render(<GettingStartedCard checklist={checklist()} onPick={onPick} onDismiss={() => {}} />);
  fireEvent.click(screen.getByText("Create a resource type"));
  expect(onPick).toHaveBeenCalledWith("Help resource.");
});

test("a done step is not a button (non-interactive)", () => {
  const onPick = vi.fn();
  render(<GettingStartedCard checklist={checklist()} onPick={onPick} onDismiss={() => {}} />);
  fireEvent.click(screen.getByText("Create an agent"));
  expect(onPick).not.toHaveBeenCalled();
});

test("a coming-soon step shows the tag and does not seed a prompt", () => {
  const onPick = vi.fn();
  render(<GettingStartedCard checklist={checklist()} onPick={onPick} onDismiss={() => {}} />);
  expect(screen.getByText("Coming soon")).toBeTruthy();
  fireEvent.click(screen.getByText("Set up a routine"));
  expect(onPick).not.toHaveBeenCalled();
});

test("the dismiss control fires onDismiss", () => {
  const onDismiss = vi.fn();
  render(<GettingStartedCard checklist={checklist()} onPick={() => {}} onDismiss={onDismiss} />);
  fireEvent.click(screen.getByLabelText("Dismiss getting started"));
  expect(onDismiss).toHaveBeenCalledOnce();
});

test("the Recommended next section is hidden when there are no recommendations", () => {
  render(<GettingStartedCard checklist={checklist()} onPick={() => {}} onDismiss={() => {}} />);
  expect(screen.queryByText("Recommended next")).toBeNull();
});

test("a recommendation seeds its prompt via onPick", () => {
  const onPick = vi.fn();
  render(
    <GettingStartedCard
      checklist={checklist({
        recommendations: [
          { id: "agent-for-resource", label: "Agent for tickets", prompt: "Help agent." },
        ],
      })}
      onPick={onPick}
      onDismiss={() => {}}
    />
  );
  expect(screen.getByText("Recommended next")).toBeTruthy();
  fireEvent.click(screen.getByText("Agent for tickets"));
  expect(onPick).toHaveBeenCalledWith("Help agent.");
});
