import { describe, expect, it } from "vitest";
import type { Expectation } from "./case.ts";
import { type ExpectationResult, type Observation, scoreCase, seamUnreached } from "./scorer.ts";

const base: Observation = {
  systemPrompt: "<agent-identity>\nagentId: triage\n</agent-identity>",
  toolCalls: [
    { name: "search", arguments: { query: "refund" } },
    { name: "ticket.create", arguments: { title: "Refund", priority: 2 } },
  ],
  output: { kind: "text", text: "I opened a ticket for you." },
  status: "completed",
  guardrails: [],
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

  it("names the calls it counted, so a wrong count can be acted on", () => {
    // A bare count cannot distinguish a harness re-dispatching one call from a model choosing to
    // split its work, and recovering the difference costs another Sweep against a paid seat.
    const r = only({ kind: "tool_call_count", count: 1 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('search({"query":"refund"})');
    expect(r.detail).toContain("then");
    expect(r.detail).toContain("ticket.create(");
  });

  it("says so plainly when the count is wrong because nothing ran", () => {
    const r = only({ kind: "tool_call_count", count: 1 }, { ...base, toolCalls: [] });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("called none");
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

describe("guardrail expectations", () => {
  const blocked: Observation = {
    ...base,
    guardrails: [
      { stage: "tool_call", guard: "tool_blocklist", reason: "issue_refund is blocked" },
    ],
  };

  it("passes when the named guard refused at the named stage", () => {
    expect(
      only({ kind: "guardrail_blocked", stage: "tool_call", guard: "tool_blocklist" }, blocked)
        .passed
    ).toBe(true);
  });

  it("fails when a different guard fired, so a Case cannot pass on the wrong rule", () => {
    const result = only(
      { kind: "guardrail_blocked", stage: "tool_call", guard: "content_filter" },
      blocked
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("tool_call/tool_blocklist");
  });

  it("fails when nothing refused, and says so rather than reporting a bare miss", () => {
    const result = only({ kind: "guardrail_blocked", stage: "output", guard: "content_filter" });

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("no guard refused anywhere in the turn");
  });

  it("passes guardrail_allowed only when the stage let the turn through", () => {
    expect(only({ kind: "guardrail_allowed", stage: "tool_call" }).passed).toBe(true);
    expect(only({ kind: "guardrail_allowed", stage: "tool_call" }, blocked).passed).toBe(false);
  });

  it("scopes guardrail_allowed to its own stage", () => {
    expect(only({ kind: "guardrail_allowed", stage: "output" }, blocked).passed).toBe(true);
  });
});

describe("structured output read from text", () => {
  const withOutput = (output: Observation["output"]): Observation => ({ ...base, output });

  it("reads a bare JSON object a vendor returned as text", () => {
    const obs = withOutput({ kind: "text", text: '{"status":"open","owner":"dana"}' });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("reads a JSON object inside a fenced block", () => {
    const obs = withOutput({ kind: "text", text: 'Here:\n```json\n{"status":"open"}\n```' });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("still reads a genuinely structured output", () => {
    const obs = withOutput({ kind: "structured", value: { status: "closed" } });

    expect(only({ kind: "output_field_equals", path: "status", value: "closed" }, obs).passed).toBe(
      true
    );
  });

  it("reads JSON after a prose preamble", () => {
    const obs = withOutput({ kind: "text", text: 'Here is the report:\n{"status":"open"}' });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("reads JSON followed by trailing commentary", () => {
    const obs = withOutput({
      kind: "text",
      text: '{"status":"open"}\n\nLet me know if you need more.',
    });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("skips a leading fence that holds the model's plan, not the answer", () => {
    const obs = withOutput({
      kind: "text",
      text: '```\nfirst look the ticket up\n```\n\n```json\n{"status":"open"}\n```',
    });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("tolerates an upper-case language tag", () => {
    const obs = withOutput({ kind: "text", text: '```JSON\n{"status":"open"}\n```' });

    expect(only({ kind: "output_field_equals", path: "status", value: "open" }, obs).passed).toBe(
      true
    );
  });

  it("is not confused by a brace inside a JSON string", () => {
    const obs = withOutput({ kind: "text", text: 'Report: {"status":"open {not json}"} done.' });

    expect(
      only({ kind: "output_field_equals", path: "status", value: "open {not json}" }, obs).passed
    ).toBe(true);
  });

  it("refuses a bare primitive, which no path could ever be read from", () => {
    const obs = withOutput({ kind: "text", text: "123" });

    expect(only({ kind: "output_field_equals", path: "status", value: 123 }, obs).passed).toBe(
      false
    );
  });

  it("fails on prose, and quotes what the model said instead", () => {
    const result = only(
      { kind: "output_field_equals", path: "status", value: "open" },
      withOutput({ kind: "text", text: "The ticket is open." })
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("The ticket is open.");
  });

  it("fails on malformed JSON rather than throwing", () => {
    const result = only(
      { kind: "output_field_equals", path: "status", value: "open" },
      withOutput({ kind: "text", text: '{"status":' })
    );

    expect(result.passed).toBe(false);
  });
});

describe("output_omits", () => {
  it("passes when the text is absent", () => {
    expect(only({ kind: "output_omits", text: "4111" }).passed).toBe(true);
  });

  it("fails when the text survived, and quotes the answer", () => {
    const result = only({ kind: "output_omits", text: "ticket" });

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("opened a ticket");
  });

  it("fails when there was no answer at all, rather than calling that a scrub", () => {
    const obs: Observation = { ...base, output: undefined };

    expect(only({ kind: "output_omits", text: "4111" }, obs).passed).toBe(false);
  });
});

describe("an Expectation whose seam a Tool call has to open", () => {
  const fail = (expectation: Expectation): ExpectationResult => ({
    expectation,
    passed: false,
    detail: "did not hold",
  });
  const pass = (expectation: Expectation): ExpectationResult => ({
    expectation,
    passed: true,
    detail: "held",
  });
  const commit: Expectation = { kind: "soul_committed", path: "agents/billing/AGENT.md" };

  it("names the Tool when the model never called it", () => {
    expect(seamUnreached([fail(commit)], [])).toBe("soul_write");
  });

  it("stays silent once the Tool was called, so a broken commit path still fails", () => {
    // The whole point of the hold-out is to tell "the model declined" from "the harness stopped
    // persisting". Once the call happened, a missing artifact is the second, and must fail loudly.
    expect(seamUnreached([fail(commit)], [{ name: "soul_write" }])).toBeUndefined();
  });

  it("has nothing to say about a Case that asserts no seam", () => {
    expect(seamUnreached([fail({ kind: "output_contains", text: "hello" })], [])).toBeUndefined();
  });

  it("holds out the Expectations downstream of the write, seam Tool or not", () => {
    // `prompt_contains` asks whether the *next* Turn saw the Agent. With nothing written there is
    // nothing to see, so it fails for the model's reason, not the harness's.
    const scored = [fail(commit), fail({ kind: "prompt_contains", text: "billing" })];
    expect(seamUnreached(scored, [])).toBe("soul_write");
  });

  it("stays silent when a lifecycle Expectation failed, whatever else did", () => {
    // A Turn has to complete whether or not the model volunteered a Tool. Laundering that into
    // `unexercised` would let a Matrix leg where another model passed hide a real Run failure.
    const scored = [fail(commit), fail({ kind: "run_status", status: "succeeded" })];
    expect(seamUnreached(scored, [])).toBeUndefined();
  });

  it("stays silent when nothing failed", () => {
    expect(seamUnreached([pass(commit)], [])).toBeUndefined();
  });
});

describe("who may read a File the Turn generated", () => {
  const withFiles = (
    generatedFiles: { filename: string; readableBy: string[] }[]
  ): Observation => ({
    ...base,
    persisted: {
      runStatus: "succeeded",
      stateStatus: "succeeded",
      turnStatus: "succeeded",
      events: [],
      soulCommits: [],
      generatedFiles: generatedFiles.map((f) => ({ fileId: f.filename, ...f })),
    },
  });

  it("passes when the named grantee is in the audience", () => {
    const obs = withFiles([{ filename: "a.pdf", readableBy: ["user:eval", "role:hr-team"] }]);
    expect(only({ kind: "generated_file_readable_by", grantee: "role:hr-team" }, obs).passed).toBe(
      true
    );
  });

  it("fails when it is not, and names both the grantee and who actually got it", () => {
    const obs = withFiles([{ filename: "a.pdf", readableBy: ["user:eval"] }]);
    const r = only({ kind: "generated_file_readable_by", grantee: "role:hr-team" }, obs);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("role:hr-team");
    expect(r.detail).toContain("user:eval");
  });

  it("bounds the widening: a Role the Agent does not hold must not appear", () => {
    const obs = withFiles([{ filename: "a.pdf", readableBy: ["user:eval", "role:hr-team"] }]);
    expect(
      only({ kind: "generated_file_not_readable_by", grantee: "role:finance" }, obs).passed
    ).toBe(true);
    expect(
      only({ kind: "generated_file_not_readable_by", grantee: "role:hr-team" }, obs).passed
    ).toBe(false);
  });

  it("checks every File, so a second document cannot satisfy the Expectation alone", () => {
    // A Turn that wrote two documents and shared only one with the team has leaked the other into
    // a narrower audience than the operator configured. Scoring the last one would call that fine.
    const obs = withFiles([
      { filename: "a.pdf", readableBy: ["user:eval"] },
      { filename: "b.pdf", readableBy: ["user:eval", "role:hr-team"] },
    ]);
    const r = only({ kind: "generated_file_readable_by", grantee: "role:hr-team" }, obs);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("a.pdf");
    expect(r.detail).not.toContain("b.pdf");
  });

  it("fails rather than passes vacuously when the Turn generated nothing", () => {
    const r = only({ kind: "generated_file_readable_by", grantee: "role:hr-team" }, withFiles([]));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("no File");
  });

  it("is held out as unexercised when the model never called the Tool", () => {
    const scored = [
      {
        expectation: { kind: "generated_file_readable_by", grantee: "role:hr-team" } as Expectation,
        passed: false,
        detail: "the Turn generated no File",
      },
    ];
    expect(seamUnreached(scored, [])).toBe("file_create");
    expect(seamUnreached(scored, [{ name: "file_create" }])).toBeUndefined();
  });
});
