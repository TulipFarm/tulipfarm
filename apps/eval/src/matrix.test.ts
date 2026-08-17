import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import type { Corpus } from "./corpus.ts";
import { corpusHash } from "./corpus.ts";
import { type EvalSoul, loadEvalSoul } from "./eval-soul.ts";
import { runMatrix } from "./matrix.ts";
import type { ModelBinding, Scorecard, SweepOptions, TrialResult } from "./runner.ts";
import { NO_SPEND } from "./spend.ts";

const evalCase = (id: string): EvalCase => ({
  id,
  tier: "l2",
  agent: "triage",
  context: { agentId: "triage", governancePages: [] },
  input: [{ role: "user", content: "hello" }],
  expect: [{ kind: "loop_status", status: "completed" }],
});

let soul: EvalSoul;
beforeAll(async () => {
  soul = await loadEvalSoul();
});

afterAll(() => soul.dispose());

const corpusOf = (cases: EvalCase[]): Corpus => ({
  cases,
  hash: corpusHash(cases, soul.hash),
  soul,
});

const binding = (id: string): ModelBinding => ({
  id,
  create: () => ({
    invoke: async (request) => ({
      requestId: request.requestId,
      output: { kind: "text", text: "answer" },
      usage: { inputTokens: 1, outputTokens: 1, costBasis: "subscription" },
    }),
  }),
});

const aTrial = (caseId: string): TrialResult => ({
  caseId,
  trial: 1,
  status: "completed",
  passed: true,
  vacuous: false,
  retries: 0,
  spend: NO_SPEND,
  expectations: [],
});

const card = (modelId: string, over: Partial<Scorecard> = {}): Scorecard => ({
  corpusHash: "h",
  modelId,
  modelDated: false,
  startedAt: "2025-01-01T00:00:00.000Z",
  durationMs: 1,
  trials: [],
  passed: 1,
  failed: 0,
  errored: 0,
  skipped: 0,
  corpusCases: 1,
  spend: NO_SPEND,
  ...over,
});

describe("runMatrix", () => {
  it("measures every model against the same Corpus", async () => {
    const seen: string[] = [];
    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet"), binding("luna")],
      sweep: async (o: SweepOptions) => {
        seen.push(`${o.model.id}:${o.corpus.hash}`);
        return card(o.model.id);
      },
    });

    expect(seen).toEqual([`sonnet:${matrix.corpusHash}`, `luna:${matrix.corpusHash}`]);
    expect(matrix.runs.map((r) => r.modelId)).toEqual(["sonnet", "luna"]);
  });

  it("keeps the declared order rather than ordering by result", async () => {
    // Sorting by score would turn a control into a leaderboard. The two models exist to show
    // whether a harness change lands differently on each, not to be ranked against one another.
    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("luna"), binding("sonnet")],
      sweep: async (o: SweepOptions) =>
        card(o.model.id, o.model.id === "luna" ? { passed: 0, failed: 1 } : {}),
    });

    expect(matrix.runs.map((r) => r.modelId)).toEqual(["luna", "sonnet"]);
  });

  it("runs one model at a time, so neither is measured under the other's throttling", async () => {
    let active = 0;
    let overlapped = false;
    await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet"), binding("luna")],
      sweep: async (o: SweepOptions) => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return card(o.model.id);
      },
    });

    expect(overlapped).toBe(false);
  });

  it("keeps the other model's evidence when one cannot be measured at all", async () => {
    // A missing credential or a vendor outage must not throw away the model that did run: that is
    // a whole Sweep's worth of information lost to a fault in something else.
    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet"), binding("luna")],
      sweep: async (o: SweepOptions) => {
        if (o.model.id === "sonnet") throw new Error("CODEX_AUTH_JSON is not set");
        return card(o.model.id);
      },
    });

    expect(matrix.runs[0]).toMatchObject({ modelId: "sonnet", unavailable: expect.any(String) });
    expect(matrix.runs[0]?.card).toBeUndefined();
    expect(matrix.runs[1]?.card).toBeDefined();
  });

  it("gives each model its own ceiling, because a shared one would starve the last", async () => {
    // A budget spent across the matrix would truncate whichever model ran last, and a partial
    // Sweep cannot be compared with a complete one. Per-model is what keeps them comparable.
    const ceilings: (number | undefined)[] = [];
    await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet"), binding("luna")],
      maxTokens: 20_000,
      sweep: async (o: SweepOptions) => {
        ceilings.push(o.maxTokens);
        return card(o.model.id);
      },
    });

    expect(ceilings).toEqual([20_000, 20_000]);
  });

  it("passes the Case filter through, so a single-Case debug run stays cheap", async () => {
    const filters: (string | undefined)[] = [];
    await runMatrix({
      corpus: corpusOf([evalCase("a"), evalCase("b")]),
      models: [binding("sonnet")],
      caseFilter: "a",
      sweep: async (o: SweepOptions) => {
        filters.push(o.caseFilter);
        return card(o.model.id);
      },
    });

    expect(filters).toEqual(["a"]);
  });

  it("really executes a Sweep when no sweep function is injected", async () => {
    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet")],
    });

    expect(matrix.runs[0]?.card?.passed).toBe(1);
  });

  it("reports a model that scored nothing as unavailable, not as a column of errors", async () => {
    const dead = card("luna", {
      trials: [
        { ...aTrial("a"), passed: false, error: "CLAUDE_CODE_OAUTH_TOKEN is not set" },
        { ...aTrial("b"), passed: false, error: "CLAUDE_CODE_OAUTH_TOKEN is not set" },
      ],
      passed: 0,
      failed: 0,
      errored: 2,
    });

    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("luna")],
      sweep: async () => dead,
    });

    expect(matrix.runs[0]?.card).toBeUndefined();
    expect(matrix.runs[0]?.unavailable).toContain("CLAUDE_CODE_OAUTH_TOKEN is not set");
  });

  it("keeps a Scorecard that scored something, however badly the rest of it went", async () => {
    const partial = card("luna", {
      trials: [
        { ...aTrial("a"), passed: false },
        { ...aTrial("b"), passed: false, error: "rate limited" },
      ],
      passed: 0,
      failed: 1,
      errored: 1,
    });

    const matrix = await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("luna")],
      sweep: async () => partial,
    });

    expect(matrix.runs[0]?.card).toBe(partial);
    expect(matrix.runs[0]?.unavailable).toBeUndefined();
  });
});

describe("handing Sweep options to each model", () => {
  it("forwards every knob it was given, so a new one cannot be silently dropped", async () => {
    const seen: SweepOptions[] = [];

    await runMatrix({
      corpus: corpusOf([evalCase("a")]),
      models: [binding("sonnet"), binding("luna")],
      caseFilter: "a",
      maxTokens: 99,
      repeat: 4,
      sweep: async (options) => {
        seen.push(options);
        return card("x");
      },
    });

    // Asserted as a whole object rather than field by field: a check that names the fields would
    // need editing to notice a field it does not name, which is exactly how `repeat` was lost.
    for (const options of seen) {
      expect({ ...options, model: undefined, corpus: undefined }).toEqual({
        model: undefined,
        corpus: undefined,
        caseFilter: "a",
        maxTokens: 99,
        repeat: 4,
      });
    }
    expect(seen).toHaveLength(2);
  });
});
