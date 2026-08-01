import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import {
  RUN_EVENT_DEFINITIONS,
  RUN_EVENT_SCHEMAS,
  RUN_EVENT_TYPES,
  type RunEventType,
  runEventDefinition,
  runEventSchemaRef,
} from "./run-events";

function accepts(type: RunEventType, payload: unknown): boolean {
  const definition = runEventDefinition(type);
  if (!definition) throw new Error(`no definition for ${type}`);
  return ajv.compile(definition.schema)(payload);
}

describe("run event vocabulary", () => {
  it("defines every declared type exactly once", () => {
    expect(RUN_EVENT_DEFINITIONS.map((d) => d.type)).toEqual([...RUN_EVENT_TYPES]);
    expect(new Set(RUN_EVENT_TYPES).size).toBe(RUN_EVENT_TYPES.length);
  });

  it("compiles every payload schema and gives each a unique ref", () => {
    for (const registration of RUN_EVENT_SCHEMAS) {
      expect(() => ajv.compile(registration.schema)).not.toThrow();
    }
    const refs = RUN_EVENT_SCHEMAS.map((registration) => registration.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(runEventSchemaRef("text.delta")).toBe("tulip.run-event.text-delta.v1");
  });

  it("assigns evidence events to the operator audience", () => {
    // A participant must never be handed the digests and dispatch records that exist for auditing.
    const operator = RUN_EVENT_DEFINITIONS.filter((d) => d.audience === "operator").map(
      (d) => d.type
    );
    expect(operator).toEqual([
      "context.assembled",
      "tool.dispatched",
      "guardrail.decision",
      "delivery.classified",
    ]);
  });

  it("has no definition for a type outside the vocabulary", () => {
    expect(runEventDefinition("text.token")).toBeUndefined();
  });

  it("accepts the payloads a turn actually emits", () => {
    expect(accepts("turn.started", { turnId: "t1", attempt: 0, agentId: "assistant" })).toBe(true);
    expect(accepts("text.delta", { text: "hello there", index: 0 })).toBe(true);
    expect(accepts("tool.call", { callId: "c1", name: "record_create", argsDigest: "sha" })).toBe(
      true
    );
    expect(accepts("tool.result", { callId: "c1", status: "ok", summary: "1 row" })).toBe(true);
    expect(accepts("approval.requested", { waitId: "w1", intentId: "i1" })).toBe(true);
    expect(accepts("turn.finished", { status: "succeeded", messageId: "m1" })).toBe(true);
  });

  it("allows a finished turn to carry no Message", () => {
    // A blocked, failed, or cancelled turn produces none, and null says so rather than leaving the
    // reader to infer absence from a missing field.
    expect(accepts("turn.finished", { status: "failed", messageId: null })).toBe(true);
  });

  it("rejects a payload missing a field its reader depends on", () => {
    expect(accepts("text.delta", { text: "hello" })).toBe(false);
    expect(accepts("turn.started", { turnId: "t1", attempt: 0 })).toBe(false);
    expect(accepts("tool.result", { callId: "c1" })).toBe(false);
  });

  it("rejects a payload carrying a field the vocabulary never defined", () => {
    // Additive drift is how one writer starts speaking a dialect the other readers cannot parse.
    expect(accepts("text.delta", { text: "hi", index: 0, tokens: ["hi"] })).toBe(false);
    expect(
      accepts("tool.call", {
        callId: "c1",
        name: "record_create",
        argsDigest: "sha",
        args: { secret: "value" },
      })
    ).toBe(false);
  });

  it("rejects out-of-range enums and counters", () => {
    expect(accepts("turn.finished", { status: "done" })).toBe(false);
    expect(accepts("guardrail.blocked", { stage: "middle", reason: "x" })).toBe(false);
    expect(accepts("text.delta", { text: "hi", index: -1 })).toBe(false);
    expect(accepts("turn.started", { turnId: "t1", attempt: 1.5, agentId: "a" })).toBe(false);
  });
});
