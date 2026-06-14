import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import type { ConversationSummary } from "~/lib/conversations";
import ChatsRoute from "./_app.chats";

/*
 * Route smoke tests, mirroring knowledge.documents.routes.test.tsx: mock useLoaderData + the
 * `~/lib/conversations` client and `~/lib/conversations-context`, then render the Component directly
 * (Link/portal need router + document → createRemixStub at "/").
 */
vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useRouteError: vi.fn() };
});

vi.mock("~/lib/conversations", () => ({
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  setConversationStarred: vi.fn(),
}));

vi.mock("~/lib/conversations-context", () => ({
  useConversations: () => ({ refresh: vi.fn(async () => {}) }),
}));

import { listConversations, renameConversation, setConversationStarred } from "~/lib/conversations";

const convo = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c1",
  title: "Inventory Planning",
  agentId: null,
  starred: false,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-08T00:00:00Z",
  ...over,
});

function renderWithItems(node: ReactElement, items: ConversationSummary[]) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ items });
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

test("lists chats linking each row to /chat/:id, with a search box and the All filter", () => {
  renderWithItems(<ChatsRoute />, [convo()]);
  expect(screen.getByRole("link", { name: /Inventory Planning/ })).toHaveAttribute(
    "href",
    "/chat/c1"
  );
  expect(screen.getByLabelText("search chats")).toBeInTheDocument();
  expect(screen.getByText("All")).toBeInTheDocument();
});

test("empty history shows a New chat link", () => {
  renderWithItems(<ChatsRoute />, []);
  expect(screen.getByText(/No chats yet/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Start a new chat/i })).toHaveAttribute("href", "/");
});

test("pins starred chats above the rest", () => {
  renderWithItems(<ChatsRoute />, [
    convo({ id: "c1", title: "Older", updatedAt: "2026-06-08T00:00:00Z" }),
    convo({ id: "c2", title: "Pinned", starred: true, updatedAt: "2026-06-01T00:00:00Z" }),
  ]);
  const rows = screen.getAllByRole("link", { name: /Older|Pinned/ });
  expect(rows[0]).toHaveTextContent("Pinned");
  expect(rows[1]).toHaveTextContent("Older");
});

test("typing in the search box refetches server-side with the query", async () => {
  vi.mocked(listConversations).mockResolvedValue([]);
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.change(screen.getByLabelText("search chats"), { target: { value: "budget" } });
  await waitFor(() => expect(listConversations).toHaveBeenCalledWith({ q: "budget", limit: 200 }));
});

test("the three-dots menu stars a chat", async () => {
  vi.mocked(setConversationStarred).mockResolvedValue(convo({ starred: true }));
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.click(screen.getByRole("button", { name: /chat actions/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Star/ }));
  expect(setConversationStarred).toHaveBeenCalledWith("c1", true);
});

test("the three-dots menu renames a chat inline", async () => {
  vi.mocked(renameConversation).mockResolvedValue(convo({ title: "Renamed" }));
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.click(screen.getByRole("button", { name: /chat actions/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
  const input = screen.getByLabelText("Rename chat");
  fireEvent.change(input, { target: { value: "Renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(renameConversation).toHaveBeenCalledWith("c1", "Renamed");
});
