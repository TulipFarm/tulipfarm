import { expect, test } from "vitest";
import { parseMessage } from "~/lib/a2ui/protocol";

test("parses agent/api/navigate envelopes", () => {
  for (const channel of ["agent", "api", "navigate"] as const) {
    expect(parseMessage({ channel, payload: { x: 1 } })).toEqual({ channel, payload: { x: 1 } });
  }
});

test("accepts a present-but-null payload key", () => {
  expect(parseMessage({ channel: "agent", payload: null })).toEqual({
    channel: "agent",
    payload: null,
  });
});

test("parses internal resize and ready", () => {
  expect(parseMessage({ __a2ui: "resize", height: 240 })).toEqual({
    __a2ui: "resize",
    height: 240,
  });
  expect(parseMessage({ __a2ui: "ready" })).toEqual({ __a2ui: "ready" });
});

test("rejects an unknown channel", () => {
  expect(parseMessage({ channel: "evil", payload: 1 })).toBeNull();
});

test("rejects a missing payload key", () => {
  expect(parseMessage({ channel: "agent" })).toBeNull();
});

test("rejects resize without a numeric height", () => {
  expect(parseMessage({ __a2ui: "resize" })).toBeNull();
  expect(parseMessage({ __a2ui: "resize", height: "tall" })).toBeNull();
});

test("rejects an unknown __a2ui kind", () => {
  expect(parseMessage({ __a2ui: "explode" })).toBeNull();
});

test("rejects non-objects and structural junk", () => {
  for (const junk of [null, undefined, 42, "str", [], true]) {
    expect(parseMessage(junk)).toBeNull();
  }
});
