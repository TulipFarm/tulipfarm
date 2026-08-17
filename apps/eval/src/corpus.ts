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
 * Required fields per Assertion kind.
 *
 * Checking only `kind` is not enough: `{"kind":"output_matches"}` would compile to an empty
 * regex and pass against anything, and a missing `path` would throw inside the scorer. Both turn
 * an unchecked Case into a green one, which is the failure mode this framework exists to prevent.
 */
const ASSERTION_FIELDS: Record<
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
  // gate having checked nothing. A Case that asserts nothing is an authoring mistake, not a Case.
  require(Array.isArray(c.expect) &&
    c.expect.length >
      0, `${file}: "expect" must be a non-empty array; a Case that asserts nothing always passes`);
  for (const a of c.expect as unknown[]) {
    const kind = (a as { kind?: unknown } | null)?.kind;
    require(typeof kind === "string" &&
      kind in ASSERTION_FIELDS, `${file}: unknown assertion kind ${JSON.stringify(kind)}`);
    const record = a as Record<string, unknown>;
    for (const [field, type] of ASSERTION_FIELDS[kind as string]) {
      require(fieldOk(
        record[field],
        type
      ), `${file}: assertion "${kind}" needs a ${type === "strings" ? "non-empty string array" : type} field "${field}"`);
    }
  }
  return raw as EvalCase;
}

function fieldOk(value: unknown, type: "string" | "number" | "strings" | "any"): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" && value.length > 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "strings":
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
    // `value` in an equality assertion may legitimately be null, false or 0; only absence is wrong.
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
