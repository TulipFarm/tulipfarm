import { createRemixStub } from "@remix-run/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "./types";
import { useChatStream } from "./use-chat-stream";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function streamResponse(frames: string) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const initialMessages: ChatMessage[] = [
  {
    id: "message-1",
    role: "user",
    parts: [{ kind: "text", text: "Check the records" }],
    sealed: true,
  },
];

const initialTurn = { id: "turn-1", runId: "run-1", status: "running" } as const;
const initialPendingTurn = { id: "turn-1", runId: null, status: "pending" } as const;

const frames =
  'id: 1\nevent: text.delta\ndata: {"text":"Checking"}\n\n' +
  'id: 2\nevent: tool.call\ndata: {"callId":"c1","name":"record_list","argsDigest":"d1"}\n\n' +
  'id: 3\nevent: tool.result\ndata: {"callId":"c1","status":"error","errorCode":"timeout"}\n\n' +
  'id: 4\nevent: turn.finished\ndata: {"status":"failed","reason":"model_timeout"}\n\n';

function Harness() {
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages,
    initialTurn,
  });
  const assistant = chat.messages.find((message) => message.role === "assistant");
  const tool = assistant?.parts.find((part) => part.kind === "tool");
  return (
    <div>
      <p>{chat.status}</p>
      <p>{assistant?.parts.find((part) => part.kind === "text")?.text}</p>
      <p>{tool?.kind === "tool" ? `${tool.toolName}:${tool.outcome}` : ""}</p>
      <p>{chat.error}</p>
    </div>
  );
}

function PendingHarness() {
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages,
    initialTurn: initialPendingTurn,
  });
  const assistant = chat.messages.find((message) => message.role === "assistant");
  return (
    <div>
      <p>{chat.status}</p>
      <p>{assistant?.parts.find((part) => part.kind === "text")?.text}</p>
    </div>
  );
}

test("rebuilds streamed text, Tool failure, and model error every time the Chat mounts", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(streamResponse(frames))
    .mockResolvedValueOnce(streamResponse(frames));
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: Harness }]);

  const first = render(<App />);
  expect(await screen.findByText("Checking")).toBeInTheDocument();
  expect(screen.getByText("record_list:error")).toBeInTheDocument();
  expect(screen.getByText("The model request failed. Try again.")).toBeInTheDocument();
  first.unmount();

  render(<App />);
  expect(await screen.findByText("Checking")).toBeInTheDocument();
  expect(screen.getByText("record_list:error")).toBeInTheDocument();
  expect(screen.getByText("The model request failed. Try again.")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("keeps the loading state while a pending Turn receives its Run", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: "conversation-1",
        userId: "user-1",
        agentId: null,
        model: null,
        title: null,
        starred: false,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:01.000Z",
        latestTurn: { id: "turn-1", runId: "run-1", status: "running" },
      })
    )
    .mockResolvedValueOnce(
      streamResponse(
        'id: 1\nevent: text.delta\ndata: {"text":"Started"}\n\n' +
          'id: 2\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"message-2"}\n\n'
      )
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: PendingHarness }]);

  render(<App />);
  expect(screen.getByText("submitted")).toBeInTheDocument();
  expect(await screen.findByText("Started", {}, { timeout: 1_000 })).toBeInTheDocument();
  expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/chats/conversation-1");
  expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/v1/runs/run-1/events?after=0");
});
