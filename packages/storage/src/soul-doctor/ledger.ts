import type { Queryable } from "../ports";

export type FindingState = "open" | "repairing" | "repaired" | "escalated" | "resolved";

/** What the Doctor records for one distinct defect. Mirrors `Finding` in `@tulipfarm/soul-doctor`. */
export interface FindingRecord {
  readonly fingerprint: string;
  readonly code: string;
  readonly severity: "broken" | "suspect";
  readonly subject: { readonly kind: string; readonly id: string; readonly digest?: string };
  readonly at: string;
  readonly detail: string;
}

export interface LedgerEntry extends FindingRecord {
  readonly state: FindingState;
  readonly attempts: number;
  readonly runId: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

interface Row {
  fingerprint: string;
  code: string;
  severity: "broken" | "suspect";
  subject_kind: string;
  subject_id: string;
  subject_digest: string | null;
  at: string;
  detail: string;
  state: FindingState;
  attempts: number;
  run_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

function toEntry(row: Row): LedgerEntry {
  return {
    fingerprint: row.fingerprint,
    code: row.code,
    severity: row.severity,
    subject: {
      kind: row.subject_kind,
      id: row.subject_id,
      ...(row.subject_digest === null ? {} : { digest: row.subject_digest }),
    },
    at: row.at,
    detail: row.detail,
    state: row.state,
    attempts: row.attempts,
    runId: row.run_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * The Doctor's memory between sweeps.
 *
 * Every method is keyed by fingerprint rather than by subject, because the fingerprint carries the
 * artifact digest: republishing an artifact retires its old fingerprints by construction, so a
 * defect that survives a repair arrives as a *new* row and is visibly not the one already tried.
 */
export class SoulDoctorLedger {
  constructor(private readonly db: Queryable) {}

  /**
   * Records this sweep's sighting of a defect and returns the row as it now stands.
   *
   * `last_seen_at` moves on every sweep but nothing else does: a finding that a repair already
   * escalated must not be quietly reopened by the next tick, or the escalation is a loop with
   * extra steps.
   */
  async observe(businessId: string, finding: FindingRecord): Promise<LedgerEntry> {
    const result = await this.db.query<Row>(
      `INSERT INTO soul_doctor_finding
         (fingerprint, business_id, code, severity, subject_kind, subject_id, subject_digest,
          at, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (fingerprint) DO UPDATE
         SET last_seen_at = now(), updated_at = now(), detail = EXCLUDED.detail
       RETURNING fingerprint, code, severity, subject_kind, subject_id, subject_digest, at,
                 detail, state, attempts, run_id, first_seen_at, last_seen_at`,
      [
        finding.fingerprint,
        businessId,
        finding.code,
        finding.severity,
        finding.subject.kind,
        finding.subject.id,
        finding.subject.digest ?? null,
        finding.at,
        finding.detail,
      ]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("soul doctor ledger: observe returned no row");
    return toEntry(row);
  }

  /**
   * Claims a finding for repair, incrementing its attempt count.
   *
   * Conditional on the current state so two sweeps overlapping — a cron tick and a sync kick land
   * in the same minute — cannot both mint a repair Run for one defect. `false` means someone else
   * has it, or it is past repairing.
   */
  async claim(fingerprint: string, runId: string): Promise<boolean> {
    // `RETURNING` rather than a row count: the `Queryable` port carries rows only, and a claim
    // that cannot tell "I got it" from "someone else did" is not a claim.
    const result = await this.db.query<{ fingerprint: string }>(
      `UPDATE soul_doctor_finding
          SET state = 'repairing', attempts = attempts + 1, run_id = $2, updated_at = now()
        WHERE fingerprint = $1 AND state = 'open'
        RETURNING fingerprint`,
      [fingerprint, runId]
    );
    return result.rows.length > 0;
  }

  async settle(fingerprint: string, state: FindingState): Promise<void> {
    await this.db.query(
      `UPDATE soul_doctor_finding SET state = $2, updated_at = now() WHERE fingerprint = $1`,
      [fingerprint, state]
    );
  }

  /**
   * Closes every finding this sweep did not see again.
   *
   * A defect that stops being provable is fixed — by a repair, by a person, or by the artifact
   * being deleted — and leaving it open would keep an operator looking at work that no longer
   * exists. Escalated rows are exempt: a human was asked to act, and the ask outlives the sweep
   * that raised it.
   */
  async resolveUnseen(businessId: string, sweptAt: Date): Promise<number> {
    const result = await this.db.query<{ fingerprint: string }>(
      `UPDATE soul_doctor_finding
          SET state = 'resolved', updated_at = now()
        WHERE business_id = $1
          AND last_seen_at < $2
          AND state IN ('open', 'repairing', 'repaired')
        RETURNING fingerprint`,
      [businessId, sweptAt]
    );
    return result.rows.length;
  }

  async listOpen(businessId: string, limit: number): Promise<readonly LedgerEntry[]> {
    const result = await this.db.query<Row>(
      `SELECT fingerprint, code, severity, subject_kind, subject_id, subject_digest, at, detail,
              state, attempts, run_id, first_seen_at, last_seen_at
         FROM soul_doctor_finding
        WHERE business_id = $1 AND state IN ('open', 'repairing', 'escalated')
        ORDER BY last_seen_at DESC
        LIMIT $2`,
      [businessId, limit]
    );
    return result.rows.map(toEntry);
  }
}
