import type { ModelOutput } from "@tulipfarm/agent-runtime";
import type { Assertion } from "./case.ts";

/** What one Trial produced, reduced to the facts Assertions are allowed to read. */
export interface Observation {
  /** The prompt the real Context assembler produced for this Trial. */
  readonly systemPrompt: string;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
  readonly output: ModelOutput | undefined;
  readonly status: string;
}

export interface AssertionResult {
  readonly assertion: Assertion;
  readonly passed: boolean;
  /** Why it failed, or what satisfied it. Always populated, so a Scorecard never says only "false". */
  readonly detail: string;
}

function readPath(value: unknown, path: string): { found: boolean; value: unknown } {
  // Guards a malformed Assertion that reached the scorer directly: `scoreCase` must be total, and
  // splitting `undefined` here would throw where the contract promises a failed Assertion.
  if (typeof path !== "string" || path.length === 0) return { found: false, value: undefined };
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return { found: false, value: undefined };
    const container = current as Record<string, unknown>;
    if (!(segment in container)) return { found: false, value: undefined };
    current = container[segment];
  }
  return { found: true, value: current };
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ax = a as Record<string, unknown>;
  const bx = b as Record<string, unknown>;
  const ak = Object.keys(ax);
  const bk = Object.keys(bx);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bx && equal(ax[k], bx[k]));
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Text an `output_*` assertion may read; tool-call output is deliberately not stringified. */
function outputText(output: ModelOutput | undefined): string | undefined {
  if (output === undefined) return undefined;
  if (output.kind === "text") return output.text;
  if (output.kind === "structured") return JSON.stringify(output.value);
  return undefined;
}

function evaluate(a: Assertion, obs: Observation): { passed: boolean; detail: string } {
  switch (a.kind) {
    case "prompt_contains":
      return obs.systemPrompt.includes(a.text)
        ? { passed: true, detail: "present in the assembled prompt" }
        : { passed: false, detail: `assembled prompt does not contain ${show(a.text)}` };

    case "prompt_omits":
      return obs.systemPrompt.includes(a.text)
        ? { passed: false, detail: `assembled prompt contains ${show(a.text)} but should not` }
        : { passed: true, detail: "absent from the assembled prompt" };

    case "tool_called":
      return obs.toolCalls.some((c) => c.name === a.name)
        ? { passed: true, detail: `${a.name} was called` }
        : {
            passed: false,
            detail: `${a.name} was never called; called: ${obs.toolCalls.map((c) => c.name).join(", ") || "none"}`,
          };

    case "tool_not_called":
      return obs.toolCalls.some((c) => c.name === a.name)
        ? { passed: false, detail: `${a.name} was called but should not have been` }
        : { passed: true, detail: `${a.name} was not called` };

    case "tool_call_order": {
      let cursor = 0;
      for (const name of a.names) {
        const at = obs.toolCalls.findIndex((c, i) => i >= cursor && c.name === name);
        if (at === -1) {
          return {
            passed: false,
            detail: `${name} did not occur after the preceding named calls; called: ${obs.toolCalls.map((c) => c.name).join(", ") || "none"}`,
          };
        }
        cursor = at + 1;
      }
      return { passed: true, detail: `order held: ${a.names.join(" -> ")}` };
    }

    case "tool_argument_equals": {
      const call = obs.toolCalls.find((c) => c.name === a.name);
      if (call === undefined) return { passed: false, detail: `${a.name} was never called` };
      const read = readPath(call.arguments, a.path);
      if (!read.found) {
        return { passed: false, detail: `${a.name} arguments have no path ${a.path}` };
      }
      return equal(read.value, a.value)
        ? { passed: true, detail: `${a.name}.${a.path} = ${show(a.value)}` }
        : {
            passed: false,
            detail: `${a.name}.${a.path} was ${show(read.value)}, expected ${show(a.value)}`,
          };
    }

    case "tool_call_count":
      return obs.toolCalls.length === a.count
        ? { passed: true, detail: `${a.count} Tool calls` }
        : { passed: false, detail: `${obs.toolCalls.length} Tool calls, expected ${a.count}` };

    case "output_contains": {
      const text = outputText(obs.output);
      if (text === undefined) return { passed: false, detail: "no output text to read" };
      return text.includes(a.text)
        ? { passed: true, detail: "present in output" }
        : { passed: false, detail: `output does not contain ${show(a.text)}` };
    }

    case "output_matches": {
      // An absent pattern would compile to `/(?:)/` and match anything, so it must fail rather
      // than hand back a pass nobody checked.
      if (typeof a.pattern !== "string" || a.pattern.length === 0) {
        return { passed: false, detail: "output_matches has no pattern" };
      }
      const text = outputText(obs.output);
      if (text === undefined) return { passed: false, detail: "no output text to read" };
      let re: RegExp;
      try {
        re = new RegExp(a.pattern);
      } catch {
        return { passed: false, detail: `invalid pattern ${show(a.pattern)}` };
      }
      return re.test(text)
        ? { passed: true, detail: "output matched" }
        : { passed: false, detail: `output did not match ${show(a.pattern)}` };
    }

    case "output_field_equals": {
      if (obs.output === undefined) return { passed: false, detail: "no output to read" };
      if (obs.output.kind !== "structured") {
        return { passed: false, detail: `output is ${obs.output.kind}, not structured` };
      }
      const read = readPath(obs.output.value, a.path);
      if (!read.found) return { passed: false, detail: `output has no path ${a.path}` };
      return equal(read.value, a.value)
        ? { passed: true, detail: `${a.path} = ${show(a.value)}` }
        : { passed: false, detail: `${a.path} was ${show(read.value)}, expected ${show(a.value)}` };
    }

    case "loop_status":
      return obs.status === a.status
        ? { passed: true, detail: `status ${a.status}` }
        : { passed: false, detail: `status was ${obs.status}, expected ${a.status}` };
  }
}

/**
 * Score one Trial's observation against a Case's expectations.
 *
 * Pure and total: every Assertion yields a result, a failure never short-circuits the rest, and a
 * malformed Assertion fails rather than throwing — an eval that crashes tells a maintainer nothing.
 */
export function scoreCase(
  expect: readonly Assertion[],
  observation: Observation
): readonly AssertionResult[] {
  return expect.map((assertion) => ({ assertion, ...evaluate(assertion, observation) }));
}
