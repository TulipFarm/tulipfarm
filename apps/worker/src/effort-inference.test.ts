import type { ModelRequirements } from "@tulipfarm/agent-runtime";
import type { RunEventEffortInference } from "@tulipfarm/schema";
import type { PersistedRunEvent } from "@tulipfarm/storage";
import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { classifierRequirements } from "./effort-classifier";
import {
  createEffortInference,
  recordedEffortInference,
  runEventEffortPin,
} from "./effort-inference";

const requirements: ModelRequirements = {
  needsTools: true,
  needsStructuredOutput: true,
  sensitive: true,
  estimatedContextTokens: 40_000,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
};

/** A prompt with no signal either way: short, but not a lookup and not a greeting. */
const AMBIGUOUS =
  "Should we evaluate this approach before we commit to it, or is there a better option?";

const FAST = "what is the capital of France";
const THOROUGH = [
  "We need to decide the architecture for the billing migration.",
  "1. What are the trade-offs between a dual-write and a backfill?",
  "2. How do we roll back if the new schema is wrong?",
  "3. Which one scales past the current webhook volume?",
].join("\n");

function event(overrides: Partial<PersistedRunEvent> = {}): PersistedRunEvent {
  return {
    sequence: 1,
    eventType: "model.routed",
    audience: "operator",
    payload: {},
    ...overrides,
  } as PersistedRunEvent;
}

function routed(
  inference: Partial<RunEventEffortInference> & { rung: string }
): Record<string, unknown> {
  return {
    outcome: "selected",
    selector: "auto",
    resolution: "effort_inferred",
    profileId: inference.rung,
    chain: [{ profileId: inference.rung, modelId: "claude-haiku-5" }],
    cacheAllowed: true,
    rejectedFallbacks: [],
    effortInference: {
      score: 0,
      firedSignals: [],
      band: "unsure",
      usedClassifier: true,
      promptHash: "a".repeat(64),
      ...inference,
    },
  };
}

describe("createEffortInference", () => {
  it("resolves a clear prompt from the heuristic alone, without paying for a model call", async () => {
    const models = { model: vi.fn() };
    const infer = createEffortInference({ models });

    const decision = await infer.infer(FAST, requirements);

    expect(decision?.rung).toBe("fast");
    expect(decision?.usedClassifier).toBe(false);
    expect(models.model).not.toHaveBeenCalled();
  });

  it("reaches the classifier only for a prompt the heuristic could not place", async () => {
    const models = {
      model: vi.fn(async () => stubModel("thorough")),
    };
    const infer = createEffortInference({ models });

    expect((await infer.infer(THOROUGH, requirements))?.usedClassifier).toBe(false);
    expect(models.model).not.toHaveBeenCalled();

    const ambiguous = await infer.infer(AMBIGUOUS, requirements);

    expect(ambiguous?.usedClassifier).toBe(true);
    expect(ambiguous?.rung).toBe("thorough");
    expect(models.model).toHaveBeenCalledTimes(1);
  });

  it("asks the classifier at the weakest rung, never at the rung it is deciding about", async () => {
    const models = { model: vi.fn(async () => stubModel("balanced")) };

    await createEffortInference({ models }).infer(AMBIGUOUS, requirements);

    expect(models.model).toHaveBeenCalledWith("fast", classifierRequirements(requirements));
  });

  it("takes the middle rung when no classifier is configured at all", async () => {
    const decision = await createEffortInference({}).infer(AMBIGUOUS, requirements);

    expect(decision?.rung).toBe("balanced");
    expect(decision?.usedClassifier).toBe(false);
    expect(decision?.band).toBe("unsure");
  });

  it("replays a pinned decision instead of asking the classifier again", async () => {
    const models = { model: vi.fn(async () => stubModel("fast")) };
    const pin: RunEventEffortInference = {
      rung: "thorough",
      score: 2.5,
      firedSignals: ["design_keywords"],
      band: "unsure",
      usedClassifier: true,
      promptHash: "b".repeat(64),
    };

    const decision = await createEffortInference({
      models,
      pinned: { read: async () => pin },
    }).infer(AMBIGUOUS, requirements);

    expect(decision).toMatchObject({ rung: "thorough", usedClassifier: true });
    expect(models.model).not.toHaveBeenCalled();
  });

  it("routes the turn rather than failing it when the pin cannot be read", async () => {
    const decision = await createEffortInference({
      pinned: {
        read: async () => {
          throw new Error("run event store unavailable");
        },
      },
    }).infer(FAST, requirements);

    expect(decision?.rung).toBe("fast");
  });

  it("reports an integer classifier latency, because the event schema stores one", async () => {
    const decision = await createEffortInference({
      models: { model: async () => stubModel("balanced") },
    }).infer(AMBIGUOUS, requirements);

    expect(decision?.classifierLatencyMs).toBeDefined();
    expect(Number.isInteger(decision?.classifierLatencyMs)).toBe(true);
  });

  it("hands every decision to the calibration hook", async () => {
    const log = vi.fn();

    await createEffortInference({ log }).infer(FAST, requirements);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ rung: "fast", usedClassifier: false });
  });

  it("logs a prompt hash and never the prompt itself", async () => {
    const log = vi.fn();

    await createEffortInference({ log }).infer(FAST, requirements);

    const decision = log.mock.calls[0]?.[0];
    expect(decision.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(decision)).not.toContain("capital");
  });
});

describe("recordedEffortInference", () => {
  it("finds the decision on a routing event that inferred one", () => {
    const found = recordedEffortInference([
      event({ eventType: "state.started", payload: {} }),
      event({ sequence: 2, payload: routed({ rung: "thorough" }) }),
    ]);

    expect(found?.rung).toBe("thorough");
  });

  it("takes the earliest decision, so a re-dispatch replays the original answer", () => {
    const found = recordedEffortInference([
      event({ sequence: 1, payload: routed({ rung: "balanced" }) }),
      event({ sequence: 2, payload: routed({ rung: "thorough" }) }),
    ]);

    expect(found?.rung).toBe("balanced");
  });

  it("ignores a route that was resolved by a declared preset rather than inferred", () => {
    const found = recordedEffortInference([
      event({
        payload: {
          outcome: "selected",
          selector: "auto",
          resolution: "effort_preset",
          profileId: "balanced",
          chain: [{ profileId: "balanced", modelId: "claude-sonnet-5" }],
          cacheAllowed: true,
          rejectedFallbacks: [],
        },
      }),
    ]);

    expect(found).toBeUndefined();
  });

  it("ignores a raw model route, which carries no effort question", () => {
    const found = recordedEffortInference([
      event({
        payload: {
          outcome: "raw_model",
          selector: "claude-opus-5",
          resolution: "raw_model_id",
          modelId: "claude-opus-5",
        },
      }),
    ]);

    expect(found).toBeUndefined();
  });

  it("finds nothing on a Run that has not routed yet", () => {
    expect(recordedEffortInference([])).toBeUndefined();
  });
});

describe("runEventEffortPin", () => {
  it("reads the operator-audience events of this Run only", async () => {
    const list = vi.fn(async () => [event({ payload: routed({ rung: "fast" }) })]);

    const pinned = await runEventEffortPin({ list }, "business-1", "run-1").read();

    expect(pinned?.rung).toBe("fast");
    expect(list).toHaveBeenCalledWith("business-1", "run-1", {
      after: 0,
      audiences: ["operator"],
    });
  });
});

/** A quick-tier model that answers with one label, as the classifier's system prompt demands. */
function stubModel(label: string): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "quick",
    doGenerate: async () => ({
      content: [{ type: "text", text: label }],
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 1, totalTokens: 21 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("the classifier never streams");
    },
  } as unknown as LanguageModel;
}
