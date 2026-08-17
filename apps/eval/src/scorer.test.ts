import { describe, expect, it } from "vitest";
import type { Expectation } from "./case.ts";
import { type Observation, scoreCase } from "./scorer.ts";

const base: Observation = {
  systemPrompt: "<agent-identity>\nagentId: triage\n</agent-identity>",
  toolCalls: [
    { name: "search", arguments: { query: "refund" } },
    { name: "ticket.create", arguments: { title: "Refund", priority: 2 } },
  ],
  output: { kind: "text", text: "I opened a ticket for you." },
  status: "completed",
};

const only = (a: Expectation, obs: Observation = base) => scoreCase([a], obs)[0];

describe("prompt expectations", () => {
  it("passes when the assembled prompt contains the text", () => {
    expect(only({ kind: "prompt_contains", text: "agentId: triage" }).passed).toBe(true);
  });

  it("fails when it does not, and says so", () => {
    const r = only({ kind: "prompt_contains", text: "agentId: billing" });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("agentId: billing");
  });

  it("omits is the inverse", () => {
    expect(only({ kind: "prompt_omits", text: "SECRET" }).passed).toBe(true);
    expect(only({ kind: "prompt_omits", text: "triage" }).passed).toBe(false);
  });
});

describe("tool expectations", () => {
  it("detects a Tool that was called and one that was not", () => {
    expect(only({ kind: "tool_called", name: "search" }).passed).toBe(true);
    expect(only({ kind: "tool_called", name: "refund.issue" }).passed).toBe(false);
    expect(only({ kind: "tool_not_called", name: "refund.issue" }).passed).toBe(true);
    expect(only({ kind: "tool_not_called", name: "search" }).passed).toBe(false);
  });

  it("checks relative order and ignores unnamed calls between", () => {
    expect(only({ kind: "tool_call_order", names: ["search", "ticket.create"] }).passed).toBe(true);
    expect(only({ kind: "tool_call_order", names: ["ticket.create", "search"] }).passed).toBe(
      false
    );
  });

  it("fails an order expectation naming a Tool that never ran", () => {
    const r = only({ kind: "tool_call_order", names: ["search", "never"] });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("never");
  });

  it("reads a nested argument by path", () => {
    expect(
      only({ kind: "tool_argument_equals", name: "ticket.create", path: "priority", value: 2 })
        .passed
    ).toBe(true);
    expect(
      only({ kind: "tool_argument_equals", name: "ticket.create", path: "priority", value: 9 })
        .passed
    ).toBe(false);
  });

  it("fails an argument expectation when the Tool never ran", () => {
    const r = only({ kind: "tool_argument_equals", name: "ghost", path: "a", value: 1 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("never called");
  });

  it("counts calls", () => {
    expect(only({ kind: "tool_call_count", count: 2 }).passed).toBe(true);
    expect(only({ kind: "tool_call_count", count: 3 }).passed).toBe(false);
  });
});

describe("output expectations", () => {
  it("matches text output by substring and regex", () => {
    expect(only({ kind: "output_contains", text: "opened a ticket" }).passed).toBe(true);
    expect(only({ kind: "output_matches", pattern: "^I opened" }).passed).toBe(true);
    expect(only({ kind: "output_matches", pattern: "^refund" }).passed).toBe(false);
  });

  it("treats a malformed regex as a failed expectation, not a crash", () => {
    const r = only({ kind: "output_matches", pattern: "([unclosed" });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("invalid pattern");
  });

  it("reads a field out of structured output", () => {
    const obs: Observation = {
      ...base,
      output: { kind: "structured", value: { ticket: { id: "T-1", tags: ["refund"] } } },
    };
    expect(only({ kind: "output_field_equals", path: "ticket.id", value: "T-1" }, obs).passed).toBe(
      true
    );
    expect(
      only({ kind: "output_field_equals", path: "ticket.tags.0", value: "refund" }, obs).passed
    ).toBe(true);
    expect(
      only({ kind: "output_field_equals", path: "ticket.missing", value: "x" }, obs).passed
    ).toBe(false);
  });

  it("compares objects structurally, not by reference", () => {
    const obs: Observation = {
      ...base,
      output: { kind: "structured", value: { a: { b: [1, 2] } } },
    };
    expect(only({ kind: "output_field_equals", path: "a", value: { b: [1, 2] } }, obs).passed).toBe(
      true
    );
  });

  it("fails an output expectation when the loop produced nothing", () => {
    const obs: Observation = { ...base, output: undefined };
    const r = only({ kind: "output_contains", text: "anything" }, obs);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("no output");
  });

  it("does not read text expectations against tool_calls output", () => {
    const obs: Observation = {
      ...base,
      output: { kind: "tool_calls", calls: [{ callId: "1", name: "search", arguments: {} }] },
    };
    expect(only({ kind: "output_contains", text: "search" }, obs).passed).toBe(false);
  });
});

describe("loop status", () => {
  it("matches the terminal status", () => {
    expect(only({ kind: "loop_status", status: "completed" }).passed).toBe(true);
    expect(only({ kind: "loop_status", status: "failed" }).passed).toBe(false);
  });
});

describe("scoring a Case", () => {
  it("returns one result per expectation, in order", () => {
    const results = scoreCase(
      [
        { kind: "loop_status", status: "completed" },
        { kind: "tool_called", name: "search" },
      ],
      base
    );
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it("scores every expectation even after one fails", () => {
    const results = scoreCase(
      [
        { kind: "tool_called", name: "ghost" },
        { kind: "tool_called", name: "search" },
      ],
      base
    );
    expect(results.map((r) => r.passed)).toEqual([false, true]);
  });

  it("treats an empty expectation list as vacuously passing", () => {
    expect(scoreCase([], base)).toEqual([]);
  });

  it("fails, rather than passing or throwing, on a malformed expectation", () => {
    // These cannot come from `loadCorpus`, which rejects them, but `scoreCase` is documented as
    // total: a missing pattern must not compile to an empty regex that matches everything, and a
    // missing path must not throw inside a path split.
    const malformed = [
      { kind: "output_matches" },
      { kind: "output_field_equals", value: 1 },
      { kind: "tool_argument_equals", name: "search", value: 1 },
    ] as unknown as Expectation[];
    const results = scoreCase(malformed, base);
    expect(results.map((r) => r.passed)).toEqual([false, false, false]);
  });
});

describe("output expectations are judged on substance, not on surface", () => {
  const saying = (text: string): Observation => ({ ...base, output: { kind: "text", text } });

  it("matches a fact the model capitalised differently", () => {
    expect(
      only({ kind: "output_matches", pattern: "9\\s*am" }, saying("We open at 9 AM.")).passed
    ).toBe(true);
  });

  it("contains a fact the model capitalised differently", () => {
    expect(
      only({ kind: "output_contains", text: "ticket" }, saying("Opened a TICKET.")).passed
    ).toBe(true);
  });

  it("still rejects a different fact", () => {
    expect(
      only({ kind: "output_matches", pattern: "9\\s*am" }, saying("We open at 10am.")).passed
    ).toBe(false);
  });

  it("keeps the prompt Expectations exact — that string is one this repo assembled", () => {
    expect(only({ kind: "prompt_contains", text: "AGENTID: TRIAGE" }).passed).toBe(false);
  });
});

describe("a failing output Expectation shows what the model actually said", () => {
  const saying = (text: string): Observation => ({ ...base, output: { kind: "text", text } });

  it("quotes the answer, so the failure can be acted on without re-running the vendor", () => {
    const r = only({ kind: "output_matches", pattern: "9am" }, saying("We open at half past ten."));

    expect(r.detail).toContain("half past ten");
  });

  it("quotes it for a missing substring too", () => {
    const r = only({ kind: "output_contains", text: "refund" }, saying("I cannot help with that."));

    expect(r.detail).toContain("I cannot help with that.");
  });

  it("collapses newlines, which would otherwise break the Scorecard's layout", () => {
    const r = only({ kind: "output_contains", text: "zzz" }, saying("one\ntwo\n\nthree"));

    expect(r.detail).toContain("one two three");
    expect(r.detail).not.toContain("\n");
  });

  it("truncates a long answer rather than flooding the Scorecard", () => {
    const r = only({ kind: "output_contains", text: "zzz" }, saying("x".repeat(5000)));

    expect(r.detail.length).toBeLessThan(400);
    expect(r.detail).toContain("…");
  });

  it("says so when the model said nothing at all", () => {
    const r = only({ kind: "output_contains", text: "zzz" }, saying("   "));

    expect(r.detail).toContain("<empty>");
  });
});
