/**
 * The Soul Doctor's ledger.
 *
 * One row per distinct defect, keyed by the Doctor's fingerprint. It exists to make a five-minute
 * sweep idempotent: without it the sweep proposes the same repair twelve times an hour, and there
 * is no way to tell a defect that a repair fixed from one that a repair only appeared to fix.
 */
export const SOUL_DOCTOR_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS soul_doctor_finding (
    fingerprint     text PRIMARY KEY,
    business_id     text NOT NULL,
    code            text NOT NULL,
    severity        text NOT NULL CHECK (severity IN ('broken', 'suspect')),
    subject_kind    text NOT NULL,
    subject_id      text NOT NULL,
    subject_digest  text,
    at              text NOT NULL,
    detail          text NOT NULL,
    state           text NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open','repairing','repaired','escalated','resolved')),
    attempts        integer NOT NULL DEFAULT 0,
    run_id          text,
    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS soul_doctor_finding_open_idx
     ON soul_doctor_finding (business_id, state, last_seen_at DESC)`,
  // A repaired defect that reappears is the interesting case — the repair did not take — so the
  // subject is indexed independently of the fingerprint, which changes when the artifact does.
  `CREATE INDEX IF NOT EXISTS soul_doctor_finding_subject_idx
     ON soul_doctor_finding (business_id, subject_kind, subject_id)`,
];
