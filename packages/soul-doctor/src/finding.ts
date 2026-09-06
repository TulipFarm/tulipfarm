import { canonicalHash } from "@tulipfarm/schema";

/**
 * What the Doctor found wrong. Every code is either provable from the artifact alone or observed
 * on a Run that already stopped — nothing here is a model's opinion.
 */
export type FindingCode =
  /** `compileRoutine` refused the published document. Carries the compiler's own code. */
  | "routine_uncompilable"
  | "routine_schema_invalid"
  /** An expression reads a field the referenced State's declared `output` schema forbids. */
  | "undeclared_output_field"
  /** An `action` State does not name the Tool it dispatches, so no executor can run it. */
  | "missing_action_name"
  /** The Runtime serves an older commit than the soul repo's HEAD: publication is not keeping up. */
  | "bundle_stale"
  /** A Run sits at `needs_reconciliation`; nothing in the runtime will ever move it. */
  | "run_parked"
  /** A Run holds `queued` or `running` past its lease with no worker on it. */
  | "run_stalled";

/**
 * `broken` is provable: the artifact cannot work as published, or the Run has already stopped.
 * `suspect` needs a human or a repair Run to confirm. Only `broken` is ever auto-repaired.
 */
export type FindingSeverity = "broken" | "suspect";

export interface FindingSubject {
  /** `routine`, `agent`, `skill`, `integration`, or `run`. */
  readonly kind: string;
  /** Slug for an artifact, run id for a Run. */
  readonly id: string;
  /** Content hash of the artifact the finding was proved against; absent for a Run. */
  readonly digest?: string;
}

export interface Finding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  readonly subject: FindingSubject;
  /**
   * Where inside the subject. A State name, a JSON pointer, or the expression that broke — never
   * an evaluated value, so a finding is safe to log and safe to hand to a repair Run.
   */
  readonly at: string;
  /** One sentence an operator can act on. Payload-safe by the same rule as `at`. */
  readonly detail: string;
  /**
   * Stable across sweeps for the same defect in the same version of the same subject, and
   * different once the subject changes. It is what stops a five-minute sweep from proposing the
   * same repair twelve times an hour, and what proves a repair did not take.
   */
  readonly fingerprint: string;
}

/**
 * The artifact digest is deliberately part of the fingerprint: a repair that republishes the
 * artifact changes the digest, so the same defect surviving the repair is a *new* fingerprint and
 * is visibly not the one already attempted. A Run has no digest, so its own id supplies identity.
 */
export function fingerprint(code: FindingCode, subject: FindingSubject, at: string): string {
  return canonicalHash({
    code,
    kind: subject.kind,
    id: subject.id,
    digest: subject.digest ?? null,
    at,
  });
}

export function finding(input: Omit<Finding, "fingerprint">): Finding {
  return Object.freeze({
    ...input,
    fingerprint: fingerprint(input.code, input.subject, input.at),
  });
}
