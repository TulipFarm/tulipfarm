import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AssembleContext, ModelMessage } from "@tulipfarm/agent-runtime";
import { normalizeMessageContent } from "@tulipfarm/schema";
import { type EvalCase, type Expectation, everyString, isGuardrail, isPersisted } from "./case.ts";
import { type EvalSoul, SOUL_OWNED_CONTEXT_KEYS, soulContext } from "./eval-soul.ts";
import { expandRedTeam, type RedTeamOutcome } from "./red-team.ts";
import { OUTPUT_FLAGS } from "./scorer.ts";
import { CLASS_NAMES, isVulnerabilityClass } from "./vulnerability.ts";

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

export interface Corpus {
  readonly cases: readonly EvalCase[];
  /** sha256 over the canonical form of every Case *and* the Eval Soul. Part of Sweep identity. */
  readonly hash: string;
  /** The Eval Soul every Case in this Corpus is measured against. */
  readonly soul: EvalSoul;
  /** Which Corpus this is, when it is not the default capability one. Names its Baseline folder. */
  readonly suite?: string;
}

/**
 * Context fields the Eval Soul owns, which therefore no Case may set.
 *
 * Without this a Case could quietly restate its Agent's identity and drift from the fixture, and
 * the Sweep would go on passing after the Soul loader stopped supplying it — which is exactly the
 * regression naming an Agent was meant to catch.
 */
const SOUL_OWNED = SOUL_OWNED_CONTEXT_KEYS;

/**
 * Context fields the assembler no longer reads, and what replaced each one.
 *
 * A retired field is worse than an unknown one. Grounding walks the whole Case context, so a fact
 * left in `memory` still counts as given to the model while the assembler silently drops it: the
 * Case reads as grounded, the model never sees the fact, and the Case fails against a real model
 * as what looks like a regression.
 */
const RETIRED_CONTEXT: Record<string, string> = {
  memory: "memoryDocument — a rendered document string, not a list of {key, value} entries",
};

/**
 * Required fields per Expectation kind.
 *
 * Checking only `kind` is not enough: `{"kind":"output_matches"}` would compile to an empty
 * regex and pass against anything, and a missing `path` would throw inside the scorer. Both turn
 * an unchecked Case into a green one, which is the failure mode this framework exists to prevent.
 */
/** The three points a guard can refuse, mirroring `RunEventGuardrailStage`. */
const GUARD_STAGES = ["input", "tool_call", "output"] as const;

/**
 * Every guard `validateGuardrailsConfig` accepts.
 *
 * Spelled out rather than imported because the schema declares them as TypeBox literals with no
 * runtime array to read. A guard added there and not here fails Corpus load with a clear message,
 * which is the safe direction: the alternative is a Case naming a guard that can never fire.
 */
const GUARD_NAMES = ["prompt_injection", "tool_blocklist", "content_filter"] as const;

/**
 * The directory whose Cases may carry `redTeam`, and only whose Cases may.
 *
 * Separation is by directory rather than by convention because the two corpora have separate
 * hashes and separate Baselines: an attack added beside the capability Cases would invalidate the
 * capability Baseline, and a safety regression would have to be found inside the capability grid.
 */
export const RED_TEAM_DIR = "red-team";

const RED_TEAM_OUTCOMES: readonly RedTeamOutcome[] = ["guard_held", "model_resisted"];

/** A required field's type, or the closed set of values it may take. */
type FieldType = "string" | "number" | "strings" | "any" | readonly string[];

const EXPECTATION_FIELDS: Record<string, readonly [string, FieldType][]> = {
  prompt_contains: [["text", "string"]],
  prompt_omits: [["text", "string"]],
  prompt_attaches: [["fileId", "string"]],
  prompt_omits_attachment: [["fileId", "string"]],
  tool_called: [["name", "string"]],
  tool_not_called: [["name", "string"]],
  tool_call_order: [["names", "strings"]],
  tool_argument_equals: [
    ["name", "string"],
    ["path", "string"],
    ["value", "any"],
  ],
  output_contains: [["text", "string"]],
  output_matches: [["pattern", "string"]],
  output_omits: [["text", "string"]],
  output_field_equals: [
    ["path", "string"],
    ["value", "any"],
  ],
  loop_status: [["status", "string"]],
  tool_call_count: [["count", "number"]],
  guardrail_blocked: [
    ["stage", GUARD_STAGES],
    ["guard", GUARD_NAMES],
  ],
  guardrail_allowed: [["stage", GUARD_STAGES]],
  rubric_score: [
    ["criteria", "strings"],
    ["min", "number"],
  ],
  rubric_denies: [["question", "string"]],
  run_status: [["status", "string"]],
  state_status: [["status", "string"]],
  turn_status: [["status", "string"]],
  run_event_emitted: [["eventType", "string"]],
  soul_committed: [["path", "string"]],
};

/**
 * Serialise with object keys sorted at every depth.
 *
 * Key order and whitespace are not semantics, so they must not move the hash — otherwise a
 * formatter run would invalidate every Baseline in the repository.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * Hash is order-independent: Cases are sorted by id first, so file naming cannot move it.
 *
 * The Eval Soul's hash is folded in because the Soul is half of what a Case measures — it supplies
 * the Agent, the business and the catalogue. A fixture edit that left this hash alone would let a
 * Sweep be compared against a Baseline that measured a different Context entirely.
 */
export function corpusHash(
  cases: readonly EvalCase[],
  soulHash: string,
  judgeVersion = "no-judge"
): string {
  const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (
    createHash("sha256")
      .update(canonical(sorted))
      .update("\0soul\0")
      .update(soulHash)
      // Swapping the Judge re-scores every rubric Case, so it must break comparison as loudly as
      // editing a Case does. Left out of the hash, a Judge change would silently rewrite history.
      .update("\0judge\0")
      .update(judgeVersion)
      .digest("hex")
  );
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CorpusError(message);
}

function validate(raw: unknown, file: string): EvalCase {
  require(typeof raw === "object" && raw !== null, `${file}: expected a JSON object`);
  const c = raw as Record<string, unknown>;
  for (const field of ["id", "agent"] as const) {
    require(typeof c[field] === "string" &&
      (c[field] as string).length > 0, `${file}: missing required field "${field}"`);
  }
  require(c.tier === "l2" ||
    c.tier ===
      "l3", `${file}: tier ${JSON.stringify(c.tier)} is not runnable; expected "l2" or "l3"`);
  require(typeof c.context === "object" && c.context !== null, `${file}: missing "context"`);
  require(Array.isArray(c.input) &&
    c.input.length > 0, `${file}: "input" must be a non-empty array`);
  // An empty `expect` would score as a pass — `[].every(...)` is true — and clear the release
  // gate having checked nothing. A Case that expects nothing is an authoring mistake, not a Case.
  require(Array.isArray(c.expect) &&
    c.expect.length >
      0, `${file}: "expect" must be a non-empty array; a Case that expects nothing always passes`);
  for (const a of c.expect as unknown[]) {
    const kind = (a as { kind?: unknown } | null)?.kind;
    require(typeof kind === "string" &&
      kind in EXPECTATION_FIELDS, `${file}: unknown expectation kind ${JSON.stringify(kind)}`);
    const record = a as Record<string, unknown>;
    for (const [field, type] of EXPECTATION_FIELDS[kind as string]) {
      require(fieldOk(
        record[field],
        type
      ), `${file}: expectation "${kind}" needs a ${describeField(type)} field "${field}"`);
    }
    // Caught here rather than at scoring time: an L2 Sweep has no persisted state to read, so
    // this Case could only ever error — and it would do so after the model calls were paid for.
    require(c.tier === "l3" ||
      !isPersisted(a as Expectation), `${file}: expectation "${kind}" reads persisted state, ` +
      `which only tier "l3" observes; this Case is tier ${JSON.stringify(c.tier)}`);
    // The mirror of the rule above. L3 runs the guards but does not collect their decisions, so
    // this would pass by finding nothing — the vacuous pass this framework exists to prevent.
    require(c.tier !== "l3" ||
      !isGuardrail(a as Expectation), `${file}: expectation "${kind}" reads guardrail decisions, ` +
      `which only tier "l2" collects; move this Case to tier "l2"`);
  }
  if (c.journey !== undefined) {
    require(Array.isArray(c.journey) &&
      c.journey.length > 0, `${file}: "journey" must be a non-empty array of further Turns`);
    // A journey needs a database and a Conversation to span, and only L3 has either. On an L2
    // Case the field would be read by nothing and the Case would quietly measure one Turn.
    require(c.tier ===
      "l3", `${file}: "journey" needs tier "l3"; this Case is tier ${JSON.stringify(c.tier)}`);
    for (const turn of c.journey as unknown[]) {
      const t = turn as { input?: unknown };
      require(Array.isArray(t.input) &&
        t.input.length > 0, `${file}: every "journey" Turn needs a non-empty "input"`);
    }
  }
  if (c.fault !== undefined) {
    require(c.fault === "context", `${file}: unknown fault ${JSON.stringify(c.fault)}`);
    // Only the L3 tier builds the dependency a fault breaks. On an L2 Case the field would be read
    // by nothing and the Case would quietly measure an ordinary Turn.
    require(c.tier ===
      "l3", `${file}: "fault" needs tier "l3"; this Case is tier ${JSON.stringify(c.tier)}`);
  }
  if (c.redTeam !== undefined) {
    validateRedTeam(c.redTeam, file);
    const guard = (c.expect as { kind: string }[]).find((e) => e.kind.startsWith("guardrail_"));
    require((c.redTeam as { outcome?: unknown }).outcome !== "model_resisted" ||
      guard ===
        undefined, `${file}: a "model_resisted" Case asserts the model declined, but it also asserts ` +
      `"${guard?.kind}" — a harness defence. A Case may assert one ending or the other, never ` +
      `both, or the guard could stop firing and the Case stay green because the model refused anyway.`);
  }
  validateAttachments(c, file);
  const parsed = raw as EvalCase;
  return {
    ...parsed,
    input: normalizeInput(parsed.input),
    ...(parsed.journey === undefined
      ? {}
      : {
          journey: parsed.journey.map((turn) => ({ ...turn, input: normalizeInput(turn.input) })),
        }),
  };
}

/**
 * Check a Case's Files, and that every attachment Expectation is grounded in one.
 *
 * The rule worth the code is the last one. `prompt_omits_attachment` naming a File no message
 * ever references passes for a reason that has nothing to do with the harness — nothing was there
 * to omit — so it would go on passing after the confinement it claims to test was removed.
 */
function validateAttachments(c: Record<string, unknown>, file: string): void {
  const declared = new Set<string>();
  if (c.attachments !== undefined) {
    require(Array.isArray(c.attachments), `${file}: "attachments" must be an array`);
    for (const raw of c.attachments as unknown[]) {
      require(typeof raw === "object" &&
        raw !== null, `${file}: each attachment must be an object`);
      const a = raw as Record<string, unknown>;
      for (const field of ["fileId", "mediaType", "name"]) {
        require(typeof a[field] === "string" &&
          (a[field] as string).length > 0, `${file}: each attachment needs a non-empty "${field}"`);
      }
      require(a.content === undefined ||
        (typeof a.content === "string" &&
          a.content.length >
            0), `${file}: an attachment's "content" must be a non-empty string when declared`);
      declared.add(a.fileId as string);
    }
  }

  const referenced = new Set<string>();
  for (const message of (c.input ?? []) as ModelMessage[]) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "file") referenced.add(part.fileId);
    }
  }

  for (const id of declared) {
    require(referenced.has(
      id
    ), `${file}: attachment "${id}" is declared but no message references it, so it would ` +
      `never reach the prompt however the harness behaved`);
  }

  // An attack delivered by File has to actually be inside one. Without this a red-team Case can
  // pass because the payload never reached the model at all, which is indistinguishable from the
  // model resisting it and stays green after the defence it claims to test is gone.
  const redTeam = c.redTeam as { payload?: string } | undefined;
  if (redTeam?.payload !== undefined && declared.size > 0) {
    const elsewhere = everyString([c.input, c.toolResults]).some((text) =>
      text.includes(redTeam.payload as string)
    );
    const inAFile = ((c.attachments ?? []) as { content?: string }[]).some((a) =>
      a.content?.includes(redTeam.payload as string)
    );
    require(elsewhere ||
      inAFile, `${file}: the red-team payload appears in no message, Tool result, or attachment ` +
      `"content" — the model would never receive the attack, so the Case would pass by vacuity`);
  }

  for (const a of (c.expect ?? []) as { kind: string; fileId?: string }[]) {
    if (a.kind === "prompt_attaches") {
      require(declared.has(
        a.fileId ?? ""
      ), `${file}: "prompt_attaches" names "${a.fileId}", which the Case does not declare in ` +
        `"attachments" — no harness could make it reach the prompt`);
    }
    if (a.kind === "prompt_omits_attachment") {
      require(referenced.has(
        a.fileId ?? ""
      ), `${file}: "prompt_omits_attachment" names "${a.fileId}", which no message references. ` +
        `Nothing was there to omit, so the Case would pass with the confinement removed.`);
    }
  }
}

/**
 * Accepts a Case that authors `content` as a bare string as well as one that authors parts.
 *
 * Normalising here rather than at use means the red-team generator and the scorer see one shape;
 * a string-only reader downstream would silently no-op on a Case carrying a File.
 */
function normalizeInput(input: readonly ModelMessage[]): readonly ModelMessage[] {
  return input.map((message) => ({
    role: message.role,
    content: normalizeMessageContent(message.content),
  }));
}

/**
 * Check the red-team declaration a Case carries.
 *
 * The rule worth the code is the last one. A Case that asserted both endings would let a harness
 * regression hide behind a model that happened to decline anyway: the guard stops firing, the
 * model still refuses, and the Case stays green while the defence is gone.
 */
function validateRedTeam(raw: unknown, file: string): void {
  require(typeof raw === "object" && raw !== null, `${file}: "redTeam" must be an object`);
  const rt = raw as Record<string, unknown>;
  require(RED_TEAM_OUTCOMES.includes(
    rt.outcome as RedTeamOutcome
  ), `${file}: "redTeam.outcome" must be one of ${RED_TEAM_OUTCOMES.join(", ")}`);
  require(isVulnerabilityClass(
    rt.class
  ), `${file}: "redTeam.class" must be one of ${CLASS_NAMES.join(", ")}; a typo'd class would ` +
    `leave the Case silently uncounted in the safety Scorecard`);
  require(typeof rt.payload === "string" &&
    rt.payload.length >
      0, `${file}: "redTeam.payload" must be the attack text, so a strategy has something to rewrite`);
  require(rt.strategies === undefined ||
    (Array.isArray(rt.strategies) &&
      rt.strategies.every(
        (v) => typeof v === "string"
      )), `${file}: "redTeam.strategies" must be an array of strategy names`);
}

/**
 * Every string the model was actually handed: its Context, the conversation, and any Tool result.
 *
 * Deliberately excludes `script`. The scripted binding's output is the fake model's own words, and
 * an expectation grounded only in those is checking the script against itself.
 */
function givenToModel(c: EvalCase, fromSoul: Partial<AssembleContext>): string {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object")
      for (const v of Object.values(value)) walk(v);
  };
  walk(fromSoul);
  walk(c.context);
  walk(c.input);
  walk(c.toolResults ?? []);
  // A journey's later Turns are handed to the model too, so a fact stated only there is grounded.
  for (const turn of c.journey ?? []) {
    walk(turn.input);
    walk(turn.toolResults ?? []);
  }
  return found.join("\n");
}

/**
 * Refuses a content expectation the model has no way to satisfy except by inventing the answer,
 * and an `output_omits` for text the model was never given.
 *
 * This is the one authoring fault the scripted tier structurally cannot catch: there the fake
 * model is told to emit exactly what the expectation checks, so the Case passes by construction
 * and only reveals itself against a real model — as a failure that reads like a regression.
 *
 * `output_omits` fails the other way and is worse for it. Text absent from the Context can never
 * appear in the answer, so the expectation passes whatever the harness does — a guardrail Case
 * that would go on passing after the guard was deleted.
 *
 * Ungrounded expectations are legitimate — refusal wording and output format are not recalled from
 * the Context — so this bans the *silent* ones, not the deliberate ones. Stating a reason is the
 * whole point: an author who cannot write one has found their own bug.
 */
function requireGrounded(c: EvalCase, file: string, fromSoul: Partial<AssembleContext>): void {
  const given = givenToModel(c, fromSoul);
  for (const e of c.expect) {
    if (e.kind !== "output_contains" && e.kind !== "output_matches" && e.kind !== "output_omits")
      continue;
    if (typeof e.ungrounded === "string" && e.ungrounded.length > 0) continue;
    const needle = e.kind === "output_matches" ? e.pattern : e.text;
    let grounded: boolean;
    // Matched exactly as the scorer will match it, or a Case could be refused as ungrounded and
    // then pass, or be admitted and then fail.
    if (e.kind === "output_matches") {
      try {
        grounded = new RegExp(needle, OUTPUT_FLAGS).test(given);
      } catch {
        // An uncompilable pattern is the scorer's failure to report, not this check's.
        continue;
      }
    } else grounded = given.toLowerCase().includes(needle.toLowerCase());

    const why =
      e.kind === "output_omits"
        ? `the model is never given it, so it could not have emitted it and this expectation ` +
          `passes even with the guard removed. Put the text in a Tool result or the Context so ` +
          `the guard has something to catch, or set "ungrounded" to the reason this is about ` +
          `invention rather than leakage.`
        : `a real model could only produce it by guessing. Put the fact where the model is ` +
          `given it, or set "ungrounded" to the reason this is about wording or format rather ` +
          `than recall.`;
    require(grounded, `${file}: expectation "${e.kind}" looks for ${JSON.stringify(needle)}, which appears nowhere ` +
      `in the Eval Soul, the Case's context, input or tool results — ${why}`);
  }
}

/** How a rejected field is described back to the author. */
function describeField(type: FieldType): string {
  if (typeof type !== "string") return `one of ${type.map((v) => JSON.stringify(v)).join(", ")}`;
  return type === "strings" ? "non-empty string array" : type;
}

function fieldOk(value: unknown, type: FieldType): boolean {
  if (typeof type !== "string") return typeof value === "string" && type.includes(value);
  switch (type) {
    case "string":
      return typeof value === "string" && value.length > 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "strings":
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
    // `value` in an equality expectation may legitimately be null, false or 0; only absence is wrong.
    case "any":
      return value !== undefined;
  }
}

/**
 * Read every `*.json` Eval Case in a directory.
 *
 * Throws rather than skipping on any malformed Case: a Corpus that quietly drops a Case reports a
 * pass rate over a smaller denominator than the maintainer believes they are reading.
 */
export async function loadCorpus(
  dir: string,
  soul: EvalSoul,
  judgeVersion?: string
): Promise<Corpus> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch (cause) {
    throw new CorpusError(`cannot read corpus directory ${dir}: ${String(cause)}`);
  }

  const cases: EvalCase[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (cause) {
      throw new CorpusError(`${name}: invalid JSON — ${(cause as Error).message}`);
    }
    const evalCase = validate(parsed, name);
    for (const [field, replacement] of Object.entries(RETIRED_CONTEXT)) {
      require((evalCase.context as unknown as Record<string, unknown>)[field] ===
        undefined, `${name}: "context.${field}" is retired and the assembler ignores it. Use ${replacement}.`);
    }
    for (const field of SOUL_OWNED) {
      require((evalCase.context as unknown as Record<string, unknown>)[field] ===
        undefined, `${name}: "context.${field}" is the Eval Soul's to set, not the Case's. Name the Agent ` +
        `with "agent" and edit apps/eval/soul instead.`);
    }
    let fromSoul: Partial<AssembleContext>;
    try {
      fromSoul = soulContext(soul, evalCase.agent);
    } catch (cause) {
      throw new CorpusError(`${name}: ${(cause as Error).message}`);
    }
    requireGrounded(evalCase, name, fromSoul);
    const previous = seen.get(evalCase.id);
    if (previous !== undefined) {
      throw new CorpusError(`duplicate Case id "${evalCase.id}" in ${previous} and ${name}`);
    }
    const isRedTeamDir = path.basename(dir) === RED_TEAM_DIR;
    require(evalCase.redTeam === undefined ||
      isRedTeamDir, `${name}: only Cases in corpus/${RED_TEAM_DIR}/ may declare "redTeam"; an attack here would ` +
      `invalidate the capability Baseline every time one was added.`);
    require(evalCase.redTeam !== undefined ||
      !isRedTeamDir, `${name}: every Case in corpus/${RED_TEAM_DIR}/ must declare "redTeam", so it is explicit ` +
      `whether it gates the release or is reported as a resistance rate.`);
    seen.set(evalCase.id, name);
    // Expanded after the seed is validated and grounded, so a fault is reported against the file
    // the author wrote rather than against a derived id that exists in no file.
    for (const derived of expandRedTeam(evalCase, name)) {
      const clash = seen.get(derived.id);
      if (clash !== undefined && derived.id !== evalCase.id) {
        throw new CorpusError(`derived Case id "${derived.id}" collides with ${clash}`);
      }
      seen.set(derived.id, name);
      cases.push(derived);
    }
  }

  if (cases.length === 0) throw new CorpusError(`no Eval Cases found in ${dir}`);
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const suite = path.basename(dir) === RED_TEAM_DIR ? RED_TEAM_DIR : undefined;
  return {
    cases,
    hash: corpusHash(cases, soul.hash, judgeVersion),
    soul,
    ...(suite === undefined ? {} : { suite }),
  };
}
