import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHAT_TITLE_MAX_LENGTH } from "@tulipfarm/schema/chat-limits";
import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConversationSummary } from "~/lib/conversations";
import ChatsRoute from "./_app.chats";

// Replaces the global inert IntersectionObserver (vitest.setup.ts) with one that captures every
// instance and its callback, so a test can trigger the "scrolled near the bottom" behavior on
// demand instead of depending on jsdom's absent real layout/intersection engine.
let capturedObservers: Array<{ trigger: () => void }> = [];
beforeEach(() => {
  capturedObservers = [];
  Object.defineProperty(window, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: class {
      constructor(private readonly callback: IntersectionObserverCallback) {
        capturedObservers.push({
          trigger: () =>
            this.callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            ),
        });
      }
      observe = () => {};
      unobserve = () => {};
      disconnect = () => {};
    },
  });
});

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn(), useRouteError: vi.fn() };
});

vi.mock("~/lib/conversations", () => ({
  deleteConversation: vi.fn(),
  listConversationsPage: vi.fn(),
  renameConversation: vi.fn(),
  setConversationStarred: vi.fn(),
}));

const contextMocks = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }));

// The page renames and deletes through the conversations context so the sidebar and top bar stay in
// step. The context's own methods are thin wrappers over these client functions, so the stub
// delegates to them and the assertions below still pin the request that reaches the API.
vi.mock("~/lib/conversations-context", async () => {
  const client = await import("~/lib/conversations");
  return {
    useConversations: () => ({
      refresh: contextMocks.refresh,
      renameChat: client.renameConversation,
      removeChat: client.deleteConversation,
    }),
  };
});

import {
  deleteConversation,
  listConversationsPage,
  renameConversation,
  setConversationStarred,
} from "~/lib/conversations";

const convo = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c1",
  title: "Inventory Planning",
  agentId: null,
  starred: false,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-08T00:00:00Z",
  ...over,
});

function renderWithItems(
  node: ReactElement,
  items: ConversationSummary[],
  nextCursor: string | null = null
) {
  vi.mocked(remix.useLoaderData).mockReturnValue({ items, nextCursor });
  const Stub = createRemixStub([{ path: "/", Component: () => node }]);
  render(<Stub initialEntries={["/"]} />);
}

test("lists chats linking each row to /chat/:id, with search and a new-chat action", () => {
  renderWithItems(<ChatsRoute />, [convo()]);
  expect(screen.queryByRole("main")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Inventory Planning/ })).toHaveAttribute(
    "href",
    "/chat/c1"
  );
  expect(screen.getByLabelText("search chats")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /New chat/i })).toHaveAttribute("href", "/");
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
  expect(screen.getByRole("heading", { name: "Starred" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
});

test("typing in the search box refetches server-side with the query", async () => {
  vi.mocked(listConversationsPage).mockResolvedValue({ items: [], nextCursor: null });
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.change(screen.getByLabelText("search chats"), { target: { value: "budget" } });
  await waitFor(() =>
    expect(listConversationsPage).toHaveBeenCalledWith({ q: "budget", limit: 20 })
  );
});

test("loading the next batch appends past the initial 20 and stops once nextCursor is null", async () => {
  vi.mocked(listConversationsPage).mockResolvedValue({
    items: [convo({ id: "c2", title: "Second" })],
    nextCursor: null,
  });
  renderWithItems(<ChatsRoute />, [convo()], "cursor-1");

  const [observer] = capturedObservers;
  observer.trigger();

  await screen.findByRole("link", { name: /Second/ });
  expect(listConversationsPage).toHaveBeenCalledWith({ limit: 20, cursor: "cursor-1" });
  expect(screen.getByRole("link", { name: /Inventory Planning/ })).toBeInTheDocument();
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

test("deleting a chat requires confirmation and removes it from the list", async () => {
  vi.mocked(deleteConversation).mockResolvedValue(undefined);
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.click(screen.getByRole("button", { name: /chat actions/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));

  expect(deleteConversation).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Delete chat" })).toHaveTextContent(
    "Permanently delete “Inventory Planning” and all of its messages? This cannot be undone."
  );

  fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
  await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith("c1"));
  expect(screen.queryByRole("link", { name: /Inventory Planning/ })).not.toBeInTheDocument();
});

test("the rename field caps the title at the length the API accepts", async () => {
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.click(screen.getByRole("button", { name: /chat actions/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
  const input = screen.getByLabelText("Rename chat") as HTMLInputElement;
  expect(input).toHaveAttribute("maxlength", String(CHAT_TITLE_MAX_LENGTH));

  // A paste is not bound by `maxlength`, so the change handler has to do the capping itself.
  fireEvent.change(input, { target: { value: "x".repeat(CHAT_TITLE_MAX_LENGTH + 40) } });
  expect(input.value).toHaveLength(CHAT_TITLE_MAX_LENGTH);
  expect(screen.getByText("0")).toBeInTheDocument();
});

test("a failed delete keeps the chat and shows the API error", async () => {
  vi.mocked(deleteConversation).mockRejectedValue(new Error("Turn in progress"));
  renderWithItems(<ChatsRoute />, [convo()]);
  fireEvent.click(screen.getByRole("button", { name: /chat actions/i }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
  fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Turn in progress");
  expect(screen.getByRole("link", { name: /Inventory Planning/ })).toBeInTheDocument();
});
