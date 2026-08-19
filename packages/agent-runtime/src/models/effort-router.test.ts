import { describe, expect, it, vi } from "vitest";
import {
  classifyWithQuickModel,
  EFFORT_CLASSIFIER_FALLBACK,
  EFFORT_FAST_THRESHOLD,
  EFFORT_THOROUGH_THRESHOLD,
  EFFORT_UNSURE_MARGIN,
  type EffortClassifierPort,
  type EffortRoutingDecision,
  hashPrompt,
  route,
  routeByScore,
  scoreEffortSignals,
  scorePrompt,
} from "./effort-router";

function answering(answer: string | (() => never)): EffortClassifierPort {
  const reply = typeof answer === "string" ? () => answer : answer;
  return { classify: vi.fn(async (): Promise<string> => reply()) };
}

describe("scorePrompt", () => {
  it("is pure — the same prompt always scores the same", () => {
    const prompt = "design a migration strategy for the routines table";
    expect(scorePrompt(prompt)).toBe(scorePrompt(prompt));
  });

  it("agrees with scoreEffortSignals", () => {
    const prompt = "1. read\n2. write\nwhy?";
    expect(scorePrompt(prompt)).toBe(scoreEffortSignals(prompt).score);
  });

  it("scores a factual lookup below a design brief", () => {
    expect(scorePrompt("what is the capital of France?")).toBeLessThan(
      scorePrompt(`Compare the tradeoffs of these two architectures. ${"detail ".repeat(80)}`)
    );
  });

  it("reports the signals that fired", () => {
    expect(scoreEffortSignals("thanks!").fired).toEqual(["greeting_or_ack", "short_prompt"]);
  });

  it("scores an empty prompt without throwing", () => {
    expect(Number.isFinite(scorePrompt(""))).toBe(true);
  });
});

describe("routeByScore", () => {
  it.each([
    [EFFORT_FAST_THRESHOLD - EFFORT_UNSURE_MARGIN, "fast"],
    [EFFORT_FAST_THRESHOLD - EFFORT_UNSURE_MARGIN - 10, "fast"],
    [EFFORT_FAST_THRESHOLD, "unsure"],
    [EFFORT_FAST_THRESHOLD + EFFORT_UNSURE_MARGIN, "balanced"],
    [(EFFORT_FAST_THRESHOLD + EFFORT_THOROUGH_THRESHOLD) / 2, "balanced"],
    [EFFORT_THOROUGH_THRESHOLD - EFFORT_UNSURE_MARGIN, "balanced"],
    [EFFORT_THOROUGH_THRESHOLD, "unsure"],
    [EFFORT_THOROUGH_THRESHOLD + EFFORT_UNSURE_MARGIN, "thorough"],
    [EFFORT_THOROUGH_THRESHOLD + 100, "thorough"],
  ])("maps %d to %s", (score, band) => {
    expect(routeByScore(score)).toBe(band);
  });

  it("keeps the unsure bands narrower than the balanced zone", () => {
    const unsure = 2 * EFFORT_UNSURE_MARGIN;
    const balanced = EFFORT_THOROUGH_THRESHOLD - EFFORT_FAST_THRESHOLD - unsure;
    expect(unsure).toBeLessThan(balanced);
  });
});

describe("classifyWithQuickModel", () => {
  it.each(["fast", "balanced", "thorough"])("accepts the label %j", async (label) => {
    expect(await classifyWithQuickModel("p", answering(label))).toBe(label);
  });

  it.each([" Thorough.\n", "FAST", '"balanced"'])(
    "tolerates casing and punctuation in %j",
    async (answer) => {
      expect(await classifyWithQuickModel("p", answering(answer))).toBe(
        answer
          .trim()
          .toLowerCase()
          .replace(/[.!,'"`]/g, "")
      );
    }
  );

  it.each([
    ["an unknown label", "complicated"],
    ["a retired tier name", "quick"],
    ["an empty answer", ""],
    ["whitespace", "   \n "],
    ["prose", "I think this one is fairly complex, so thorough"],
    ["a refusal", "I cannot answer that."],
    ["a JSON object", '{"tier":"fast"}'],
  ])("defaults to balanced on %s", async (_label, answer) => {
    expect(await classifyWithQuickModel("p", answering(answer))).toBe(EFFORT_CLASSIFIER_FALLBACK);
  });

  it("defaults to balanced when the call throws", async () => {
    const thrower = answering(() => {
      throw new Error("provider unavailable");
    });
    expect(await classifyWithQuickModel("p", thrower)).toBe(EFFORT_CLASSIFIER_FALLBACK);
  });

  it("never resolves a malformed answer toward an outer rung", async () => {
    expect(EFFORT_CLASSIFIER_FALLBACK).toBe("balanced");
  });
});

describe("route", () => {
  it("resolves a confident prompt without calling the classifier", async () => {
    const classifier = answering("thorough");
    const decision = await route("thanks!", { classifier });

    expect(decision.rung).toBe("fast");
    expect(decision.usedClassifier).toBe(false);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("calls the classifier exactly once for an unsure prompt", async () => {
    const classifier = answering("thorough");
    const prompt = unsurePrompt();
    expect(routeByScore(scorePrompt(prompt))).toBe("unsure");

    const decision = await route(prompt, { classifier, now: counter() });

    expect(decision.rung).toBe("thorough");
    expect(decision.band).toBe("unsure");
    expect(decision.usedClassifier).toBe(true);
    expect(decision.classifierLatencyMs).toBe(1);
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it("takes the safe middle rung when no classifier is available", async () => {
    const decision = await route(unsurePrompt());

    expect(decision.rung).toBe(EFFORT_CLASSIFIER_FALLBACK);
    expect(decision.usedClassifier).toBe(false);
  });

  it("reuses a pinned decision and never calls the classifier", async () => {
    const classifier = answering("thorough");
    const pinned: EffortRoutingDecision = {
      rung: "fast",
      score: 42,
      firedSignals: ["design_keywords"],
      band: "unsure",
      usedClassifier: true,
      promptHash: "deadbeef",
    };

    const decision = await route(unsurePrompt(), { classifier, pinned });

    expect(decision).toEqual(pinned);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("records a hash of the prompt, never the prompt", async () => {
    const prompt = "what is the capital of France?";
    const decision = await route(prompt);

    expect(decision.promptHash).toBe(hashPrompt(prompt));
    expect(JSON.stringify(decision)).not.toContain("France");
  });

  it("logs every decision, including a pinned one", async () => {
    const log = vi.fn();
    await route("thanks!", { log });
    await route("thanks!", {
      log,
      pinned: {
        rung: "thorough",
        score: 9,
        firedSignals: [],
        band: "thorough",
        usedClassifier: false,
        promptHash: "abc",
      },
    });

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ rung: "fast", usedClassifier: false });
    expect(log.mock.calls[1]?.[0]).toMatchObject({ rung: "thorough" });
  });
});

/** A prompt engineered to land in an unsure band, so the funnel's second stage is exercised. */
function unsurePrompt(): string {
  return "Should we evaluate this approach before we commit to it, or is there a better option?";
}

function counter(): () => number {
  let value = 0;
  return () => value++;
}
