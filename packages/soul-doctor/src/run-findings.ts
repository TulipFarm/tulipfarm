import { type Finding, finding } from "./finding";

/** The one row shape the Doctor needs from a Run; the query that produces it lives in storage. */
export interface UnhealthyRunRow {
  readonly id: string;
  readonly status: string;
  /** `routine:<code>:<state>` when the executor recorded one. */
  readonly errorEvidenceRef: string | null;
  /** Routine slug when the Run pins one, so a finding names what a person recognises. */
  readonly routineSlug: string | null;
  readonly createdAt: Date;
}

/**
 * Turns the evidence ref the executor recorded into the sentence an operator needs.
 *
 * `input_not_evaluable` is the one that matters most: the Routine reads a field its own earlier
 * State never publishes, which no retry can change, and which the static lint cannot always prove
 * because most States declare no output shape. The Run *is* the detector for that class, which is
 * why a stopped Run is a first-class finding rather than a symptom to be swept up.
 */
const EVIDENCE_DETAIL: Readonly<Record<string, string>> = {
  input_not_evaluable:
    "an input mapping referenced something that does not exist at run time — usually " +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Routine expression is literal text
    "`${states.<Name>.output.<field>}` naming a field the earlier State never published",
  missing_state: "the Routine transitions to a State its own definition does not define",
  unsupported_state: "this deployment hosts no executor for that State type",
  state_cannot_progress: "the State was reached in a status it cannot be run from",
  missing_action_name: "an `action` State does not name the runtime Tool to call",
};

function describe(ref: string | null): { code: string | null; state: string | null; why: string } {
  if (ref === null) return { code: null, state: null, why: "no evidence was recorded" };
  const [, code, state] = ref.split(":");
  const why = (code === undefined ? undefined : EVIDENCE_DETAIL[code]) ?? `\`${ref}\``;
  return { code: code ?? null, state: state ?? null, why };
}

/**
 * A Run the Runtime will never finish on its own.
 *
 * `needs_reconciliation` is the trap: nothing requeues it (`requeueParkedRunRows` acts only on
 * `dispatch:handler_error`, and only once), it carries no `finished_at`, and it emits no further
 * Run events — so to every surface it is indistinguishable from a Run still in flight.
 */
export function runFindings(rows: readonly UnhealthyRunRow[]): readonly Finding[] {
  const seen = new Set<string>();
  const found: Finding[] = [];
  for (const row of rows) {
    const { state, why } = describe(row.errorEvidenceRef);
    const parked = row.status === "needs_reconciliation";
    // The repairable subject is the *Routine*, not the Run: a Routine that reads a field nobody
    // publishes parks every Run it ever starts, and fingerprinting by Run id would turn one
    // authoring bug into an unbounded stream of separate incidents — and one repair proposal per
    // parked Run. Collapsing on the Routine and the State makes the sweep idempotent.
    const subject =
      row.routineSlug === null
        ? { kind: "run", id: row.id }
        : { kind: "routine", id: row.routineSlug };
    const where = row.routineSlug === null ? "A Routine Run" : `Routine \`${row.routineSlug}\``;
    const entry = finding({
      code: parked ? "run_parked" : "run_stalled",
      severity: "broken",
      subject,
      at: state ?? row.status,
      detail: parked
        ? `${where} stopped at \`needs_reconciliation\`${state === null ? "" : ` on State \`${state}\``}` +
          ` because ${why}. Nothing in the Runtime will move it, and it reads as still running.` +
          ` Most recent Run: ${row.id}.`
        : `${where} has held \`${row.status}\` past its lease with no worker on it since ` +
          `${row.createdAt.toISOString()}. Most recent Run: ${row.id}.`,
    });
    if (seen.has(entry.fingerprint)) continue;
    seen.add(entry.fingerprint);
    found.push(entry);
  }
  return found;
}
