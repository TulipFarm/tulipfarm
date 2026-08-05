import { describe, expect, it } from "vitest";
import type { EvalCase } from "../types";
import { type JudgeModelPort, type JudgeVerdict, llmJudge } from "./judge";

function fakeJudge(verdict: JudgeVerdict): JudgeModelPort {
  return {
    async judge() {
      return verdict;
    },
  };
}

const baseCase: EvalCase = {
  caseId: "c1",
  version: "1",
  severity: "advisory",
  input: { prompt: "summarize" },
  rubric: "PASS if concise.",
};

describe("llmJudge - calibration", () => {
  it("passes through the judge verdict and rationale", async () => {
    const scorer = llmJudge({
      judge: fakeJudge({ passed: true, score: 0.9, rationale: "concise" }),
    });
    const score = await scorer({ evalCase: baseCase, output: { text: "short answer" } });
    expect(score).toMatchObject({
      scorer: "judge",
      passed: true,
      value: 0.9,
      rationale: "concise",
    });
  });

  it("fails when the verdict fails", async () => {
    const scorer = llmJudge({
      judge: fakeJudge({ passed: false, score: 0.2, rationale: "rambling" }),
    });
    expect((await scorer({ evalCase: baseCase, output: { text: "x" } })).passed).toBe(false);
  });

  it("applies an optional numeric threshold on top of the verdict", async () => {
    const scorer = llmJudge({
      judge: fakeJudge({ passed: true, score: 0.6, rationale: "ok" }),
      passThreshold: 0.8,
    });
    expect((await scorer({ evalCase: baseCase, output: { text: "x" } })).passed).toBe(false);
  });

  it("fails when no rubric is available", async () => {
    const scorer = llmJudge({ judge: fakeJudge({ passed: true, score: 1, rationale: "" }) });
    const noRubric: EvalCase = { ...baseCase, rubric: undefined };
    const score = await scorer({ evalCase: noRubric, output: { text: "x" } });
    expect(score.passed).toBe(false);
    expect(score.rationale).toContain("no rubric");
  });
});
