import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as agents from "~/lib/agents";
import { ApiError } from "~/lib/api";
import type { ChatMessage } from "~/lib/chat/types";
import * as conversations from "~/lib/conversations";
import ChatConversationRoute, { clientLoader } from "./_app.chat.$id";

/*
 * Restore-route tests: the clientLoader hydrates a persisted conversation (and redirects a missing one
 * to the new-chat surface), and the Component renders the rehydrated transcript. useLoaderData/lib
 * calls are mocked; Link needs router context → createRemixStub at "/".
 */
vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});
vi.mock("~/lib/conversations", () => ({
  getConversation: vi.fn(),
  getConversationMessages: vi.fn(),
}));
vi.mock("~/lib/agents", () => ({ getAgent: vi.fn() }));

const loaderArgs = (id: string) =>
  ({ params: { id } }) as unknown as Parameters<typeof clientLoader>[0];

// jsdom has no layout engine; the transcript's auto-scroll calls scrollIntoView.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.clearAllMocks());

test("clientLoader hydrates the conversation transcript", async () => {
  vi.mocked(conversations.getConversation).mockResolvedValue({
    id: "c1",
    title: "Inventory",
    agentId: "GeneralAssistant",
    userId: "u1",
    model: null,
    createdAt: "t",
    updatedAt: "t",
  });
  vi.mocked(conversations.getConversationMessages).mockResolvedValue([
    { _id: "m1", conversationId: "c1", role: "user", content: "hello world", createdAt: "t" },
    { _id: "m2", conversationId: "c1", role: "assistant", content: "hi back", createdAt: "t" },
  ]);
  vi.mocked(agents.getAgent).mockResolvedValue({
    name: "GeneralAssistant",
    model: "standard",
  } as unknown as Awaited<ReturnType<typeof agents.getAgent>>);

  const data = await clientLoader(loaderArgs("c1"));
  expect(data.id).toBe("c1");
  expect(data.agentId).toBe("GeneralAssistant");
  expect(data.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("clientLoader redirects to / when the conversation is missing (404)", async () => {
  vi.mocked(conversations.getConversation).mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(conversations.getConversationMessages).mockRejectedValue(
    new ApiError(404, "not found")
  );
  await expect(clientLoader(loaderArgs("missing"))).rejects.toMatchObject({ status: 302 });
});

test("renders the rehydrated transcript", () => {
  const messages: ChatMessage[] = [
    { id: "x", role: "user", parts: [{ kind: "text", text: "hello world" }], sealed: true },
  ];
  vi.mocked(remix.useLoaderData).mockReturnValue({
    id: "c1",
    agentId: "GeneralAssistant",
    defaultModel: "standard",
    messages,
  });
  const Stub = createRemixStub([{ path: "/", Component: () => <ChatConversationRoute /> }]);
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("hello world")).toBeInTheDocument();
});
