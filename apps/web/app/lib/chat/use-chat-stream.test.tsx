import { createRemixStub } from "@remix-run/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  postChat,
  postSurfaceInteraction,
  resumeRun,
  sendApprovalDecision,
  stopChatRun,
} from "~/lib/chat/sse-client";
import { useChatStream } from "./use-chat-stream";

vi.mock("~/lib/chat/sse-client", () => ({
  postChat: vi.fn(),
  postChatRetry: vi.fn(),
  postSurfaceInteraction: vi.fn(),
  resumeRun: vi.fn(),
  sendApprovalDecision: vi.fn(),
  stopChatRun: vi.fn(),
}));

const mockPostChat = vi.mocked(postChat);
const mockPostSurfaceInteraction = vi.mocked(postSurfaceInteraction);

beforeEach(() => {
  vi.clearAllMocks();
  mockPostChat.mockResolvedValue(undefined);
  mockPostSurfaceInteraction.mockResolvedValue(undefined);
  vi.mocked(resumeRun).mockResolvedValue(undefined);
  vi.mocked(sendApprovalDecision).mockResolvedValue(undefined);
  vi.mocked(stopChatRun).mockResolvedValue(undefined);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const chat = useChatStream();
  const [outcome, setOutcome] = useState("idle");

  async function interact() {
    try {
      await chat.sendSurfaceInteraction("choice-handle", { value: "approve" });
      setOutcome("resolved");
    } catch {
      setOutcome("rejected");
    }
  }

  return (
    <>
      <p>{chat.status}</p>
      <p>{chat.error ?? ""}</p>
      <p data-testid="outcome">{outcome}</p>
      <button type="button" onClick={() => void chat.send("start")}>
        Start
      </button>
      <button type="button" onClick={chat.stop}>
        Stop
      </button>
      <button type="button" onClick={() => void interact()}>
        Choose
      </button>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
    </>
  );
}

function renderHarness() {
  const Stub = createRemixStub([{ path: "/", Component: Harness }]);
  return render(<Stub initialEntries={["/"]} />);
}

test("a Surface interaction Promise stays pending until the follow-up send completes", async () => {
  const user = userEvent.setup();
  const stream = deferred();
  mockPostChat.mockReturnValue(stream.promise);
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Choose" }));
  await waitFor(() => expect(mockPostChat).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("outcome")).toHaveTextContent("idle");

  stream.resolve();
  await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
});

test("a failed Surface interaction rejects after exposing the Chat error", async () => {
  const user = userEvent.setup();
  mockPostSurfaceInteraction.mockRejectedValue(new Error("interaction failed"));
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Choose" }));

  await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
  expect(screen.getByText("interaction failed")).toBeInTheDocument();
  expect(mockPostChat).not.toHaveBeenCalled();
});

test("a Surface interaction rejects while Chat is busy", async () => {
  const user = userEvent.setup();
  mockPostChat.mockReturnValue(new Promise<void>(() => {}));
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("submitted");
  await user.click(screen.getByRole("button", { name: "Choose" }));

  await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
  expect(mockPostSurfaceInteraction).not.toHaveBeenCalled();
});

test("Stop during a pending POST cancels only the Run minted by that submission", async () => {
  const user = userEvent.setup();
  const stopRequest = deferred();
  let pendingHandlers: Parameters<typeof postChat>[1] | undefined;
  vi.mocked(stopChatRun).mockReturnValueOnce(
    stopRequest.promise.then(() => ({ status: "cancelled" }))
  );
  mockPostChat
    .mockImplementationOnce(async (_body, handlers) => {
      handlers.onMeta?.({ runId: "run-old", turnId: "turn-old" });
      handlers.onEvent({ type: "finish", data: { reason: "stop" } });
    })
    .mockImplementationOnce(
      (_body, handlers) =>
        new Promise<void>((_resolve, reject) => {
          pendingHandlers = handlers;
          handlers.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(mockPostChat).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("submitted");
  await user.click(screen.getByRole("button", { name: "Stop" }));

  expect(stopChatRun).not.toHaveBeenCalled();
  act(() => {
    pendingHandlers?.onMeta?.({ runId: "run-new", turnId: "turn-new" });
  });

  await waitFor(() => expect(stopChatRun).toHaveBeenCalledWith("run-new"));
  expect(stopChatRun).not.toHaveBeenCalledWith("run-old");
  expect(pendingHandlers?.signal?.aborted).toBe(false);
  stopRequest.resolve();
  await waitFor(() => expect(pendingHandlers?.signal?.aborted).toBe(true));
});

test("a failed Stop request keeps the pending submission and surfaces the failure", async () => {
  const user = userEvent.setup();
  mockPostChat.mockImplementation(
    (_body, handlers) =>
      new Promise<void>((_resolve, reject) => {
        handlers.onMeta?.({ runId: "run-new", turnId: "turn-new" });
        handlers.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })
  );
  vi.mocked(stopChatRun).mockRejectedValueOnce(new Error("stop request failed"));
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("submitted");
  await user.click(screen.getByRole("button", { name: "Stop" }));

  expect(await screen.findByText("stop request failed")).toBeInTheDocument();
  expect(screen.getByText("start")).toBeInTheDocument();
  expect(screen.getByText("error")).toBeInTheDocument();
});

test("a stale live stream failure cannot overwrite a newer submission", async () => {
  const user = userEvent.setup();
  const oldStream = deferred();
  const currentStream = deferred();
  mockPostChat.mockReturnValueOnce(oldStream.promise).mockReturnValueOnce(currentStream.promise);
  renderHarness();

  await user.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(mockPostChat).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(mockPostChat).toHaveBeenCalledTimes(2));

  await act(async () => {
    oldStream.reject(new Error("old stream failed"));
    await Promise.resolve();
  });

  expect(screen.queryByText("old stream failed")).not.toBeInTheDocument();
  expect(screen.getByText("submitted")).toBeInTheDocument();
  expect(screen.getAllByText("start")).toHaveLength(2);
});
