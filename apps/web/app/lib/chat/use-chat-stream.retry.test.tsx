import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { useChatStream } from "./use-chat-stream";

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamResponse(frames: string, headers: Record<string, string> = {}) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

/** One completed tool call, then the model call dying the way a provider 529 does. */
const TOOLS_THEN_PROVIDER_FAILURE =
  `id: 1\nevent: tool.call\ndata: {"callId":"c-1","name":"api_request"}\n\n` +
  `id: 2\nevent: tool.result\ndata: {"callId":"c-1","status":"ok","summary":"200 OK"}\n\n` +
  `id: 3\nevent: turn.finished\ndata: {"status":"failed","reason":"model_provider_unavailable"}\n\n`;

const RESUMED_ANSWER =
  `id: 4\nevent: text.delta\ndata: {"text":"the routine is ready"}\n\n` +
  `id: 5\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"m1"}\n\n`;

function Harness() {
  const chat = useChatStream();
  const tools = chat.messages.flatMap((message) =>
    message.parts.filter((part) => part.kind === "tool")
  );
  return (
    <div>
      <button type="button" onClick={() => void chat.send("track the stars", { model: "auto" })}>
        Send
      </button>
      <button type="button" onClick={() => void chat.regenerate()}>
        Retry
      </button>
      <p data-testid="tool-count">{tools.length}</p>
      <p data-testid="message-count">{chat.messages.length}</p>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
    </div>
  );
}

test("Retry resumes the Turn, keeping the tools the failed attempt already ran", async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse(TOOLS_THEN_PROVIDER_FAILURE, {
        "X-Conversation-Id": "c1",
        "X-Run-Id": "r1",
        "X-Turn-Id": "t1",
      })
    )
    .mockResolvedValueOnce(
      streamResponse(RESUMED_ANSWER, {
        "X-Conversation-Id": "c1",
        "X-Run-Id": "r2",
        "X-Turn-Id": "t1",
      })
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: Harness }]);

  render(<App />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByTestId("tool-count")).toHaveTextContent("1"));

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("the routine is ready");

  // A resumed attempt never re-emits the calls it is resuming from, so the only way the tool
  // survives on screen is if the retry kept the failed attempt's message instead of popping it.
  expect(screen.getByTestId("tool-count")).toHaveTextContent("1");
  expect(screen.getByTestId("message-count")).toHaveTextContent("2");

  expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/v1\/chat\/turns\/t1\/retry$/);
});

test("Retry re-asks the question when no Turn was named, and drops the dead attempt", async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse(TOOLS_THEN_PROVIDER_FAILURE, {
        "X-Conversation-Id": "c1",
        "X-Run-Id": "r1",
      })
    )
    .mockResolvedValueOnce(
      streamResponse(RESUMED_ANSWER, { "X-Conversation-Id": "c1", "X-Run-Id": "r2" })
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: Harness }]);

  render(<App />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByTestId("tool-count")).toHaveTextContent("1"));

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("the routine is ready");

  // Without a Turn id this is a fresh ask, so the old attempt's tools describe work the new one
  // has not done. Keeping them would credit this answer with calls it never made.
  expect(screen.getByTestId("tool-count")).toHaveTextContent("0");
  expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/v1\/chat$/);
});
