import { createRemixStub } from "@remix-run/testing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationSummary } from "~/lib/conversations";
import * as conversations from "~/lib/conversations";
import { ConversationsProvider, useConversations } from "./conversations-context";

vi.mock("~/lib/conversations", () => ({
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const summary = (id: string): ConversationSummary => ({
  id,
  title: id,
  agentId: null,
  starred: false,
  createdAt: "t",
  updatedAt: "t",
});

afterEach(() => vi.clearAllMocks());

function Consumer() {
  const { conversations: list, refresh } = useConversations();
  return (
    <>
      <span data-testid="count">{list.length}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
    </>
  );
}

function renderProvider() {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <ConversationsProvider>
          <Consumer />
        </ConversationsProvider>
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

function ActiveConsumer() {
  const { activeChatId, setActiveChatId } = useConversations();
  return (
    <>
      <span data-testid="active">{activeChatId ?? "none"}</span>
      <button type="button" onClick={() => setActiveChatId("shallow-1")}>
        shallow
      </button>
    </>
  );
}

function renderActiveAt(path: string) {
  const provider = (
    <ConversationsProvider>
      <ActiveConsumer />
    </ConversationsProvider>
  );
  const Stub = createRemixStub([
    { path: "/", Component: () => provider },
    { path: "/chat/:id", Component: () => provider },
  ]);
  render(<Stub initialEntries={[path]} />);
}

test("derives activeChatId from a /chat/:id route", () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([]);
  renderActiveAt("/chat/abc-1");
  expect(screen.getByTestId("active").textContent).toBe("abc-1");
});

test("activeChatId is null on the new-chat surface, and a shallow setter overrides it", () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([]);
  renderActiveAt("/");
  expect(screen.getByTestId("active").textContent).toBe("none");
  // Mirrors the index route after replaceState (router location stays "/").
  act(() => {
    fireEvent.click(screen.getByText("shallow"));
  });
  expect(screen.getByTestId("active").textContent).toBe("shallow-1");
});

test("fetches once on mount and exposes the list", async () => {
  const d = deferred<ConversationSummary[]>();
  vi.mocked(conversations.listConversations).mockReturnValue(d.promise);
  renderProvider();
  expect(conversations.listConversations).toHaveBeenCalledTimes(1);
  await act(async () => {
    d.resolve([summary("c1"), summary("c2")]);
  });
  expect(screen.getByTestId("count").textContent).toBe("2");
});

test("coalesces refreshes requested during an in-flight fetch into one trailing fetch", async () => {
  const ds: Array<ReturnType<typeof deferred<ConversationSummary[]>>> = [];
  vi.mocked(conversations.listConversations).mockImplementation(() => {
    const d = deferred<ConversationSummary[]>();
    ds.push(d);
    return d.promise;
  });

  renderProvider();
  // Mount fetch is in flight.
  expect(conversations.listConversations).toHaveBeenCalledTimes(1);

  // Two refreshes while the first fetch is still pending → both coalesced, no new fetch yet.
  await act(async () => {
    fireEvent.click(screen.getByText("refresh"));
    fireEvent.click(screen.getByText("refresh"));
  });
  expect(conversations.listConversations).toHaveBeenCalledTimes(1);

  // Resolving the first fetch triggers exactly one trailing fetch (the coalesced refresh).
  await act(async () => {
    ds[0].resolve([summary("c1")]);
  });
  expect(conversations.listConversations).toHaveBeenCalledTimes(2);

  await act(async () => {
    ds[1].resolve([summary("c1"), summary("c2")]);
  });
  expect(conversations.listConversations).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("count").textContent).toBe("2");
});

function MutateConsumer() {
  const { conversations: list, renameChat, removeChat } = useConversations();
  const [failure, setFailure] = useState("none");
  return (
    <>
      <span data-testid="titles">{list.map((c) => c.title).join(",") || "none"}</span>
      <span data-testid="failure">{failure}</span>
      <button
        type="button"
        onClick={() => {
          renameChat("c1", "Renamed").catch((err: Error) => setFailure(err.message));
        }}
      >
        rename
      </button>
      <button
        type="button"
        onClick={() => {
          removeChat("c1").catch((err: Error) => setFailure(err.message));
        }}
      >
        remove
      </button>
    </>
  );
}

function renderMutableAt(path: string) {
  const provider = (
    <ConversationsProvider>
      <MutateConsumer />
    </ConversationsProvider>
  );
  const Stub = createRemixStub([
    { path: "/", Component: () => provider },
    { path: "/chat/:id", Component: () => provider },
  ]);
  render(<Stub initialEntries={[path]} />);
}

test("a rename folds the API's updated summary into the list without a refetch", async () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([summary("c1"), summary("c2")]);
  vi.mocked(conversations.renameConversation).mockResolvedValue({
    ...summary("c1"),
    title: "Renamed",
  });
  renderMutableAt("/");
  await act(async () => {});
  expect(screen.getByTestId("titles").textContent).toBe("c1,c2");

  await act(async () => {
    fireEvent.click(screen.getByText("rename"));
  });
  expect(conversations.renameConversation).toHaveBeenCalledWith("c1", "Renamed");
  expect(conversations.listConversations).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("titles").textContent).toBe("Renamed,c2");
});

test("a delete drops the chat from the list", async () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([summary("c1"), summary("c2")]);
  vi.mocked(conversations.deleteConversation).mockResolvedValue(undefined);
  renderMutableAt("/");
  await act(async () => {});

  await act(async () => {
    fireEvent.click(screen.getByText("remove"));
  });
  expect(conversations.deleteConversation).toHaveBeenCalledWith("c1");
  expect(screen.getByTestId("titles").textContent).toBe("c2");
});

// Deleting the chat on screen must not leave the user staring at a transcript the API just erased.
test("deleting the chat currently open routes back to the new-chat surface", async () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([summary("c1")]);
  vi.mocked(conversations.deleteConversation).mockResolvedValue(undefined);
  renderMutableAt("/chat/c1");
  await act(async () => {});

  await act(async () => {
    fireEvent.click(screen.getByText("remove"));
  });
  expect(window.location.pathname).toBe("/");
});

test("a failed rename leaves the list untouched and rejects to the caller", async () => {
  vi.mocked(conversations.listConversations).mockResolvedValue([summary("c1")]);
  vi.mocked(conversations.renameConversation).mockRejectedValue(new Error("nope"));
  renderMutableAt("/");
  await act(async () => {});

  await act(async () => {
    fireEvent.click(screen.getByText("rename"));
  });
  expect(screen.getByTestId("titles").textContent).toBe("c1");
  expect(screen.getByTestId("failure").textContent).toBe("nope");
});
