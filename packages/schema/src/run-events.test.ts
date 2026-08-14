import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import { MODEL_PROFILE_DENIAL_REASONS } from "./definitions/model";
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

type EnumSchema = { readonly enum?: readonly string[] };
type AttemptArraySchema = {
  readonly items?: { readonly properties?: { readonly reason?: EnumSchema } };
};
type ModelRoutedBranchSchema = {
  readonly properties?: {
    readonly reason?: EnumSchema;
    readonly attempts?: AttemptArraySchema;
    readonly rejectedFallbacks?: AttemptArraySchema;
  };
};
type ModelRoutedSchema = {
  readonly oneOf?: readonly ModelRoutedBranchSchema[];
};

function isStringEnum(value: readonly string[] | undefined): value is readonly string[] {
  return value !== undefined;
}

function modelRoutedReasonEnums(): readonly (readonly string[])[] {
  const definition = runEventDefinition("model.routed");
  if (definition === undefined) throw new Error("missing model.routed definition");
  const schema = definition.schema as ModelRoutedSchema;
  return (schema.oneOf ?? []).flatMap((branch) =>
    [
      branch.properties?.reason?.enum,
      branch.properties?.attempts?.items?.properties?.reason?.enum,
      branch.properties?.rejectedFallbacks?.items?.properties?.reason?.enum,
    ].filter(isStringEnum)
  );
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
      "model.routed",
      "tool.dispatched",
      "guardrail.decision",
      "delivery.classified",
    ]);
  });

  it("uses the canonical ModelProfile denial reason enum for routing evidence", () => {
    const enums = modelRoutedReasonEnums();

    expect(enums.length).toBeGreaterThan(0);
    for (const enumValues of enums) {
      expect(enumValues).toEqual([...MODEL_PROFILE_DENIAL_REASONS]);
    }
  });

  it("has no definition for a type outside the vocabulary", () => {
    expect(runEventDefinition("text.token")).toBeUndefined();
  });

  it("accepts a Tool call carrying a redacted preview alongside its digest", () => {
    expect(
      accepts("tool.call", {
        callId: "c1",
        name: "send_slack_message",
        argsDigest: "sha",
        argsPreview: {
          json: '{"channel":"#ops","token":"[redacted]"}',
          redactedPaths: ["token"],
          truncated: false,
          bytes: 62,
        },
        tier: "integration",
        mutating: true,
        agentId: "assistant",
        stepId: "state-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toBe(true);

    expect(
      accepts("tool.result", {
        callId: "c1",
        status: "ok",
        summary: "posted to #ops",
        resultPreview: { json: '{"ts":"1730.4"}' },
        durationMs: 412,
      })
    ).toBe(true);
  });

  it("refuses a preview shape a reader was never built to parse", () => {
    // `json` is the only required field, and it is text: a reader parses it or shows it raw.
    expect(
      accepts("tool.call", { callId: "c1", name: "n", argsDigest: "d", argsPreview: {} })
    ).toBe(false);
    // An unknown tier would let a writer invent a Tool layer the UI has no vocabulary for.
    expect(
      accepts("tool.call", { callId: "c1", name: "n", argsDigest: "d", tier: "external" })
    ).toBe(false);
    // A negative duration is not a slow call, it is a broken clock.
    expect(accepts("tool.result", { callId: "c1", status: "ok", durationMs: -1 })).toBe(false);
    expect(
      accepts("tool.call", { callId: "c1", name: "n", argsDigest: "d", argsPreview: { json: 12 } })
    ).toBe(false);
  });

  it("accepts the payloads a turn actually emits", () => {
    expect(accepts("turn.started", { turnId: "t1", attempt: 0, agentId: "assistant" })).toBe(true);
    expect(accepts("text.delta", { text: "hello there", index: 0 })).toBe(true);
    expect(accepts("tool.call", { callId: "c1", name: "record_create", argsDigest: "sha" })).toBe(
      true
    );
    expect(accepts("tool.result", { callId: "c1", status: "ok", summary: "1 row" })).toBe(true);
    expect(accepts("approval.requested", { waitId: "w1", intentId: "i1" })).toBe(true);
    expect(
      accepts("model.routed", {
        outcome: "selected",
        selector: "balanced",
        resolution: "effort_preset",
        profileId: "primary",
        chain: [{ profileId: "primary", modelId: "claude-sonnet-5" }],
        cacheAllowed: true,
        rejectedFallbacks: [{ profileId: "tiny", reason: "context_window_exceeded" }],
        budgetLimits: {
          tokens: { value: 2_000, scope: "model" },
          costMicros: { value: 250_000, scope: "model" },
        },
      })
    ).toBe(true);
    expect(
      accepts("model.routed", {
        outcome: "denied",
        selector: "balanced",
        resolution: "effort_preset",
        profileId: "primary",
        reason: "tools_unsupported",
        attempts: [{ profileId: "primary", reason: "tools_unsupported" }],
      })
    ).toBe(true);
    expect(accepts("turn.finished", { status: "succeeded", messageId: "m1" })).toBe(true);
    expect(
      accepts("turn.finished", {
        status: "succeeded",
        messageId: "m1",
        modelId: "claude-sonnet-5",
        effortPreset: "auto",
        modelCallLatencyMs: 1234,
      })
    ).toBe(true);
  });

  it("allows a finished turn to carry no Message", () => {
    // A blocked, failed, or cancelled turn produces none, and null says so rather than leaving the
    // reader to infer absence from a missing field.
    expect(accepts("turn.finished", { status: "failed", messageId: null })).toBe(true);
  });

  it("allows older finished turns without receipt fields", () => {
    expect(accepts("turn.finished", { status: "succeeded", messageId: "m1" })).toBe(true);
    expect(accepts("turn.finished", { status: "cancelled", messageId: null })).toBe(true);
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
    expect(
      accepts("turn.finished", {
        status: "succeeded",
        modelId: "claude-sonnet-5",
        effortPreset: "quick",
      })
    ).toBe(false);
    expect(
      accepts("turn.finished", {
        status: "succeeded",
        modelId: "claude-sonnet-5",
        modelCallLatencyMs: -1,
      })
    ).toBe(false);
    expect(accepts("guardrail.blocked", { stage: "middle", reason: "x" })).toBe(false);
    expect(accepts("text.delta", { text: "hi", index: -1 })).toBe(false);
    expect(accepts("turn.started", { turnId: "t1", attempt: 1.5, agentId: "a" })).toBe(false);
  });

  describe("inferred effort evidence", () => {
    const inference = {
      rung: "thorough",
      score: 4.5,
      band: "unsure",
      firedSignals: ["design_keywords", "long_prompt"],
      usedClassifier: true,
      promptHash: "a".repeat(64),
      classifierLatencyMs: 210,
    };

    const selected = {
      outcome: "selected",
      selector: "auto",
      resolution: "effort_inferred",
      profileId: "thorough",
      chain: [{ profileId: "thorough", modelId: "claude-opus-5" }],
      cacheAllowed: true,
      rejectedFallbacks: [],
    };

    it("accepts an inferred selection carrying its calibration record", () => {
      expect(accepts("model.routed", { ...selected, effortInference: inference })).toBe(true);
    });

    it("accepts a denial that names the rung it inferred", () => {
      expect(
        accepts("model.routed", {
          outcome: "denied",
          selector: "auto",
          resolution: "effort_inferred",
          profileId: "thorough",
          reason: MODEL_PROFILE_DENIAL_REASONS[0],
          attempts: [{ profileId: "thorough", reason: MODEL_PROFILE_DENIAL_REASONS[0] }],
          effortInference: inference,
        })
      ).toBe(true);
    });

    it("still accepts an event recorded before inference existed", () => {
      expect(accepts("model.routed", { ...selected, resolution: "effort_preset" })).toBe(true);
    });

    it("rejects a retired tier name as an inferred rung", () => {
      expect(
        accepts("model.routed", {
          ...selected,
          effortInference: { ...inference, rung: "complex" },
        })
      ).toBe(false);
    });

    it("rejects `unsure` as an outcome — it is a band, never a rung", () => {
      expect(
        accepts("model.routed", {
          ...selected,
          effortInference: { ...inference, rung: "unsure" },
        })
      ).toBe(false);
    });

    it("rejects a prompt where a hash belongs", () => {
      expect(
        accepts("model.routed", {
          ...selected,
          effortInference: { ...inference, promptHash: "design me a system" },
        })
      ).toBe(false);
    });

    it("rejects an inference record missing the rung it chose", () => {
      const { rung: _rung, ...withoutRung } = inference;
      expect(accepts("model.routed", { ...selected, effortInference: withoutRung })).toBe(false);
    });
  });
});
