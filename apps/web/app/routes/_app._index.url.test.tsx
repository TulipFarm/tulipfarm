import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ChatRoute from "~/routes/_app._index";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

// Stub ChatPanel so the test can fire its `onConversationChange` exactly as the SSE stream would when
// a new conversation id arrives — isolating the index route's URL-sync behavior.
let onConversationChange: ((id?: string) => void) | undefined;
vi.mock("~/components/chat/chat-panel", () => ({
  ChatPanel: (props: { onConversationChange?: (id?: string) => void }) => {
    onConversationChange = props.onConversationChange;
    return null;
  },
}));

const Stub = createRemixStub([{ path: "/", Component: ChatRoute }]);

beforeEach(() => {
  onConversationChange = undefined;
  window.history.replaceState(null, "", "/");
  vi.mocked(remix.useLoaderData).mockReturnValue({
    agentId: undefined,
    defaultModel: "standard",
    suggestions: [],
  });
});

afterEach(() => vi.restoreAllMocks());

test("reflects a newly created conversation in the URL via replaceState", () => {
  const spy = vi.spyOn(window.history, "replaceState");
  render(<Stub initialEntries={["/"]} />);

  onConversationChange?.("abc-123");

  expect(spy).toHaveBeenCalledWith(null, "", "/chat/abc-123");
});

test("does not rewrite the URL once already on a /chat/:id route", () => {
  window.history.replaceState(null, "", "/chat/existing");
  const spy = vi.spyOn(window.history, "replaceState");
  render(<Stub initialEntries={["/"]} />);

  onConversationChange?.("abc-123");

  // pathname is /chat/existing (≠ "/") → the one-shot guard skips the rewrite.
  expect(spy).not.toHaveBeenCalled();
});

test("a callback without an id (e.g. finish before an id) leaves the URL untouched", () => {
  const spy = vi.spyOn(window.history, "replaceState");
  render(<Stub initialEntries={["/"]} />);

  onConversationChange?.(undefined);

  expect(spy).not.toHaveBeenCalled();
});
