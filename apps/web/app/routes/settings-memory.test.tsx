import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  deleteMemoryEntry,
  listMemory,
  listPendingMemory,
  resolvePendingMemory,
  updateMemoryEntry,
} from "~/lib/memory";
import SettingsMemory, { clientLoader } from "./_app.settings.memory";

vi.mock("~/lib/memory", () => ({
  listMemory: vi.fn(),
  listPendingMemory: vi.fn(),
  resolvePendingMemory: vi.fn(),
  updateMemoryEntry: vi.fn(),
  deleteMemoryEntry: vi.fn(),
}));

const PENDING = {
  pendingId: "p1",
  subject: "employer",
  statement: "Works at Acme as a staff engineer.",
  memoryType: "fact",
  requestedAt: "2025-01-01T00:00:00.000Z",
  expiresAt: "2025-01-08T00:00:00.000Z",
};

function renderPage() {
  const Stub = createRemixStub([
    { path: "/", Component: SettingsMemory, loader: () => clientLoader() },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  vi.mocked(listMemory).mockResolvedValue({ entries: [], maxValueChars: 256 });
  vi.mocked(listPendingMemory).mockResolvedValue([]);
  vi.mocked(resolvePendingMemory).mockResolvedValue(undefined);
});

test("shows suggested memories awaiting a decision", async () => {
  vi.mocked(listPendingMemory).mockResolvedValue([PENDING]);
  renderPage();

  expect(await screen.findByText("Works at Acme as a staff engineer.")).toBeInTheDocument();
  expect(screen.getByText("employer")).toBeInTheDocument();
  expect(screen.getByText("(1)")).toBeInTheDocument();
});

test("keeps a suggestion, confirming it", async () => {
  vi.mocked(listPendingMemory).mockResolvedValue([PENDING]);
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole("button", { name: /Keep suggested memory/ }));

  await waitFor(() => expect(resolvePendingMemory).toHaveBeenCalledWith("p1", "confirm"));
});

test("discards a suggestion, denying it", async () => {
  vi.mocked(listPendingMemory).mockResolvedValue([PENDING]);
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole("button", { name: /Discard suggested memory/ }));

  await waitFor(() => expect(resolvePendingMemory).toHaveBeenCalledWith("p1", "deny"));
});

test("hides the section entirely when nothing awaits review", async () => {
  renderPage();

  expect(await screen.findByLabelText("new memory key")).toBeInTheDocument();
  expect(screen.queryByText("Suggested memories")).not.toBeInTheDocument();
});

test("still renders when the queue is unavailable, rather than failing the page", async () => {
  vi.mocked(listPendingMemory).mockRejectedValue(new Error("not registered"));
  renderPage();

  expect(await screen.findByLabelText("new memory key")).toBeInTheDocument();
  expect(screen.queryByText("Suggested memories")).not.toBeInTheDocument();
});

test("keeps saved memories separate from suggestions", async () => {
  vi.mocked(listMemory).mockResolvedValue({
    entries: [
      {
        key: "language",
        value: "English",
        writtenByAgentId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        lastWrittenAt: "2025-01-01T00:00:00.000Z",
      },
    ],
    maxValueChars: 256,
  });
  vi.mocked(listPendingMemory).mockResolvedValue([PENDING]);
  renderPage();

  // The saved entry is editable; the suggestion is not — it is only keep-or-discard.
  expect(await screen.findByLabelText("value for language")).toBeInTheDocument();
  expect(screen.queryByLabelText("value for employer")).not.toBeInTheDocument();
});

test("does not touch the saved-memory API when resolving a suggestion", async () => {
  vi.mocked(listPendingMemory).mockResolvedValue([PENDING]);
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole("button", { name: /Keep suggested memory/ }));

  await waitFor(() => expect(resolvePendingMemory).toHaveBeenCalled());
  expect(updateMemoryEntry).not.toHaveBeenCalled();
  expect(deleteMemoryEntry).not.toHaveBeenCalled();
});
