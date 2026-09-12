import { createRemixStub } from "@remix-run/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

test("known setup tasks offer their existing actions without an Urgent badge", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <TasksPreviewCard
          tasks={[
            task({
              title: "What's your business called?",
              blocking: true,
              action: { kind: "answer", field: "businessName", sink: "business_profile" },
            }),
            task({
              id: "model",
              title: "Connect a model provider",
              blocking: true,
              action: { kind: "link", href: "/business/models" },
            }),
          ]}
          onPick={() => {}}
        />
      ),
    },
  ]);
  render(<Stub />);

  const setup = screen.getByRole("region", { name: "Get set up" });
  expect(within(setup).getByLabelText("What's your business called?")).toBeInTheDocument();
  expect(within(setup).getByRole("button", { name: "Save" })).toBeInTheDocument();
  expect(within(setup).getByRole("link", { name: "Connect model" })).toHaveAttribute(
    "href",
    "/business/models"
  );
  expect(screen.queryByText("Urgent")).not.toBeInTheDocument();
});

test("completed and dismissed tasks do not return to the home next steps", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <TasksPreviewCard
          tasks={[task({ status: "done" }), task({ id: "dismissed", status: "dismissed" })]}
          onPick={() => {}}
        />
      ),
    },
  ]);
  const { container } = render(<Stub />);
  expect(container).toBeEmptyDOMElement();
});

test("a task's link is a real navigation link, not a button", () => {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <TasksPreviewCard
          tasks={[task({ action: { kind: "link", href: "/inbox" } })]}
          onPick={() => {}}
        />
      ),
    },
  ]);
  render(<Stub />);
  expect(screen.getByRole("link", { name: /Add your business description/ })).toHaveAttribute(
    "href",
    "/inbox"
  );
});
