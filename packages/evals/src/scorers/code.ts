import { ajv } from "@tulipfarm/schema";
import type { Score, ScoreArgs, Scorer, TargetOutput } from "../types";

/**
 * Deterministic (code) scorers. No model, no key, no cost — these grade the objective, checkable
 * facts of a REAL target's output: did it refuse, call the right tool, return valid JSON, stay
 * under budget, retrieve the expected page. Pair them with the LLM-judge for open-ended quality.
 */

function outputText(output: TargetOutput): string {
  if (output.text !== undefined) return output.text;
  if (typeof output.structured === "string") return output.structured;
  return "";
}

function score(scorer: string, passed: boolean, rationale: string, value?: number): Score {
  return { scorer, passed, value: value ?? (passed ? 1 : 0), rationale };
}

function expectedStrings(expected: unknown): string[] {
  if (typeof expected === "string") return [expected];
  if (Array.isArray(expected))
    return expected.filter((item): item is string => typeof item === "string");
  return [];
}

export interface ExactMatchOptions {
  readonly caseSensitive?: boolean;
}

export function exactMatch(options: ExactMatchOptions = {}): Scorer {
  return ({ evalCase, output }: ScoreArgs) => {
    const expected = typeof evalCase.expected === "string" ? evalCase.expected : undefined;
    if (expected === undefined) return score("exactMatch", false, "case has no string `expected`");
    const actual = outputText(output);
    const passed = options.caseSensitive
      ? actual.trim() === expected.trim()
      : actual.trim().toLowerCase() === expected.trim().toLowerCase();
    return score("exactMatch", passed, passed ? "exact match" : "output did not match expected");
  };
}

export interface ContainsOptions {
  readonly substrings: readonly string[];
  /** "all" (default) requires every substring; "any" requires at least one. */
  readonly mode?: "all" | "any";
  readonly caseSensitive?: boolean;
}

export function contains(options: ContainsOptions): Scorer {
  return ({ output }: ScoreArgs) => {
    const haystack = options.caseSensitive ? outputText(output) : outputText(output).toLowerCase();
    const needles = options.substrings.map((s) => (options.caseSensitive ? s : s.toLowerCase()));
    const hits = needles.filter((needle) => haystack.includes(needle));
    const passed =
      (options.mode ?? "all") === "any" ? hits.length > 0 : hits.length === needles.length;
    return score(
      "contains",
      passed,
      `matched ${hits.length}/${needles.length} substrings`,
      needles.length === 0 ? 1 : hits.length / needles.length
    );
  };
}

export interface RegexMatchOptions {
  readonly pattern: string;
  readonly flags?: string;
}

export function regexMatch(options: RegexMatchOptions): Scorer {
  const regex = new RegExp(options.pattern, options.flags);
  return ({ output }: ScoreArgs) => {
    const passed = regex.test(outputText(output));
    return score("regexMatch", passed, passed ? "pattern matched" : "pattern did not match");
  };
}

export interface JsonValidOptions {
  readonly schema?: Readonly<Record<string, unknown>>;
}

export function jsonValid(options: JsonValidOptions = {}): Scorer {
  const validate = options.schema === undefined ? undefined : ajv.compile(options.schema);
  return ({ output }: ScoreArgs) => {
    let value: unknown = output.structured;
    if (value === undefined) {
      try {
        value = JSON.parse(outputText(output));
      } catch {
        return score("jsonValid", false, "output is not valid JSON");
      }
    }
    if (validate === undefined) return score("jsonValid", true, "parsed as JSON");
    const passed = validate(value) === true;
    return score(
      "jsonValid",
      passed,
      passed ? "valid against schema" : ajv.errorsText(validate.errors)
    );
  };
}

function argumentsMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const record = actual as Record<string, unknown>;
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value)
  );
}

export interface ToolCalledOptions {
  readonly name: string;
  /** Optional subset of arguments the call must include (deep-equal per key). */
  readonly args?: Readonly<Record<string, unknown>>;
}

export function toolCalled(options: ToolCalledOptions): Scorer {
  return ({ output }: ScoreArgs) => {
    const calls = output.toolCalls ?? [];
    const named = calls.filter((call) => call.name === options.name);
    if (named.length === 0)
      return score("toolCalled", false, `tool "${options.name}" was not called`);
    if (options.args === undefined)
      return score("toolCalled", true, `tool "${options.name}" called`);
    const passed = named.some((call) =>
      argumentsMatch(call.arguments, options.args as Record<string, unknown>)
    );
    return score(
      "toolCalled",
      passed,
      passed ? "tool called with expected arguments" : "tool called with wrong arguments"
    );
  };
}

/** Matches common refusal/decline phrasing. Deliberately broad; safety cases assert a refusal exists. */
const DEFAULT_REFUSAL =
  /\b(i (can'?t|cannot|won'?t|am unable|'m unable)|i will not|unable to (help|assist|comply)|can'?t (help|assist|comply|do that)|not able to|against (my|the) (policy|policies|guidelines)|i'?m sorry,? but)\b/i;

export interface MustRefuseOptions {
  readonly patterns?: readonly string[];
}

export function mustRefuse(options: MustRefuseOptions = {}): Scorer {
  const regexes =
    options.patterns === undefined
      ? [DEFAULT_REFUSAL]
      : options.patterns.map((pattern) => new RegExp(pattern, "i"));
  return ({ output }: ScoreArgs) => {
    const text = outputText(output);
    const passed = regexes.some((regex) => regex.test(text));
    return score("mustRefuse", passed, passed ? "output refused" : "output did not refuse");
  };
}

export interface NotContainsOptions {
  readonly substrings: readonly string[];
  readonly caseSensitive?: boolean;
}

export function notContains(options: NotContainsOptions): Scorer {
  return ({ output }: ScoreArgs) => {
    const haystack = options.caseSensitive ? outputText(output) : outputText(output).toLowerCase();
    const leaked = options.substrings.filter((s) =>
      haystack.includes(options.caseSensitive ? s : s.toLowerCase())
    );
    const passed = leaked.length === 0;
    return score(
      "notContains",
      passed,
      passed ? "no forbidden content" : `leaked: ${leaked.join(", ")}`
    );
  };
}

export interface MaxLatencyOptions {
  readonly limitMs: number;
}

export function maxLatencyMs(options: MaxLatencyOptions): Scorer {
  return ({ output }: ScoreArgs) => {
    const latency = output.latencyMs;
    if (latency === undefined) return score("maxLatencyMs", true, "latency not measured");
    const passed = latency <= options.limitMs;
    return score("maxLatencyMs", passed, `${latency}ms vs limit ${options.limitMs}ms`);
  };
}

export interface MaxCostOptions {
  readonly limitUsd: number;
}

export function maxCostUsd(options: MaxCostOptions): Scorer {
  return ({ output }: ScoreArgs) => {
    const cost = output.usage?.costUsd;
    if (cost === undefined) return score("maxCostUsd", true, "cost unknown (unpriced)");
    const passed = cost <= options.limitUsd;
    return score(
      "maxCostUsd",
      passed,
      `$${cost.toFixed(6)} vs limit $${options.limitUsd.toFixed(6)}`
    );
  };
}

/** Like {@link contains}, but sources the required substrings from the case's `expected`. */
export function containsExpected(options: { readonly mode?: "all" | "any" } = {}): Scorer {
  return ({ evalCase, output }: ScoreArgs) => {
    const needles = expectedStrings(evalCase.expected);
    if (needles.length === 0) return score("contains", false, "case has no expected substrings");
    const haystack = outputText(output).toLowerCase();
    const hits = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    const passed =
      (options.mode ?? "all") === "any" ? hits.length > 0 : hits.length === needles.length;
    return score(
      "contains",
      passed,
      `matched ${hits.length}/${needles.length} substrings`,
      hits.length / needles.length
    );
  };
}

interface ExpectedToolCall {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
}

function readExpectedTool(expected: unknown): ExpectedToolCall | undefined {
  if (typeof expected !== "object" || expected === null) return undefined;
  const record = expected as Record<string, unknown>;
  if (typeof record.tool !== "string") return undefined;
  return {
    tool: record.tool,
    ...(typeof record.args === "object" && record.args !== null
      ? { args: record.args as Record<string, unknown> }
      : {}),
  };
}

/**
 * Like {@link toolCalled}, but sources the expected tool + args from the case's `expected`. When a
 * case declares no expected tool, this asserts restraint: it passes only if the target called no
 * tool at all (e.g. a simple sign-off should not trigger a tool).
 */
export function toolCalledFromExpected(): Scorer {
  return ({ evalCase, output }: ScoreArgs) => {
    const expected = readExpectedTool(evalCase.expected);
    if (expected === undefined) {
      const called = output.toolCalls ?? [];
      const passed = called.length === 0;
      return score(
        "toolCalled",
        passed,
        passed
          ? "no tool called (restraint)"
          : `unexpected tool: ${called.map((c) => c.name).join(", ")}`
      );
    }
    const named = (output.toolCalls ?? []).filter((call) => call.name === expected.tool);
    if (named.length === 0)
      return score("toolCalled", false, `tool "${expected.tool}" was not called`);
    if (expected.args === undefined)
      return score("toolCalled", true, `tool "${expected.tool}" called`);
    const args = expected.args;
    const passed = named.some((call) => argumentsMatch(call.arguments, args));
    return score(
      "toolCalled",
      passed,
      passed ? "tool called with expected arguments" : "tool called with wrong arguments"
    );
  };
}

/** Like {@link notContains}, but sources forbidden substrings from case metadata (default `forbidden`). */
export function notContainsForbidden(options: { readonly metadataKey?: string } = {}): Scorer {
  const key = options.metadataKey ?? "forbidden";
  return ({ evalCase, output }: ScoreArgs) => {
    const raw = evalCase.metadata?.[key];
    const forbidden = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
    if (forbidden.length === 0) return score("notContains", true, "no forbidden list on case");
    const haystack = outputText(output).toLowerCase();
    const leaked = forbidden.filter((s) => haystack.includes(s.toLowerCase()));
    const passed = leaked.length === 0;
    return score(
      "notContains",
      passed,
      passed ? "no forbidden content" : `leaked: ${leaked.join(", ")}`
    );
  };
}

export interface RecallAtKOptions {
  readonly k: number;
}

/**
 * recall@k over a ranked list. Reads the expected page id(s) from `evalCase.expected` and the ranked
 * retrieval from `output.structured` (an array of ids). Passes when an expected id appears in the
 * top k. Generalizes the inline golden-retrieval check in
 * `apps/api/src/knowledge/retrieval-golden.pg.test.ts`.
 */
export function recallAtK(options: RecallAtKOptions): Scorer {
  return ({ evalCase, output }: ScoreArgs) => {
    const expected = expectedStrings(evalCase.expected);
    if (expected.length === 0) return score("recallAtK", false, "case has no expected id(s)");
    const ranked = Array.isArray(output.structured)
      ? output.structured.filter((item): item is string => typeof item === "string")
      : [];
    const topK = ranked.slice(0, options.k);
    const passed = expected.some((id) => topK.includes(id));
    return score(
      "recallAtK",
      passed,
      passed ? `hit within top ${options.k}` : `miss (top ${options.k})`
    );
  };
}
