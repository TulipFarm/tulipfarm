import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvalCase } from "./case.ts";

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

export interface Corpus {
  readonly cases: readonly EvalCase[];
  /** sha256 over the canonical form of every Case. Part of Sweep identity. */
  readonly hash: string;
}

/**
 * Required fields per Expectation kind.
 *
 * Checking only `kind` is not enough: `{"kind":"output_matches"}` would compile to an empty
 * regex and pass against anything, and a missing `path` would throw inside the scorer. Both turn
 * an unchecked Case into a green one, which is the failure mode this framework exists to prevent.
 */
const EXPECTATION_FIELDS: Record<
  string,
  readonly [string, "string" | "number" | "strings" | "any"][]
> = {
  prompt_contains: [["text", "string"]],
  prompt_omits: [["text", "string"]],
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
  output_field_equals: [
    ["path", "string"],
    ["value", "any"],
  ],
  loop_status: [["status", "string"]],
  tool_call_count: [["count", "number"]],
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

/** Hash is order-independent: Cases are sorted by id first, so file naming cannot move it. */
export function corpusHash(cases: readonly EvalCase[]): string {
  const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(canonical(sorted)).digest("hex");
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
  require(c.tier ===
    "l2", `${file}: tier ${JSON.stringify(c.tier)} is not runnable; expected "l2"`);
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
      ), `${file}: expectation "${kind}" needs a ${type === "strings" ? "non-empty string array" : type} field "${field}"`);
    }
  }
  const evalCase = raw as EvalCase;
  requireGrounded(evalCase, file);
  return evalCase;
}

/**
 * Every string the model was actually handed: its Context, the conversation, and any Tool result.
 *
 * Deliberately excludes `script`. The scripted binding's output is the fake model's own words, and
 * an expectation grounded only in those is checking the script against itself.
 */
function givenToModel(c: EvalCase): string {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object")
      for (const v of Object.values(value)) walk(v);
  };
  walk(c.context);
  walk(c.input);
  walk(c.toolResults ?? []);
  return found.join("\n");
}

/**
 * Refuses a content expectation the model has no way to satisfy except by inventing the answer.
 *
 * This is the one authoring fault the scripted tier structurally cannot catch: there the fake
 * model is told to emit exactly what the expectation checks, so the Case passes by construction
 * and only reveals itself against a real model — as a failure that reads like a regression.
 *
 * Ungrounded expectations are legitimate — refusal wording and output format are not recalled from
 * the Context — so this bans the *silent* ones, not the deliberate ones. Stating a reason is the
 * whole point: an author who cannot write one has found their own bug.
 */
function requireGrounded(c: EvalCase, file: string): void {
  const given = givenToModel(c);
  for (const e of c.expect) {
    if (e.kind !== "output_contains" && e.kind !== "output_matches") continue;
    if (typeof e.ungrounded === "string" && e.ungrounded.length > 0) continue;
    const needle = e.kind === "output_contains" ? e.text : e.pattern;
    let grounded: boolean;
    if (e.kind === "output_contains") grounded = given.includes(needle);
    else {
      try {
        grounded = new RegExp(needle).test(given);
      } catch {
        // An uncompilable pattern is the scorer's failure to report, not this check's.
        continue;
      }
    }
    require(grounded, `${file}: expectation "${e.kind}" looks for ${JSON.stringify(needle)}, which appears nowhere ` +
      `in the Case's context, input or tool results — a real model could only produce it by ` +
      `guessing. Put the fact where the model is given it, or set "ungrounded" to the reason ` +
      `this is about wording or format rather than recall.`);
  }
}

function fieldOk(value: unknown, type: "string" | "number" | "strings" | "any"): boolean {
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
export async function loadCorpus(dir: string): Promise<Corpus> {
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
    const previous = seen.get(evalCase.id);
    if (previous !== undefined) {
      throw new CorpusError(`duplicate Case id "${evalCase.id}" in ${previous} and ${name}`);
    }
    seen.set(evalCase.id, name);
    cases.push(evalCase);
  }

  if (cases.length === 0) throw new CorpusError(`no Eval Cases found in ${dir}`);
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, hash: corpusHash(cases) };
}
