import { createRemixStub } from "@remix-run/testing";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "~/lib/tasks";
import { TasksPreviewCard } from "./tasks-preview-card";

afterEach(cleanup);

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    title: "Add your business description",
    action: { kind: "chat", prompt: "Help me describe my business." },
    blocking: false,
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("renders nothing when there are no tasks", () => {
  const Stub = createRemixStub([
    { path: "/", Component: () => <TasksPreviewCard tasks={[]} onPick={() => {}} /> },
  ]);
  const { container } = render(<Stub initialEntries={["/"]} />);
  expect(container).toBeEmptyDOMElement();
});

test("a blocking open task shows the Urgent status", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <TasksPreviewCard tasks={[task({ blocking: true })]} onPick={() => {}} />,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("Urgent")).toBeInTheDocument();
});

test("clicking a chat-action task seeds its prompt via onPick", () => {
  const onPick = vi.fn();
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => <TasksPreviewCard tasks={[task({})]} onPick={onPick} />,
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  fireEvent.click(screen.getByText("Add your business description"));
  expect(onPick).toHaveBeenCalledWith("Help me describe my business.");
});
