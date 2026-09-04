import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as agents from "~/lib/agents";
import { ApiError } from "~/lib/api";
import type { ChatMessage } from "~/lib/chat/types";
import * as conversations from "~/lib/conversations";
import ChatConversationRoute, { clientLoader } from "./_app.chat.$id";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});
vi.mock("~/lib/conversations", () => ({
  getConversation: vi.fn(),
  getConversationMessages: vi.fn(),
}));
vi.mock("~/lib/agents", () => ({
  getAgent: vi.fn(),
  listAgents: vi.fn(() => Promise.resolve([])),
}));

const loaderArgs = (id: string) =>
  ({ params: { id } }) as unknown as Parameters<typeof clientLoader>[0];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.clearAllMocks());

test("clientLoader hydrates the conversation transcript", async () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  vi.mocked(conversations.getConversation).mockResolvedValue({
    id: conversationId,
    title: "Inventory",
    agentId: "GeneralAssistant",
    userId: "u1",
    model: null,
    starred: false,
    createdAt: "t",
    updatedAt: "t",
    latestTurn: null,
  });
  vi.mocked(conversations.getConversationMessages).mockResolvedValue([
    {
      _id: "m1",
      conversationId,
      role: "user",
      content: "hello world",
      createdAt: "t",
    },
    {
      _id: "m2",
      conversationId,
      role: "assistant",
      content: "hi back",
      createdAt: "t",
    },
  ]);
  vi.mocked(agents.getAgent).mockResolvedValue({
    name: "GeneralAssistant",
    model: "balanced",
  } as unknown as Awaited<ReturnType<typeof agents.getAgent>>);

  const data = await clientLoader(loaderArgs(conversationId));
  expect(data.id).toBe(conversationId);
  expect(data.agentId).toBe("GeneralAssistant");
  expect(data.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("clientLoader redirects to / when the conversation is missing (404)", async () => {
  vi.mocked(conversations.getConversation).mockRejectedValue(new ApiError(404, "not found"));
  vi.mocked(conversations.getConversationMessages).mockRejectedValue(
    new ApiError(404, "not found")
  );
  await expect(
    clientLoader(loaderArgs("00000000-0000-4000-8000-000000000000"))
  ).rejects.toMatchObject({ status: 302 });
});

test("clientLoader redirects malformed conversation ids before calling the API", async () => {
  await expect(clientLoader(loaderArgs("not-a-uuid"))).rejects.toMatchObject({ status: 302 });
  expect(conversations.getConversation).not.toHaveBeenCalled();
  expect(conversations.getConversationMessages).not.toHaveBeenCalled();
});

test("renders the rehydrated transcript", async () => {
  const messages: ChatMessage[] = [
    { id: "x", role: "user", parts: [{ kind: "text", text: "hello world" }], sealed: true },
  ];
  vi.mocked(remix.useLoaderData).mockReturnValue({
    id: "c1",
    title: "Inventory",
    agentId: "GeneralAssistant",
    defaultModel: "auto",
    messages,
  });
  const Stub = createRemixStub([{ path: "/", Component: () => <ChatConversationRoute /> }]);
  render(<Stub initialEntries={["/"]} />);
  // The transcript is code-split, so it resolves a tick after the route renders.
  expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeInTheDocument();
  expect(await screen.findByText("hello world")).toBeInTheDocument();
});
