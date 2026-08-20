import { FILE_GRANTEE_KINDS } from "@tulipfarm/files";

type FieldType = "string" | "number" | "strings" | "any" | readonly string[];

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
 * The fields each Expectation kind needs, and what each field must look like.
 *
 * Separate from the `Expectation` union because the union is compile-time and a Case arrives as
 * parsed JSON. Checking only `kind` is not enough: `{"kind":"output_matches"}` would compile to an
 * empty regex and pass against anything, and a missing `path` would throw inside the scorer. Both
 * turn an unchecked Case into a green one, which is the failure mode this framework exists to
 * prevent.
 */
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
  soul_published: [["artifact", "string"]],
  generated_file_readable_by: [["grantee", "string"]],
  generated_file_not_readable_by: [["grantee", "string"]],
};

export function isKnownExpectationKind(kind: unknown): kind is string {
  return typeof kind === "string" && kind in EXPECTATION_FIELDS;
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
 * Why this Expectation is malformed, or `undefined` if it is well-formed.
 *
 * Returns the message rather than throwing so the caller can prefix it with the file it came from,
 * which is the only part of the error an author can act on quickly.
 */
export function expectationShapeError(kind: string, record: Record<string, unknown>): string {
  for (const [field, type] of EXPECTATION_FIELDS[kind] ?? []) {
    if (!fieldOk(record[field], type)) {
      return `expectation "${kind}" needs a ${describeField(type)} field "${field}"`;
    }
  }
  // A grantee is written as one string, so a typo produces a grantee nothing ever matches. That is
  // silent for `generated_file_readable_by` — it fails, and someone investigates — but
  // `generated_file_not_readable_by` would pass forever against a spelling no share can hold.
  if (kind === "generated_file_readable_by" || kind === "generated_file_not_readable_by") {
    const grantee = String(record.grantee);
    const [granteeKind, ...rest] = grantee.split(":");
    if (!(FILE_GRANTEE_KINDS as readonly string[]).includes(granteeKind ?? "")) {
      return granteeError(grantee);
    }
    if (rest.join(":").length === 0) return granteeError(grantee);
  }
  return "";
}

function granteeError(grantee: string): string {
  return (
    `"${grantee}" is not a grantee; expected ` +
    `${FILE_GRANTEE_KINDS.map((k) => `"${k}:<id>"`).join(" or ")}`
  );
}
