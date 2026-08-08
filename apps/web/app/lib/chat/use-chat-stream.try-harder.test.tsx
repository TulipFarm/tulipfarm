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

function finishedTurn(text: string, effortPreset: "auto" | "thorough", messageId: string): string {
  return (
    `id: 1\nevent: text.delta\ndata: {"text":"${text}"}\n\n` +
    `id: 2\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"${messageId}",` +
    `"modelId":"claude-sonnet-5","effortPreset":"${effortPreset}","modelCallLatencyMs":25}\n\n`
  );
}

function Harness() {
  const chat = useChatStream();
  const assistants = chat.messages.filter((message) => message.role === "assistant");
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void chat.send("Analyze the account", {
            model: "auto",
            agentId: "agent-1",
            skills: ["triage"],
            resources: ["ticket"],
            knowledgePages: ["page-1"],
          })
        }
      >
        Send
      </button>
      {assistants.map((message, index) => (
        <button
          key={message.id}
          type="button"
          onClick={() => void chat.tryHarder(message.id, "thorough")}
        >
          Try harder {index + 1}
        </button>
      ))}
      <p data-testid="message-count">{chat.messages.length}</p>
      {chat.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")}
        </p>
      ))}
    </div>
  );
}

test("Try harder appends a new turn with carried context and a fresh idempotency key", async () => {
  const user = userEvent.setup();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse(finishedTurn("first answer", "auto", "m1"), {
        "X-Conversation-Id": "c1",
        "X-Run-Id": "r1",
      })
    )
    .mockResolvedValueOnce(
      streamResponse(finishedTurn("second answer", "thorough", "m2"), {
        "X-Conversation-Id": "c1",
        "X-Run-Id": "r2",
      })
    );
  vi.stubGlobal("fetch", fetchMock);
  const App = createRemixStub([{ path: "/", Component: Harness }]);

  render(<App />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("first answer");

  await user.click(screen.getByRole("button", { name: "Try harder 1" }));
  await screen.findByText("second answer");

  expect(screen.getByText("first answer")).toBeInTheDocument();
  expect(screen.getByText("second answer")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("message-count")).toHaveTextContent("4"));

  const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
  const firstHeaders = firstInit?.headers as Record<string, string>;
  const secondHeaders = secondInit?.headers as Record<string, string>;
  expect(firstHeaders["Idempotency-Key"]).toEqual(expect.any(String));
  expect(secondHeaders["Idempotency-Key"]).toEqual(expect.any(String));
  expect(secondHeaders["Idempotency-Key"]).not.toBe(firstHeaders["Idempotency-Key"]);

  const firstBody = JSON.parse(String(firstInit?.body)) as Record<string, unknown>;
  const secondBody = JSON.parse(String(secondInit?.body)) as Record<string, unknown>;
  expect(firstBody).toMatchObject({
    message: { role: "user", content: "Analyze the account" },
    model: "auto",
    agentId: "agent-1",
    skills: ["triage"],
    resources: ["ticket"],
    knowledgePages: ["page-1"],
  });
  expect(secondBody).toMatchObject({
    message: { role: "user", content: "Analyze the account" },
    conversationId: "c1",
    model: "thorough",
    agentId: "agent-1",
    skills: ["triage"],
    resources: ["ticket"],
    knowledgePages: ["page-1"],
  });
});
