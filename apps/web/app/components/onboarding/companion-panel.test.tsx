import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { Task } from "~/lib/tasks";
import { answerTask } from "~/lib/tasks";
import { CompanionPanel } from "./companion-panel";

vi.mock("~/lib/tasks", () => ({ answerTask: vi.fn(), completeTask: vi.fn() }));

const nameTask: Task = {
  id: "business-name",
  title: "What's your business called?",
  action: { kind: "answer", field: "businessName", sink: "business_profile" },
  blocking: true,
  status: "open",
  createdAt: "2026-01-01T00:00:00Z",
};
const refresh = vi.fn();

function showPanel(error?: string) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <CompanionPanel
          tasks={error ? [] : [nameTask]}
          loading={false}
          error={error}
          onDismiss={vi.fn()}
          onAnswered={refresh}
          onClose={vi.fn()}
        />
      ),
    },
  ]);
  return render(<Stub />);
}

beforeEach(() => vi.clearAllMocks());

test("saves a setup answer through the existing task action and refreshes", async () => {
  vi.mocked(answerTask).mockResolvedValue();
  showPanel();
  await userEvent.type(screen.getByLabelText(nameTask.title), "Muskan's flowers");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(answerTask).toHaveBeenCalledWith("business-name", "Muskan's flowers");
  expect(refresh).toHaveBeenCalledOnce();
});

test("validates an empty answer on submit with an associated error", async () => {
  showPanel();
  const input = screen.getByLabelText(nameTask.title);
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("Enter an answer to continue.");
  expect(input).toHaveFocus();
  expect(answerTask).not.toHaveBeenCalled();
});

test("shows a confirmed save while the shared task list catches up", async () => {
  vi.mocked(answerTask).mockResolvedValue();
  showPanel();
  await userEvent.type(screen.getByLabelText(nameTask.title), "Muskan's flowers");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument();
});

test("a failed answer remains editable with a named error", async () => {
  vi.mocked(answerTask).mockRejectedValue(new Error("offline"));
  showPanel();
  await userEvent.type(screen.getByLabelText(nameTask.title), "Muskan's flowers");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save");
  expect(screen.getByLabelText(nameTask.title)).toHaveValue("Muskan's flowers");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("does not claim setup is complete when the task list failed", async () => {
  showPanel("Couldn't load your next steps. Try again.");
  expect(screen.queryByText("You're all caught up.")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(refresh).toHaveBeenCalledOnce();
});
