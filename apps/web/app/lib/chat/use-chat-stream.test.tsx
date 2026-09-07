import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
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
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      <button type="button" onClick={() => void interact()}>
        Choose
      </button>
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
