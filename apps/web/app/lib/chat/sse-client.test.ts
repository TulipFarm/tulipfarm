import { expect, test } from "vitest";
import { parseSseFrames } from "~/lib/chat/sse-client";

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
