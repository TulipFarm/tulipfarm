import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { corpusHash } from "./corpus.ts";
import type { ModelBinding } from "./runner.ts";
import { runSweep } from "./runner.ts";
import { scriptedBinding } from "./scripted.ts";

const corpusOf = (cases: EvalCase[]) => ({ cases, hash: corpusHash(cases) });

const answering = (id: string, text: string, expectations: EvalCase["expect"]): EvalCase => ({
  id,
  tier: "l2",
  agent: "triage",
  context: { agentId: "triage", memory: [], governancePages: [] },
  input: [{ role: "user", content: "hello" }],
  script: [{ kind: "text", text }],
  expect: expectations,
});

describe("runSweep", () => {
  it("reports a passing Case as passed", async () => {
    const corpus = corpusOf([
      answering("greets", "hello there", [{ kind: "output_contains", text: "hello" }]),
    ]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.passed).toBe(1);
    expect(card.failed).toBe(0);
    expect(card.errored).toBe(0);
  });

  it("reports a failing Case as failed and keeps the expectation detail", async () => {
    const corpus = corpusOf([
      answering("greets", "hello there", [{ kind: "output_contains", text: "goodbye" }]),
    ]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.failed).toBe(1);
    expect(card.trials[0].expectations[0].detail).toContain("goodbye");
  });

  it("runs the real Context assembler, so the prompt is measurable", async () => {
    const corpus = corpusOf([
      answering("assembles", "ok", [{ kind: "prompt_contains", text: "agentId: triage" }]),
    ]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.passed).toBe(1);
  });

  it("sends the assembled prompt to the model as a system message", async () => {
    const seen: string[] = [];
    const binding: ModelBinding = {
      id: "recording",
      create: () => ({
        invoke: async (request) => {
          seen.push(request.messages.map((m) => `${m.role}:${m.content}`).join("|"));
          return {
            requestId: request.requestId,
            output: { kind: "text", text: "ok" },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
    };
    const corpus = corpusOf([answering("sends", "ok", [])]);
    await runSweep({ corpus, model: binding });
    expect(seen[0]).toContain("system:");
    expect(seen[0]).toContain("agentId: triage");
    expect(seen[0]).toContain("user:hello");
  });

  it("observes Tool calls in the order the model made them", async () => {
    const withTools: EvalCase = {
      id: "tools",
      tier: "l2",
      agent: "triage",
      context: { agentId: "triage", memory: [], governancePages: [] },
      input: [{ role: "user", content: "refund please" }],
      tools: [
        { name: "search", inputSchema: { type: "object" } },
        { name: "ticket.create", inputSchema: { type: "object" } },
      ],
      toolResults: [
        { name: "search", output: { hits: 1 } },
        { name: "ticket.create", output: { id: "T-1" } },
      ],
      script: [
        {
          kind: "tool_calls",
          calls: [{ callId: "c1", name: "search", arguments: { q: "refund" } }],
        },
        {
          kind: "tool_calls",
          calls: [{ callId: "c2", name: "ticket.create", arguments: { title: "Refund" } }],
        },
        { kind: "text", text: "done" },
      ],
      expect: [
        { kind: "tool_call_order", names: ["search", "ticket.create"] },
        { kind: "tool_argument_equals", name: "search", path: "q", value: "refund" },
        { kind: "tool_call_count", count: 2 },
      ],
    };
    const card = await runSweep({ corpus: corpusOf([withTools]), model: scriptedBinding() });
    expect(card.trials[0].expectations.every((a) => a.passed)).toBe(true);
  });

  it("does not abort the Sweep when one Case errors, and counts it apart from a failure", async () => {
    const exploding: EvalCase = { ...answering("boom", "", []), script: [] };
    const corpus = corpusOf([
      exploding,
      answering("fine", "hello", [{ kind: "output_contains", text: "hello" }]),
    ]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.errored).toBe(1);
    expect(card.passed).toBe(1);
    expect(card.failed).toBe(0);
    expect(card.trials.find((t) => t.caseId === "boom")?.error).toBeDefined();
  });

  it("blames a mute vendor on the vendor, not on the Case", async () => {
    // `empty_model_output` is raised after the repair budget is spent nudging a provider that
    // answered with nothing. It is the one loop failure that is the vendor's fault yet carries no
    // `model_` prefix; scoring it as a failure would read as a harness regression.
    const mute: ModelBinding = {
      id: "mute",
      create: () => ({
        invoke: async (request) => ({
          requestId: request.requestId,
          output: { kind: "text", text: "" },
          usage: { inputTokens: 10, outputTokens: 0, costBasis: "subscription" },
        }),
      }),
    };
    const corpus = corpusOf([answering("mute", "", [{ kind: "output_contains", text: "x" }])]);

    const card = await runSweep({ corpus, model: mute });

    expect(card.errored).toBe(1);
    expect(card.failed).toBe(0);
  });

  it("records the Corpus hash and model id, because a Scorecard without them cannot be compared", async () => {
    const corpus = corpusOf([answering("x", "y", [])]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.corpusHash).toBe(corpus.hash);
    expect(card.modelId).toBe("scripted");
  });

  it("repeats a Case that declares multiple Trials", async () => {
    const repeated: EvalCase = {
      ...answering("noisy", "hello", [{ kind: "output_contains", text: "hello" }]),
      trials: 3,
    };
    const card = await runSweep({ corpus: corpusOf([repeated]), model: scriptedBinding() });
    expect(card.trials).toHaveLength(3);
    expect(card.trials.map((t) => t.trial)).toEqual([1, 2, 3]);
    expect(card.passed).toBe(3);
  });

  it("runs only the Case named by the filter", async () => {
    const corpus = corpusOf([answering("a", "x", []), answering("b", "y", [])]);
    const card = await runSweep({ corpus, model: scriptedBinding(), caseFilter: "b" });
    expect(card.trials.map((t) => t.caseId)).toEqual(["b"]);
  });

  it("fails loudly when the filter matches nothing, rather than reporting an empty pass", async () => {
    const corpus = corpusOf([answering("a", "x", [])]);
    await expect(
      runSweep({ corpus, model: scriptedBinding(), caseFilter: "ghost" })
    ).rejects.toThrow(/ghost/);
  });

  it("treats a Case with no expectations as passing but marks it vacuous", async () => {
    const card = await runSweep({
      corpus: corpusOf([answering("empty", "x", [])]),
      model: scriptedBinding(),
    });
    expect(card.trials[0].passed).toBe(true);
    expect(card.trials[0].vacuous).toBe(true);
  });
});

describe("runSweep spend", () => {
  /** A binding that charges a fixed amount per Trial and reports a vendor version. */
  const charging = (costUsd: number, version?: string): ModelBinding => ({
    id: "priced",
    ...(version === undefined ? {} : { reportedVersion: () => version }),
    create: () => ({
      invoke: async (request) => ({
        requestId: request.requestId,
        output: { kind: "text", text: "answer" },
        usage: { inputTokens: 1000, outputTokens: 200, costUsd, costBasis: "priced" },
      }),
    }),
  });

  const cases = (n: number) =>
    corpusOf(
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        tier: "l2" as const,
        agent: "triage",
        context: { agentId: "triage", memory: [], governancePages: [] },
        input: [{ role: "user" as const, content: "hello" }],
        expect: [{ kind: "output_contains" as const, text: "answer" }],
      }))
    );

  it("totals what the Sweep spent across every Trial", async () => {
    const card = await runSweep({ corpus: cases(3), model: charging(0.01) });

    expect(card.spend).toMatchObject({ costUsd: 0.03, calls: 3, inputTokens: 3000 });
    expect(card.skipped).toBe(0);
  });

  it("stops launching Trials once the ceiling is reached, and says so", async () => {
    // The ceiling cannot be an exact cap — a call's cost is only knowable after it is made — so
    // the bound is one Trial of overrun rather than the whole remaining Corpus.
    const card = await runSweep({ corpus: cases(10), model: charging(0.01), maxSpendUsd: 0.025 });

    expect(card.trials).toHaveLength(3);
    expect(card.skipped).toBe(7);
    expect(card.abortedReason).toMatch(/spend ceiling reached/);
  });

  it("refuses to keep going when a dollar ceiling is bounding a total it understates", async () => {
    // An unpriced call cost real money and adds 0 to `costUsd`. Letting the Sweep continue would
    // run the whole Corpus while reporting there was budget left.
    const unpriceable: ModelBinding = {
      id: "unpriceable",
      create: () => ({
        invoke: async (request) => ({
          requestId: request.requestId,
          output: { kind: "text", text: "answer" },
          usage: { inputTokens: 1000, outputTokens: 200, costBasis: "unpriced" },
        }),
      }),
    };

    const card = await runSweep({ corpus: cases(5), model: unpriceable, maxSpendUsd: 100 });

    expect(card.trials).toHaveLength(1);
    expect(card.abortedReason).toMatch(/could not be priced/);
  });

  it("stops on a token ceiling, which is the only one a subscription seat can trip", async () => {
    // A seat's marginal cost is genuinely zero, so `maxSpendUsd` never fires on one. Without a
    // token ceiling a runaway Corpus would exhaust the operator's quota unopposed.
    const seat: ModelBinding = {
      id: "seat",
      create: () => ({
        invoke: async (request) => ({
          requestId: request.requestId,
          output: { kind: "text", text: "answer" },
          usage: { inputTokens: 1000, outputTokens: 200, costBasis: "subscription" },
        }),
      }),
    };

    const card = await runSweep({
      corpus: cases(10),
      model: seat,
      maxSpendUsd: 100,
      maxTokens: 2500,
    });

    expect(card.trials).toHaveLength(3);
    expect(card.abortedReason).toMatch(/token ceiling reached/);
    expect(card.spend).toMatchObject({ costUsd: 0, subscription: 3 });
  });

  it("records the version the vendor reported, not the one that was asked for", async () => {
    const card = await runSweep({ corpus: cases(1), model: charging(0, "sonnet-rev2") });

    expect(card.modelVersion).toBe("sonnet-rev2");
  });

  it("leaves the version unset when the binding cannot observe one", async () => {
    const card = await runSweep({ corpus: cases(1), model: charging(0) });

    expect(card.modelVersion).toBeUndefined();
  });

  it("reports each Trial as it starts and finishes, so a slow Sweep is never silent", async () => {
    const events: string[] = [];

    await runSweep({
      corpus: corpusOf([
        answering("a", "ok", [{ kind: "output_contains", text: "hello" }]),
        answering("b", "ok", [{ kind: "output_contains", text: "hello" }]),
      ]),
      model: scriptedBinding(),
      onProgress: (e) => {
        events.push(e.kind === "trial-start" ? `start:${e.caseId}` : e.kind);
      },
    });

    expect(events).toEqual(["sweep-start", "start:a", "trial-end", "start:b", "trial-end"]);
  });

  it("reports stopping early, so a truncated Sweep does not look like a finished one", async () => {
    const events: string[] = [];

    await runSweep({
      corpus: corpusOf([
        answering("a", "ok", [{ kind: "output_contains", text: "hello" }]),
        answering("b", "ok", [{ kind: "output_contains", text: "hello" }]),
      ]),
      // The scripted binding spends nothing, so no ceiling can ever trip on it.
      model: {
        id: "metered",
        create: () => ({
          invoke: async (request) => ({
            requestId: request.requestId,
            output: { kind: "text", text: "hello" },
            usage: { inputTokens: 100, outputTokens: 1 },
          }),
        }),
      },
      maxTokens: 1,
      onProgress: (e) => {
        events.push(e.kind);
      },
    });

    expect(events).toContain("sweep-aborted");
  });
});
