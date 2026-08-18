import type { ModelOutput } from "@tulipfarm/agent-runtime";
import { type Expectation, isJudged } from "./case.ts";
import type { GuardrailDecision } from "./guardrails.ts";

/** What one Trial produced, reduced to the facts Expectations are allowed to read. */
export interface Observation {
  /** The prompt the real Context assembler produced for this Trial. */
  readonly systemPrompt: string;
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
  readonly output: ModelOutput | undefined;
  readonly status: string;
  /** Guard refusals in the order they fired. Empty means the policy let the whole turn through. */
  readonly guardrails: readonly GuardrailDecision[];
  /**
   * What the Turn persisted. Present only on an L3 Trial.
   *
   * Absent rather than empty on L2, so a persisted-state Expectation on an L2 Case fails with a
   * reason instead of quietly reading zeroes and passing.
   */
  readonly persisted?: PersistedState;
}

/** The durable half of a Turn, as the L3 tier read it back out of the database. */
export interface PersistedState {
  readonly runStatus: string;
  readonly stateStatus: string;
  readonly turnStatus: string | null;
  readonly events: readonly string[];
  readonly soulCommits: readonly { readonly message: string; readonly paths: readonly string[] }[];
}

export interface ExpectationResult {
  readonly expectation: Expectation;
  readonly passed: boolean;
  /** Why it failed, or what satisfied it. Always populated, so a Scorecard never says only "false". */
  readonly detail: string;
}

function readPath(value: unknown, path: string): { found: boolean; value: unknown } {
  // Guards a malformed Expectation that reached the scorer directly: `scoreCase` must be total, and
  // splitting `undefined` here would throw where the contract promises a failed Expectation.
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

/**
 * Every call with its arguments, in order.
 *
 * A count on its own cannot be acted on. "2 Tool calls, expected 1" leaves the reader unable to
 * tell a model that called one Tool twice with identical arguments — which would point at the
 * harness re-dispatching — from one that split the work across two different calls, which is the
 * vendor's own strategy and no concern of ours. Recovering that costs another Sweep otherwise.
 */
function calls(made: readonly { readonly name: string; readonly arguments: unknown }[]): string {
  if (made.length === 0) return "none";
  return made.map((c) => `${c.name}(${excerpt(show(c.arguments))})`).join(" then ");
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Text an `output_*` expectation may read; tool-call output is deliberately not stringified. */
function outputText(output: ModelOutput | undefined): string | undefined {
  if (output === undefined) return undefined;
  if (output.kind === "text") return output.text;
  if (output.kind === "structured") return JSON.stringify(output.value);
  return undefined;
}

/**
 * The structured value an `output_field_equals` may read.
 *
 * A vendor that supports a structured response returns one; the CLI subscription seats this
 * framework runs on return JSON as ordinary text. Every candidate is tried rather than the first
 * one that looks plausible: a model that plans inside a fence before answering, prefaces the
 * object with a sentence, or trails commentary after it has still returned the structure the Case
 * asked for, and failing those would measure a model's prose habits rather than the harness.
 */
function structuredValue(output: ModelOutput | undefined): { found: boolean; value?: unknown } {
  if (output === undefined) return { found: false };
  if (output.kind === "structured") return { found: true, value: output.value };
  if (output.kind !== "text") return { found: false };

  for (const candidate of jsonCandidates(output.text)) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === "object" && value !== null) return { found: true, value };
    } catch {
      // Try the next candidate; a fence holding prose is not a failure to report.
    }
  }
  return { found: false };
}

/** Substrings that might be the JSON, widest net first-match-wins order. */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)) {
    const body = match[1]?.trim();
    if (body !== undefined && body.length > 0) candidates.push(body);
  }
  candidates.push(text.trim());
  const braced = balanced(text);
  if (braced !== undefined) candidates.push(braced);
  return candidates;
}

/** The first brace- or bracket-balanced span, so preamble and trailing prose fall away. */
function balanced(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const close = text[start] === "{" ? "}" : "]";
  const open = text[start] as string;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Reports a persisted-state Expectation on a Trial that never persisted anything.
 *
 * A missing observation is the tier being wrong, not the product misbehaving, so it fails loudly
 * with the reason. Passing it would let an L3 Expectation ride silently on an L2 Case and report
 * coverage of a lifecycle nothing exercised.
 */
function notPersisted(kind: string): { passed: boolean; detail: string } {
  return { passed: false, detail: `${kind} reads persisted state, which only an L3 Case has` };
}

function evaluate(a: Expectation, obs: Observation): { passed: boolean; detail: string } {
  switch (a.kind) {
    case "run_status":
    case "state_status":
    case "turn_status": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      const actual =
        a.kind === "run_status"
          ? persisted.runStatus
          : a.kind === "state_status"
            ? persisted.stateStatus
            : (persisted.turnStatus ?? "not completed");
      return actual === a.status
        ? { passed: true, detail: `${a.kind} is ${actual}` }
        : { passed: false, detail: `${a.kind} is ${actual}, expected ${a.status}` };
    }

    case "run_event_emitted": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      return persisted.events.includes(a.eventType)
        ? { passed: true, detail: `${a.eventType} was appended` }
        : {
            passed: false,
            detail: `no ${a.eventType} Run event; the Turn appended ${
              persisted.events.length === 0 ? "none" : persisted.events.join(", ")
            }`,
          };
    }

    case "soul_committed": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      return persisted.soulCommits.some((commit) => commit.paths.includes(a.path))
        ? { passed: true, detail: `${a.path} was committed to the Eval Soul` }
        : {
            passed: false,
            detail: `no Soul commit touched ${a.path}; ${
              persisted.soulCommits.length === 0
                ? "the Turn committed nothing"
                : `it committed ${persisted.soulCommits.flatMap((c) => c.paths).join(", ")}`
            }`,
          };
    }

    // Answered by a Judge in `scoreJudged`, not here. Reaching this arm means a judged Expectation
    // was routed through the deterministic scorer, which would score prose with `===`.
    case "rubric_score":
    case "rubric_denies":
      throw new Error(`expectation "${a.kind}" is judged, not scored deterministically`);
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
        : {
            passed: false,
            detail: `${obs.toolCalls.length} Tool calls, expected ${a.count} — called ${calls(obs.toolCalls)}`,
          };

    case "output_contains": {
      const text = outputText(obs.output);
      if (text === undefined) return { passed: false, detail: "no output text to read" };
      return text.toLowerCase().includes(a.text.toLowerCase())
        ? { passed: true, detail: "present in output" }
        : {
            passed: false,
            detail: `output does not contain ${show(a.text)} — said ${excerpt(text)}`,
          };
    }

    case "output_omits": {
      const text = outputText(obs.output);
      // No text is not evidence the string was removed: a Case asserting a guard scrubbed the
      // answer must not pass on a turn that produced no answer at all.
      if (text === undefined) return { passed: false, detail: "no output text to read" };
      return text.toLowerCase().includes(a.text.toLowerCase())
        ? { passed: false, detail: `output still contains ${show(a.text)} — said ${excerpt(text)}` }
        : { passed: true, detail: `absent from output` };
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
        re = new RegExp(a.pattern, OUTPUT_FLAGS);
      } catch {
        return { passed: false, detail: `invalid pattern ${show(a.pattern)}` };
      }
      return re.test(text)
        ? { passed: true, detail: "output matched" }
        : {
            passed: false,
            detail: `output did not match ${show(a.pattern)} — said ${excerpt(text)}`,
          };
    }

    case "output_field_equals": {
      if (obs.output === undefined) return { passed: false, detail: "no output to read" };
      const structured = structuredValue(obs.output);
      if (!structured.found) {
        const said = outputText(obs.output);
        return {
          passed: false,
          detail: `output is not structured data${said === undefined ? "" : ` — said ${excerpt(said)}`}`,
        };
      }
      const read = readPath(structured.value, a.path);
      if (!read.found) return { passed: false, detail: `output has no path ${a.path}` };
      return equal(read.value, a.value)
        ? { passed: true, detail: `${a.path} = ${show(a.value)}` }
        : { passed: false, detail: `${a.path} was ${show(read.value)}, expected ${show(a.value)}` };
    }

    case "loop_status":
      return obs.status === a.status
        ? { passed: true, detail: `status ${a.status}` }
        : { passed: false, detail: `status was ${obs.status}, expected ${a.status}` };

    case "guardrail_blocked": {
      const hit = obs.guardrails.find((d) => d.stage === a.stage && d.guard === a.guard);
      return hit === undefined
        ? { passed: false, detail: `no ${a.guard} refusal at ${a.stage}; ${firedAt(obs)}` }
        : { passed: true, detail: `${a.guard} refused at ${a.stage}: ${hit.reason}` };
    }

    case "guardrail_allowed": {
      const hit = obs.guardrails.find((d) => d.stage === a.stage);
      return hit === undefined
        ? { passed: true, detail: `no guard refused at ${a.stage}` }
        : { passed: false, detail: `${hit.guard} refused at ${a.stage}: ${hit.reason}` };
    }
  }
}

/** What did fire, so a missed refusal reads as evidence rather than a bare "not found". */
function firedAt(obs: Observation): string {
  if (obs.guardrails.length === 0) return "no guard refused anywhere in the turn";
  return `guards that did refuse: ${obs.guardrails.map((d) => `${d.stage}/${d.guard}`).join(", ")}`;
}

/**
 * Score one Trial's observation against a Case's expectations.
 *
 * Pure and total: every Expectation yields a result, a failure never short-circuits the rest, and a
 * malformed Expectation fails rather than throwing — an eval that crashes tells a maintainer nothing.
 */
/**
 * Case-insensitive, because we control the prompt but the model controls its own prose.
 *
 * A Case that fails because one vendor wrote "9 AM" where another wrote "9am" is measuring
 * capitalisation, not the harness — and nobody authoring an Expectation means "and in lower case".
 * The `prompt_*` Expectations stay exact: that string is one this repo assembled.
 */
export const OUTPUT_FLAGS = "i";

const EXCERPT_LIMIT = 240;

/**
 * What the model actually said, for a failure detail.
 *
 * Without it a failing content Expectation cannot be acted on at all: the reader knows the answer
 * was wrong but not how, and has to re-run the vendor to find out. Whitespace is collapsed so a
 * multi-line answer cannot break the Scorecard's layout.
 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "<empty>";
  return flat.length > EXCERPT_LIMIT ? `${show(flat.slice(0, EXCERPT_LIMIT))}…` : show(flat);
}

export function scoreCase(
  expect: readonly Expectation[],
  observation: Observation
): readonly ExpectationResult[] {
  return expect
    .filter((expectation) => !isJudged(expectation))
    .map((expectation) => ({ expectation, ...evaluate(expectation, observation) }));
}

/**
 * Expectations that can only be measured once a Tool call has opened the seam they assert about,
 * and the Tool that opens it. `soul_committed` asks whether a write survived; nothing was written
 * to survive unless the model called `soul_write`.
 */
const SEAM_TOOL: Readonly<Record<string, string>> = { soul_committed: "soul_write" };

/**
 * The Tool a Case needed the model to call before any of its Expectations could mean anything.
 *
 * A capability Case that reaches its seam through a Tool inherits the model's willingness to call
 * that Tool. When the model answers in prose instead, every downstream assertion fails for a reason
 * that has nothing to do with the harness — the same confound `guardUnexercised` removes on the
 * red-team side.
 *
 * The reason it is safe to hold out here, where a blanket "the model declined" excuse would not be,
 * is that the precondition is *observable*: "the Tool was never called" and "the Tool was called and
 * the harness lost the write" are different facts, and this only reports the first. Once the call
 * has happened this returns nothing, so a genuinely broken commit path fails as loudly as ever.
 */
export function seamUnreached(
  expect: readonly Expectation[],
  toolCalls: readonly { readonly name: string }[]
): string | undefined {
  for (const a of expect) {
    const tool = SEAM_TOOL[a.kind];
    if (tool !== undefined && !toolCalls.some((c) => c.name === tool)) return tool;
  }
  return undefined;
}
