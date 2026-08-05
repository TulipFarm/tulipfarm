import { describe, expect, it } from "vitest";
import { runEvals } from "./runner";
import { inMemorySink } from "./sink";
import type { EvalTarget } from "./targets";
import type { EvalCase, Score, TargetOutput } from "./types";

function sequenceTarget(outputs: readonly TargetOutput[]): EvalTarget {
  let index = 0;
  return {
    name: "sequence",
    async execute() {
      const output = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return output;
    },
  };
}

const passIfOk = (): Score => ({ scorer: "ok", passed: false, value: 0 });
const scoreOk = ({ output }: { output: TargetOutput }): Score =>
  output.text === "ok" ? { scorer: "ok", passed: true, value: 1 } : passIfOk();

const oneCase: EvalCase = {
  caseId: "c1",
  version: "1",
  severity: "blocking",
  input: { prompt: "x" },
};

describe("runEvals - multi-run threshold", () => {
  it("passes a case when the pass rate meets the threshold (2/3)", async () => {
    const report = await runEvals({
      suite: "s",
      suiteVersion: "1",
      cases: [oneCase],
      target: sequenceTarget([{ text: "ok" }, { text: "ok" }, { text: "bad" }]),
      scorers: [scoreOk],
      runs: 3,
      minPassRate: 2 / 3,
    });
    expect(report.results[0].passed).toBe(true);
    expect(report.results[0].passes).toBe(2);
    expect(report.passed).toBe(1);
  });

  it("fails a case below the threshold", async () => {
    const report = await runEvals({
      suite: "s",
      suiteVersion: "1",
      cases: [oneCase],
      target: sequenceTarget([{ text: "ok" }, { text: "bad" }, { text: "bad" }]),
      scorers: [scoreOk],
      runs: 3,
      minPassRate: 2 / 3,
    });
    expect(report.results[0].passed).toBe(false);
    expect(report.failed).toBe(1);
  });

  it("an attempt passes only if every scorer passes", async () => {
    const alwaysFail = (): Score => ({ scorer: "no", passed: false, value: 0 });
    const report = await runEvals({
      suite: "s",
      suiteVersion: "1",
      cases: [oneCase],
      target: sequenceTarget([{ text: "ok" }]),
      scorers: [scoreOk, alwaysFail],
      runs: 1,
      minPassRate: 1,
    });
    expect(report.results[0].passed).toBe(false);
  });

  it("records a target error as a failed attempt without throwing", async () => {
    const throwing: EvalTarget = {
      name: "throwing",
      async execute() {
        throw new Error("model exploded");
      },
    };
    const report = await runEvals({
      suite: "s",
      suiteVersion: "1",
      cases: [oneCase],
      target: throwing,
      scorers: [scoreOk],
      runs: 1,
      minPassRate: 1,
    });
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].attempts[0].scores[0].rationale).toContain("model exploded");
  });

  it("measures latency and writes to the sink", async () => {
    const sink = inMemorySink();
    const report = await runEvals({
      suite: "s",
      suiteVersion: "1",
      cases: [oneCase],
      target: sequenceTarget([{ text: "ok" }]),
      scorers: [scoreOk],
      runs: 1,
      minPassRate: 1,
      sink,
    });
    expect(sink.reports).toHaveLength(1);
    expect(report.results[0].attempts[0].output.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.digest).toMatch(/^[a-f0-9]+$/);
  });
});
