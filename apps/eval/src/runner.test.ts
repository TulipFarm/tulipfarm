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

  it("reports a failing Case as failed and keeps the assertion detail", async () => {
    const corpus = corpusOf([
      answering("greets", "hello there", [{ kind: "output_contains", text: "goodbye" }]),
    ]);
    const card = await runSweep({ corpus, model: scriptedBinding() });
    expect(card.failed).toBe(1);
    expect(card.trials[0].assertions[0].detail).toContain("goodbye");
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
    expect(card.trials[0].assertions.every((a) => a.passed)).toBe(true);
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

  it("treats a Case with no assertions as passing but marks it unasserted", async () => {
    const card = await runSweep({
      corpus: corpusOf([answering("empty", "x", [])]),
      model: scriptedBinding(),
    });
    expect(card.trials[0].passed).toBe(true);
    expect(card.trials[0].unasserted).toBe(true);
  });
});
