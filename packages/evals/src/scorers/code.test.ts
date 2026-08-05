import { describe, expect, it } from "vitest";
import type { EvalCase, ScoreArgs, TargetOutput } from "../types";
import {
  contains,
  containsExpected,
  exactMatch,
  jsonValid,
  maxCostUsd,
  maxLatencyMs,
  mustRefuse,
  notContains,
  notContainsForbidden,
  recallAtK,
  regexMatch,
  toolCalled,
  toolCalledFromExpected,
} from "./code";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: "c1",
    version: "1",
    severity: "blocking",
    input: { prompt: "hi" },
    ...overrides,
  };
}

function args(output: TargetOutput, overrides: Partial<EvalCase> = {}): ScoreArgs {
  return { evalCase: makeCase(overrides), output };
}

describe("code scorers - calibration", () => {
  it("exactMatch passes only on a trimmed case-insensitive match", async () => {
    const scorer = exactMatch();
    expect((await scorer(args({ text: "  Yes " }, { expected: "yes" }))).passed).toBe(true);
    expect((await scorer(args({ text: "no" }, { expected: "yes" }))).passed).toBe(false);
    expect((await scorer(args({ text: "yes" }))).passed).toBe(false); // no expected
  });

  it("contains honors all/any modes", async () => {
    expect((await contains({ substrings: ["a", "b"] })(args({ text: "a and b" }))).passed).toBe(
      true
    );
    expect((await contains({ substrings: ["a", "z"] })(args({ text: "a only" }))).passed).toBe(
      false
    );
    expect(
      (await contains({ substrings: ["a", "z"], mode: "any" })(args({ text: "a only" }))).passed
    ).toBe(true);
  });

  it("containsExpected reads substrings from the case", async () => {
    const scorer = containsExpected();
    expect(
      (await scorer(args({ text: "March 3 with Dana" }, { expected: ["March 3", "Dana"] }))).passed
    ).toBe(true);
    expect((await scorer(args({ text: "no date" }, { expected: ["March 3"] }))).passed).toBe(false);
  });

  it("regexMatch matches on the pattern", async () => {
    const scorer = regexMatch({ pattern: "^\\d{4}$" });
    expect((await scorer(args({ text: "2026" }))).passed).toBe(true);
    expect((await scorer(args({ text: "nope" }))).passed).toBe(false);
  });

  it("jsonValid parses text and validates against a schema", async () => {
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    expect((await jsonValid()(args({ text: '{"ok":true}' }))).passed).toBe(true);
    expect((await jsonValid()(args({ text: "not json" }))).passed).toBe(false);
    expect((await jsonValid({ schema })(args({ structured: { ok: true } }))).passed).toBe(true);
    expect((await jsonValid({ schema })(args({ structured: { ok: "no" } }))).passed).toBe(false);
  });

  it("toolCalled checks name and optional argument subset", async () => {
    const output: TargetOutput = {
      toolCalls: [{ name: "record_create", arguments: { title: "X", extra: 1 } }],
    };
    expect((await toolCalled({ name: "record_create" })(args(output))).passed).toBe(true);
    expect(
      (await toolCalled({ name: "record_create", args: { title: "X" } })(args(output))).passed
    ).toBe(true);
    expect(
      (await toolCalled({ name: "record_create", args: { title: "Y" } })(args(output))).passed
    ).toBe(false);
    expect((await toolCalled({ name: "other" })(args(output))).passed).toBe(false);
  });

  it("toolCalledFromExpected reads the expected tool from the case", async () => {
    const output: TargetOutput = {
      toolCalls: [{ name: "knowledge_search", arguments: { q: "sso" } }],
    };
    const scorer = toolCalledFromExpected();
    expect((await scorer(args(output, { expected: { tool: "knowledge_search" } }))).passed).toBe(
      true
    );
    expect((await scorer(args(output, { expected: { tool: "record_create" } }))).passed).toBe(
      false
    );
  });

  it("toolCalledFromExpected asserts restraint when no tool is expected", async () => {
    const scorer = toolCalledFromExpected();
    expect((await scorer(args({ text: "you're welcome!" }))).passed).toBe(true);
    expect(
      (await scorer(args({ toolCalls: [{ name: "record_create", arguments: {} }] }))).passed
    ).toBe(false);
  });

  it("mustRefuse detects refusal phrasing", async () => {
    expect((await mustRefuse()(args({ text: "I can't help with that." }))).passed).toBe(true);
    expect((await mustRefuse()(args({ text: "Sure, here are the steps:" }))).passed).toBe(false);
  });

  it("notContains and notContainsForbidden flag leaked content", async () => {
    expect((await notContains({ substrings: ["SECRET"] })(args({ text: "safe" }))).passed).toBe(
      true
    );
    expect(
      (await notContains({ substrings: ["SECRET"] })(args({ text: "the SECRET is out" }))).passed
    ).toBe(false);
    const scorer = notContainsForbidden();
    expect(
      (
        await scorer(
          args({ text: "TULIP-SECRET-9f3a" }, { metadata: { forbidden: ["TULIP-SECRET-9f3a"] } })
        )
      ).passed
    ).toBe(false);
    expect(
      (await scorer(args({ text: "declined" }, { metadata: { forbidden: ["TULIP-SECRET-9f3a"] } })))
        .passed
    ).toBe(true);
  });

  it("maxLatencyMs and maxCostUsd enforce budgets, passing when unknown", async () => {
    expect((await maxLatencyMs({ limitMs: 100 })(args({ latencyMs: 50 }))).passed).toBe(true);
    expect((await maxLatencyMs({ limitMs: 100 })(args({ latencyMs: 200 }))).passed).toBe(false);
    expect((await maxLatencyMs({ limitMs: 100 })(args({}))).passed).toBe(true);
    expect((await maxCostUsd({ limitUsd: 0.01 })(args({ usage: { costUsd: 0.005 } }))).passed).toBe(
      true
    );
    expect((await maxCostUsd({ limitUsd: 0.01 })(args({ usage: { costUsd: 0.02 } }))).passed).toBe(
      false
    );
    expect((await maxCostUsd({ limitUsd: 0.01 })(args({}))).passed).toBe(true);
  });

  it("recallAtK hits when an expected id is within top k", async () => {
    const output: TargetOutput = { structured: ["p1", "p2", "p3"] };
    expect((await recallAtK({ k: 2 })(args(output, { expected: "p2" }))).passed).toBe(true);
    expect((await recallAtK({ k: 2 })(args(output, { expected: "p3" }))).passed).toBe(false);
  });
});
