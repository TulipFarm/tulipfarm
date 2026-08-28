import type { ModelOutput } from "@tulipfarm/agent-runtime";
import { type Expectation, isJudged } from "./case.ts";
import type { GuardrailDecision } from "./guardrails.ts";

/** What one Trial produced, reduced to the facts Expectations are allowed to read. */
export interface Observation {
  /** The prompt the real Context assembler produced for this Trial. */
  readonly systemPrompt: string;
  /**
   * The Files whose bytes reached the model, as the prompt splitter reported emitting them.
   *
   * Absent rather than empty on a tier that does not collect it, so an attachment Expectation
   * fails with a reason instead of quietly reading nothing and calling that an omission.
   */
  readonly attachedFileIds?: readonly string[];
  readonly toolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
  /**
   * How many Tool calls each assistant message asked for, in the order the model produced them.
   *
   * Messages that asked for none are left out — this counts batches, not responses. Absent rather
   * than empty on a tier that does not collect it, so a batching Expectation fails with a reason
   * instead of reading no batches and reporting that as a failure to batch.
   */
  readonly toolCallBatches?: readonly number[];
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
  /** Artifacts the active Soul publication serves, written `Kind:slug`. */
  readonly publishedArtifacts: readonly string[];
  /** Files the Turn generated, each with the audience the product actually gave it. */
  readonly generatedFiles: readonly {
    readonly filename: string;
    readonly readableBy: readonly string[];
  }[];
  readonly curatorTasks?: readonly { readonly title: string }[];
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

    case "soul_published": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      return persisted.publishedArtifacts.includes(a.artifact)
        ? { passed: true, detail: `${a.artifact} is in the active Soul publication` }
        : {
            passed: false,
            detail: `${a.artifact} is not published; the active bundle serves ${
              persisted.publishedArtifacts.length === 0
                ? "nothing"
                : persisted.publishedArtifacts.join(", ")
            }`,
          };
    }

    case "generated_file_readable_by":
    case "generated_file_not_readable_by": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      const files = persisted.generatedFiles;
      if (files.length === 0) {
        return { passed: false, detail: "the Turn generated no File" };
      }
      // Every generated File, not the last one: a Turn that wrote two documents must not be able
      // to satisfy an audience Expectation with whichever one happened to come second.
      const want = a.kind === "generated_file_readable_by";
      const wrong = files.filter((file) => file.readableBy.includes(a.grantee) !== want);
      if (wrong.length === 0) {
        return {
          passed: true,
          detail: `${a.grantee} ${want ? "may" : "may not"} read every File the Turn generated`,
        };
      }
      return {
        passed: false,
        detail: `${a.grantee} ${want ? "may not" : "may"} read ${wrong
          .map(
            (file) =>
              `${file.filename} (readable by ${
                file.readableBy.length === 0 ? "nobody" : file.readableBy.join(", ")
              })`
          )
          .join("; ")}`,
      };
    }

    case "curator_task_visible": {
      const persisted = obs.persisted;
      if (persisted === undefined) return notPersisted(a.kind);
      return (persisted.curatorTasks ?? []).some((task) => task.title === a.title)
        ? { passed: true, detail: `Curator delivered Task "${a.title}"` }
        : { passed: false, detail: `no Curator Task titled "${a.title}"` };
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

    case "prompt_attaches":
    case "prompt_omits_attachment": {
      if (obs.attachedFileIds === undefined) {
        return { passed: false, detail: "this tier does not observe what the prompt attached" };
      }
      const present = obs.attachedFileIds.includes(a.fileId);
      const want = a.kind === "prompt_attaches";
      if (present === want) {
        return {
          passed: true,
          detail: want ? "the prompt carried its bytes" : "no bytes were sent",
        };
      }
      return {
        passed: false,
        detail: want
          ? `the prompt carried no bytes for ${show(a.fileId)}; it sent ${
              obs.attachedFileIds.length === 0 ? "none" : obs.attachedFileIds.join(", ")
            }`
          : `the prompt carried bytes for ${show(a.fileId)} but should not have`,
      };
    }

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
      const named = obs.toolCalls.filter((c) => c.name === a.name);
      if (named.length === 0) return { passed: false, detail: `${a.name} was never called` };
      // Any call, not the first: one Tool name can serve several call sites — `skill` loads a
      // Skill with `{ name }` and reads one of its files with `{ name, reference }` — so pinning
      // the first call would assert against whichever mode the model happened to reach for first.
      const reads = named.map((c) => readPath(c.arguments, a.path)).filter((r) => r.found);
      if (reads.length === 0) {
        return { passed: false, detail: `${a.name} arguments have no path ${a.path}` };
      }
      const hit = reads.find((r) => equal(r.value, a.value));
      return hit !== undefined
        ? { passed: true, detail: `${a.name}.${a.path} = ${show(a.value)}` }
        : {
            passed: false,
            detail: `${a.name}.${a.path} was ${reads.map((r) => show(r.value)).join(", ")}, expected ${show(a.value)}`,
          };
    }

    case "tool_argument_present": {
      const named = obs.toolCalls.filter((c) => c.name === a.name);
      if (named.length === 0) return { passed: false, detail: `${a.name} was never called` };
      const read = named.map((c) => readPath(c.arguments, a.path)).find((r) => r.found);
      return read !== undefined
        ? { passed: true, detail: `${a.name}.${a.path} = ${show(read.value)}` }
        : { passed: false, detail: `${a.name} was called without ${a.path}` };
    }

    case "tool_argument_absent": {
      const named = obs.toolCalls.filter((c) => c.name === a.name);
      if (named.length === 0) return { passed: false, detail: `${a.name} was never called` };
      // Every call, not any call: an argument the Tool no longer declares is one the model must
      // never send, so a single call carrying it is the regression this asserts against.
      const carried = named.map((c) => readPath(c.arguments, a.path)).filter((r) => r.found);
      return carried.length === 0
        ? { passed: true, detail: `${a.name} carried no ${a.path}` }
        : {
            passed: false,
            detail: `${a.name}.${a.path} was ${carried.map((r) => show(r.value)).join(", ")}, expected absent`,
          };
    }

    case "tool_call_count":
      return obs.toolCalls.length === a.count
        ? { passed: true, detail: `${a.count} Tool calls` }
        : {
            passed: false,
            detail: `${obs.toolCalls.length} Tool calls, expected ${a.count} — called ${calls(obs.toolCalls)}`,
          };

    case "tool_calls_batched": {
      if (obs.toolCallBatches === undefined) {
        return { passed: false, detail: "this tier does not observe how Tool calls were grouped" };
      }
      const largest = obs.toolCallBatches.reduce((most, size) => Math.max(most, size), 0);
      if (largest >= a.min) return { passed: true, detail: `${largest} Tool calls in one message` };
      const asked =
        obs.toolCallBatches.length === 0
          ? "no message asked for a Tool"
          : `messages asked for ${obs.toolCallBatches.join(", then ")}`;
      return {
        passed: false,
        detail: `largest batch was ${largest}, expected at least ${a.min}; ${asked}`,
      };
    }

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
const SEAM_TOOL: Readonly<Record<string, string>> = {
  soul_committed: "soul_write",
  // Same seam: nothing can be published that the model never asked to be written.
  soul_published: "soul_write",
  // Same shape: there is no audience to read until the model has actually written a document.
  generated_file_readable_by: "file_create",
  generated_file_not_readable_by: "file_create",
};

/**
 * Expectations that owe the seam nothing, so their failure is the harness's either way.
 *
 * The Turn must complete, the Run must reach its status and a guard must reach its verdict whether
 * or not the model volunteered a Tool. Holding those out with the rest would let an unreached seam
 * launder a genuine lifecycle failure into `unexercised`, and on a Matrix where another leg passed
 * the Case it would vanish from the release gate entirely.
 */
const SEAM_INDEPENDENT: ReadonlySet<string> = new Set([
  "run_status",
  "turn_status",
  "state_status",
  "loop_status",
  "run_event_emitted",
  "guardrail_blocked",
  "guardrail_allowed",
  "tool_not_called",
]);

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
  scored: readonly ExpectationResult[],
  toolCalls: readonly { readonly name: string }[]
): string | undefined {
  const failed = scored.filter((e) => !e.passed);
  if (failed.length === 0) return undefined;
  if (failed.some((e) => SEAM_INDEPENDENT.has(e.expectation.kind))) return undefined;
  for (const e of scored) {
    const tool = SEAM_TOOL[e.expectation.kind];
    if (tool !== undefined && !toolCalls.some((c) => c.name === tool)) return tool;
  }
  return undefined;
}
