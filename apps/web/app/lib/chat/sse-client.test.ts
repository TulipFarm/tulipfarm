import { afterEach, expect, test, vi } from "vitest";
import {
  createRunEventMapper,
  modelFailureMessage,
  parseSseFrames,
  postChat,
} from "~/lib/chat/sse-client";

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

test("parses a single frame with the spec spacing (space after the colon)", () => {
  const { frames, rest } = parseSseFrames('id: 1\nevent: text\ndata: {"delta":"hi"}\n\n');
  expect(rest).toBe("");
  expect(frames).toEqual([{ seq: 1, type: "text", data: { delta: "hi" } }]);
});

test("parses multiple frames delivered in one chunk", () => {
  const chunk =
    'id: 1\nevent: text\ndata: {"delta":"a"}\n\n' + 'id: 2\nevent: text\ndata: {"delta":"b"}\n\n';
  const { frames, rest } = parseSseFrames(chunk);
  expect(rest).toBe("");
  expect(frames).toEqual([
    { seq: 1, type: "text", data: { delta: "a" } },
    { seq: 2, type: "text", data: { delta: "b" } },
  ]);
});

test("carries a frame split across two chunks in `rest`", () => {
  const first = parseSseFrames('id: 1\nevent: text\ndata: {"del');
  expect(first.frames).toEqual([]);
  expect(first.rest).toBe('id: 1\nevent: text\ndata: {"del');

  // Prepend the carried remainder to the next chunk, as the streaming reader does.
  const second = parseSseFrames(`${first.rest}ta":"hi"}\n\n`);
  expect(second.rest).toBe("");
  expect(second.frames).toEqual([{ seq: 1, type: "text", data: { delta: "hi" } }]);
});

test("tolerates the no-space variant of id:/event:/data:", () => {
  const { frames, rest } = parseSseFrames('id:7\nevent:finish\ndata:{"reason":"stop"}\n\n');
  expect(rest).toBe("");
  expect(frames).toEqual([{ seq: 7, type: "finish", data: { reason: "stop" } }]);
});

test("preserves JSON braces and colons inside the data payload", () => {
  const { frames } = parseSseFrames(
    'id: 3\nevent: tool-call\ndata: {"toolCallId":"c1","toolName":"http","args":{"url":"http://x/y"}}\n\n'
  );
  expect(frames).toEqual([
    {
      seq: 3,
      type: "tool-call",
      data: { toolCallId: "c1", toolName: "http", args: { url: "http://x/y" } },
    },
  ]);
});

test("ignores frames missing an event or data line", () => {
  const chunk =
    "id: 1\nevent: text\n\n" + // no data
    "id: 2\ndata: {}\n\n" + // no event
    'id: 3\nevent: text\ndata: {"delta":"ok"}\n\n';
  const { frames } = parseSseFrames(chunk);
  expect(frames).toEqual([{ seq: 3, type: "text", data: { delta: "ok" } }]);
});

test("ignores empty/whitespace-only frames and a frame whose data is invalid JSON", () => {
  const chunk =
    "\n\n" + // empty frame between flushes
    "id: 1\nevent: text\ndata: not-json\n\n" + // unparseable data
    'id: 2\nevent: text\ndata: {"delta":"good"}\n\n';
  const { frames } = parseSseFrames(chunk);
  expect(frames).toEqual([{ seq: 2, type: "text", data: { delta: "good" } }]);
});

test("defaults seq to 0 when no id line is present but event+data are", () => {
  const { frames } = parseSseFrames('event: text\ndata: {"delta":"x"}\n\n');
  expect(frames).toEqual([{ seq: 0, type: "text", data: { delta: "x" } }]);
});

test("recovers a dropped stream from the Run's own events without duplicating them", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      streamResponse('id: 1\nevent: text.delta\ndata: {"text":"hello","index":0}\n\n', {
        "X-Run-Id": "run-1",
      })
    )
    .mockResolvedValueOnce(
      streamResponse(
        'id: 1\nevent: text.delta\ndata: {"text":"hello","index":0}\n\n' +
          'id: 2\nevent: turn.finished\ndata: {"status":"succeeded","messageId":"msg-1"}\n\n'
      )
    );
  vi.stubGlobal("fetch", fetchMock);
  const events: string[] = [];
  const states: string[] = [];

  await postChat(
    { message: { role: "user", content: "hello" } },
    {
      onEvent: (event) => events.push(event.type),
      onConnectionState: (state) => states.push(state),
    }
  );

  expect(events).toEqual(["text", "finish"]);
  expect(states).toEqual(["reconnecting", "online"]);
  // The reconnect reads the Run, not a per-connection buffer: the turn kept running while the
  // connection was gone, so the cursor is what makes the replay exact.
  expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/v1/runs/run-1/events?after=1");
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    headers: expect.objectContaining({ "Last-Event-ID": "1" }),
  });
});

test("submits the effort preset id in the chat model field", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(streamResponse("id: 1\nevent: turn.finished\ndata: {}\n\n"));
  vi.stubGlobal("fetch", fetchMock);

  await postChat(
    { message: { role: "user", content: "hello" }, model: "balanced" },
    { onEvent: vi.fn() }
  );

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  expect(init?.body).toBe(
    JSON.stringify({ message: { role: "user", content: "hello" }, model: "balanced" })
  );
});

test("projects Run events onto the timeline vocabulary", () => {
  const map = createRunEventMapper();

  expect(map({ seq: 1, type: "turn.started", data: { turnId: "t1" } })).toEqual([]);
  expect(map({ seq: 2, type: "text.delta", data: { text: "hi", index: 0 } })).toEqual([
    { type: "text", data: { delta: "hi" } },
  ]);
  expect(
    map({ seq: 3, type: "tool.call", data: { callId: "c1", name: "send_email", argsDigest: "d1" } })
  ).toEqual([
    {
      type: "tool-call",
      data: {
        toolCallId: "c1",
        toolName: "send_email",
        args: { argsDigest: "d1" },
        meta: { argsDigest: "d1" },
      },
    },
  ]);
  // A stream that carries a preview surfaces the redacted arguments alongside the digest, which
  // stays the authority over what was really called.
  expect(
    map({
      seq: 4,
      type: "tool.call",
      data: {
        callId: "c2",
        name: "send_email",
        argsDigest: "d2",
        argsPreview: { json: '{"to":"ops@example.com"}', redactedPaths: ["apiKey"] },
        tier: "integration",
        mutating: true,
        stepId: "state-1",
      },
    })
  ).toEqual([
    {
      type: "tool-call",
      data: {
        toolCallId: "c2",
        toolName: "send_email",
        args: { argsDigest: "d2" },
        preview: { json: '{"to":"ops@example.com"}', redactedPaths: ["apiKey"] },
        meta: {
          argsDigest: "d2",
          tier: "integration",
          mutating: true,
          stepId: "state-1",
        },
      },
    },
  ]);
  // Operator-audience evidence has no participant counterpart, even when a reader is granted it.
  expect(map({ seq: 5, type: "tool.dispatched", data: { callId: "c1" } })).toEqual([]);
  expect(
    map({ seq: 6, type: "turn.finished", data: { status: "succeeded", messageId: "msg-1" } })
  ).toEqual([{ type: "finish", data: { reason: "stop", messageId: "msg-1" } }]);
});

test("projects a turn receipt from the participant-visible finish event", () => {
  const map = createRunEventMapper();

  expect(
    map({
      seq: 1,
      type: "turn.finished",
      data: {
        status: "succeeded",
        messageId: "msg-1",
        modelId: "claude-sonnet-5",
        effortPreset: "auto",
        modelCallLatencyMs: 1234,
      },
    })
  ).toEqual([
    {
      type: "finish",
      data: {
        reason: "stop",
        messageId: "msg-1",
        receipt: {
          modelId: "claude-sonnet-5",
          effortPreset: "auto",
          modelCallLatencyMs: 1234,
        },
      },
    },
  ]);
});

test("accepts older turn.finished events without receipt fields", () => {
  const map = createRunEventMapper();

  expect(
    map({ seq: 1, type: "turn.finished", data: { status: "succeeded", messageId: "msg-1" } })
  ).toEqual([{ type: "finish", data: { reason: "stop", messageId: "msg-1" } }]);
});

test("turns allowlisted model failures into actionable participant-safe messages", () => {
  const map = createRunEventMapper();

  expect(
    map({
      seq: 1,
      type: "turn.finished",
      data: { status: "failed", reason: "model_billing_inactive" },
    })
  ).toEqual([
    {
      type: "error",
      data: {
        message:
          "The model provider's API billing is inactive. Activate billing or use another Provider Credential.",
      },
    },
  ]);
  expect(modelFailureMessage("untrusted_provider_detail")).toBe(
    "The model request failed. Try again."
  );
  // An instance with no `llm:` config denies routing with `unknown_profile`. That must not land on
  // the generic default above: it is the one failure the reader can actually fix themselves.
  expect(modelFailureMessage("model_not_configured")).toBe(
    "No model is configured for this business. Add a model chain under Business → Models."
  );
});

test("releases a held Tool call when the decision lets it report", () => {
  const map = createRunEventMapper();

  map({ seq: 1, type: "tool.call", data: { callId: "c1", name: "send_email", argsDigest: "d1" } });
  expect(
    map({
      seq: 2,
      type: "approval.requested",
      data: { waitId: "w1", intentId: "a1", callId: "c1" },
    })
  ).toEqual([{ type: "approval-request", data: { approvalId: "a1", toolCallId: "c1" } }]);

  const settled = map({ seq: 3, type: "tool.result", data: { callId: "c1", status: "ok" } });
  expect(settled[1]).toEqual({
    type: "approval-resolved",
    data: { approvalId: "a1", toolCallId: "c1", outcome: "approved" },
  });
  // Released once: a later result for the same call is just a result.
  expect(map({ seq: 4, type: "tool.result", data: { callId: "c1", status: "ok" } })).toHaveLength(
    1
  );
});

test("shows a guardrail refusal without naming the guard, and only for the stages a reader sees", () => {
  const map = createRunEventMapper();

  expect(
    map({ seq: 1, type: "guardrail.blocked", data: { stage: "tool_call", reason: "blocklist" } })
  ).toEqual([]);
  expect(
    map({ seq: 2, type: "guardrail.blocked", data: { stage: "input", reason: "prompt_injection" } })
  ).toEqual([{ type: "guardrail_block", data: { stage: "input", reason: "prompt_injection" } }]);
});

test("releases the timeline when the Run ends without announcing the turn", () => {
  const map = createRunEventMapper();
  expect(map({ seq: 1, type: "stream.closed", data: { status: "cancelled" } })).toEqual([
    { type: "finish", data: { reason: "closed" } },
  ]);

  const announced = createRunEventMapper();
  announced({ seq: 1, type: "turn.finished", data: { status: "succeeded", messageId: "m1" } });
  expect(announced({ seq: 2, type: "stream.closed", data: { status: "succeeded" } })).toEqual([]);
});

test("surfaces an error when the Run ends badly and never said why", () => {
  // A close is the only frame such a turn produces. Reading it as a plain finish leaves the
  // composer idle with no answer and no banner — indistinguishable from a turn that succeeded.
  const failed = createRunEventMapper();
  expect(failed({ seq: 1, type: "stream.closed", data: { status: "failed" } })).toEqual([
    { type: "error", data: { message: "The turn stopped before it could answer. Try again." } },
  ]);

  const parked = createRunEventMapper();
  expect(
    parked({ seq: 1, type: "stream.closed", data: { status: "needs_reconciliation" } })
  ).toEqual([
    { type: "error", data: { message: "The turn stopped before it could answer. Try again." } },
  ]);
});

test("names a turn the runtime abandoned as such, not as a model failure", () => {
  // `turn_execution_failed` is written when the executor threw outside the model call, so blaming
  // the model provider would send the reader to the wrong settings page.
  expect(modelFailureMessage("turn_execution_failed")).toBe(
    "The turn stopped before it could answer. Try again."
  );
});
