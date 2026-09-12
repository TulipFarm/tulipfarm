import { createRemixStub } from "@remix-run/testing";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ConversationTurn } from "~/lib/conversations";
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

function openStreamResponse(frames: string, signal?: AbortSignal) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    },
  });
  return new Response(body, { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      <p>{chat.error}</p>
      <p>{assistant?.parts.find((part) => part.kind === "text")?.text}</p>
      <p>{tool?.kind === "tool" ? `${tool.toolName}:${tool.outcome}` : ""}</p>
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
      <p>{chat.error}</p>
      <p>{assistant?.parts.find((part) => part.kind === "text")?.text}</p>
    </div>
  );
}

function RetryRestoreHarness() {
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages: [
      ...initialMessages,
      {
        id: "message-old-reply",
        role: "assistant",
        parts: [{ kind: "text", text: "The first attempt failed" }],
        sealed: true,
      },
    ],
    initialTurn,
  });
  return (
    <div>
      <p>{chat.status}</p>
      <p>{chat.error}</p>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
    </div>
  );
}

function PersistedAttemptHarness({ turn = initialTurn }: { turn?: ConversationTurn }) {
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages: [
      ...initialMessages,
      {
        id: "attempt-1",
        role: "assistant",
        parts: [{ kind: "text", text: "Already saved. " }],
        sealed: false,
        turnAttempt: {
          runId: "run-1",
          attempt: 1,
          cursor: 7,
          outcome: "waiting",
          complete: false,
        },
      },
    ],
    initialTurn: turn,
  });
  return (
    <div>
      <p>{chat.status}</p>
      <p>{chat.error}</p>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
    </div>
  );
}

function EquivalentLoaderHarness() {
  const [revision, setRevision] = useState(0);
  const [turn, setTurn] = useState({ ...initialTurn });
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages,
    initialTurn: turn,
  });
  return (
    <div>
      <p>{chat.status}</p>
      <p>loader revision {revision}</p>
      <button
        type="button"
        onClick={() => {
          setTurn({ ...turn });
          setRevision((value) => value + 1);
        }}
      >
        Refresh loader
      </button>
    </div>
  );
}

function StalePendingRestoreHarness() {
  const [turn, setTurn] = useState<ConversationTurn>(initialPendingTurn);
  const chat = useChatStream({
    initialConversationId: "conversation-1",
    initialMessages,
    initialTurn: turn,
  });
  return (
    <div>
      <p>{chat.status}</p>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
      <button
        type="button"
        onClick={() => setTurn({ id: "turn-new", runId: "run-new", status: "running" })}
      >
        Load newer Turn
      </button>
      <button type="button" onClick={chat.stop}>
        Stop
      </button>
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

test("restores the current running retry even when history ends with an older assistant reply", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse(
        'id: 1\nevent: text.delta\ndata: {"text":"The retry worked"}\n\n' +
          'id: 2\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"message-2"}\n\n'
      )
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: RetryRestoreHarness }]);

  render(<App />);

  expect(await screen.findByText("The retry worked")).toBeInTheDocument();
  expect(screen.getByText("The first attempt failed")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("continues a persisted attempt strictly after its durable cursor", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse(
        'id: 8\nevent: text.delta\ndata: {"text":"and resumed."}\n\n' +
          'id: 9\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"attempt-1"}\n\n'
      )
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: PersistedAttemptHarness }]);

  render(<App />);

  expect(await screen.findByText("Already saved. and resumed.")).toBeInTheDocument();
  expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/runs/run-1/events?after=7");
});

test("does not replay a failed Turn whose attempt history is already persisted", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([
    {
      path: "/",
      Component: () => (
        <PersistedAttemptHarness turn={{ id: "turn-1", runId: "run-1", status: "failed" }} />
      ),
    },
  ]);

  render(<App />);

  expect(screen.getByText("Already saved.")).toBeInTheDocument();
  expect(screen.getByText("The model request failed. Try again.")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("never adopts another Turn while polling a pending submission", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    Response.json({
      id: "conversation-1",
      userId: "user-1",
      agentId: null,
      model: null,
      title: null,
      starred: false,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:01.000Z",
      latestTurn: { id: "turn-2", runId: "run-2", status: "running" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: PendingHarness }]);

  render(<App />);

  expect(
    await screen.findByText("The response state changed while it was being restored.")
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/chats/conversation-1");
});

test("does not replay the same running Turn again for an equivalent loader object", async () => {
  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        }),
        { status: 200 }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const App = createRemixStub([{ path: "/", Component: EquivalentLoaderHarness }]);

  render(<App />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  await user.click(screen.getByRole("button", { name: "Refresh loader" }));
  await screen.findByText("loader revision 1");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchMock).toHaveBeenCalledOnce();
});

test("ignores a stale pending restore after a newer Run starts", async () => {
  const oldConversation = deferred<Response>();
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.includes("/api/v1/chats/conversation-1")) return oldConversation.promise;
    if (url.includes("/api/v1/runs/run-new/events")) {
      return openStreamResponse(
        'id: 1\nevent: text.delta\ndata: {"text":"new run answer"}\n\n',
        init?.signal ?? undefined
      );
    }
    if (url.includes("/api/v1/chat/runs/run-new/stop")) {
      return Response.json({ status: "cancelled" });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const App = createRemixStub([{ path: "/", Component: StalePendingRestoreHarness }]);

  render(<App />);
  await waitFor(() =>
    expect(urls.some((url) => url.includes("/api/v1/chats/conversation-1"))).toBe(true)
  );

  await user.click(screen.getByRole("button", { name: "Load newer Turn" }));
  expect(await screen.findByText("new run answer")).toBeInTheDocument();

  await act(async () => {
    oldConversation.resolve(
      Response.json({
        id: "conversation-1",
        userId: "user-1",
        agentId: null,
        model: null,
        title: null,
        starred: false,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:01.000Z",
        latestTurn: { id: "turn-old", runId: "run-old", status: "running" },
      })
    );
    await Promise.resolve();
  });

  expect(screen.getByText("new run answer")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(urls.some((url) => url.includes("/api/v1/chat/runs/run-new/stop"))).toBe(true)
  );
  expect(urls.some((url) => url.includes("/api/v1/chat/runs/run-old/stop"))).toBe(false);
});
