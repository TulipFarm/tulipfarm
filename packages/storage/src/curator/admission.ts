import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";

export const CURATOR_ADMISSION_STATEMENTS: readonly string[] = [
  // Run-kernel budgets are per Run, so fifty individually bounded Runs can still blow the
  // deployment's daily spend. This is the aggregate ceiling they cannot each see.
  //
  // It counts money, not Runs: a Run count cannot express "one expensive job or twenty cheap ones",
  // which is the only question a spend ceiling is asked. `reserved` is what outstanding jobs are
  // allowed to spend at most; `actual` is what settled ones did spend. Admission compares their sum
  // against the cap, so a day of cheap jobs does not consume the budget a Run count would charge it.
  `CREATE TABLE IF NOT EXISTS curator_admission (
    business_id          text NOT NULL,
    day                  date NOT NULL,
    reserved_cost_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_micros >= 0),
    actual_cost_micros   bigint NOT NULL DEFAULT 0 CHECK (actual_cost_micros >= 0),
    PRIMARY KEY (business_id, day)
  )`,
  // Keyed by job so a retried mint conflicts instead of reserving twice, and so settlement is a
  // state transition on one row rather than an unguarded decrement of a shared counter.
  `CREATE TABLE IF NOT EXISTS curator_admission_reservation (
    job_id               uuid PRIMARY KEY REFERENCES curator_job(id) ON DELETE CASCADE,
    business_id          text NOT NULL,
    day                  date NOT NULL,
    reserved_cost_micros bigint NOT NULL CHECK (reserved_cost_micros >= 0),
    actual_cost_micros   bigint,
    state                text NOT NULL DEFAULT 'held'
                           CHECK (state IN ('held', 'settled', 'released')),
    created_at           timestamptz NOT NULL DEFAULT now(),
    settled_at           timestamptz,
    CHECK ((state = 'held') = (settled_at IS NULL))
  )`,
];

export interface CuratorReservation {
  readonly jobId: string;
  readonly businessId: string;
  /** `YYYY-MM-DD`, UTC, so a deployment's ceiling does not reset twice on a timezone boundary. */
  readonly day: string;
  readonly costMicros: number;
  readonly dailyCapMicros: number;
}

/** The deployment-wide daily spend ceiling Curator Runs are minted against. */
export class CuratorAdmissionLedger {
  constructor(private readonly db: Queryable) {}

  /**
   * Reserves this job's worst-case spend against the day's ceiling, atomically.
   *
   * The reservation is keyed by job, so a replayed mint conflicts instead of charging twice, and
   * settlement is a state transition on one row rather than an unguarded decrement of a shared
   * counter. Returns `false` when the day cannot afford the job; the caller must roll back.
   */
  async reserve(tx: Queryable, input: CuratorReservation): Promise<boolean> {
    // The `ON CONFLICT` guard below cannot gate the first insert of the day, so a job larger than
    // the entire cap would slip through on a fresh day. This compares two constants; it is not a
    // read-then-check.
    if (input.costMicros > input.dailyCapMicros) return false;
    const held = await tx.query<{ job_id: string }>(
      `INSERT INTO curator_admission_reservation
         (job_id, business_id, day, reserved_cost_micros)
       VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (job_id) DO NOTHING
       RETURNING job_id`,
      [input.jobId, input.businessId, input.day, input.costMicros]
    );
    // No row means this job already holds a reservation, so a replayed mint must not charge again.
    if (held.rows.length === 0) return true;
    const { rows } = await tx.query<{ reserved_cost_micros: string }>(
      `INSERT INTO curator_admission (business_id, day, reserved_cost_micros)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (business_id, day) DO UPDATE
         SET reserved_cost_micros = curator_admission.reserved_cost_micros + $3
       WHERE curator_admission.reserved_cost_micros
             + curator_admission.actual_cost_micros + $3 <= $4
       RETURNING reserved_cost_micros`,
      [input.businessId, input.day, input.costMicros, input.dailyCapMicros]
    );
    return rows.length > 0;
  }

  /**
   * Converts a held reservation into what the job actually cost, exactly once.
   *
   * `actualCostMicros` comes from the Run's own recorded spend, never from a Worker claiming
   * whether it called a model: a Worker that crashed mid-call cannot report, and one that lies
   * would move the ceiling. A job that spent nothing releases its whole reservation.
   */
  async settle(jobId: string, actualCostMicros: number): Promise<boolean> {
    return withTransaction(this.db, (tx) => settleCuratorReservation(tx, jobId, actualCostMicros));
  }
}

/**
 * The reservation half of {@link CuratorAdmissionLedger.settle}, on a caller's transaction.
 *
 * Abandoning a job has to terminalize it, free its work and free its money together — three
 * writes that must not be able to half-succeed — so that path needs this without opening a second
 * transaction inside the first.
 */
export async function settleCuratorReservation(
  tx: Queryable,
  jobId: string,
  actualCostMicros: number
): Promise<boolean> {
  const { rows } = await tx.query<{
    business_id: string;
    day: string;
    reserved_cost_micros: string;
  }>(
    `UPDATE curator_admission_reservation
          SET state = $3, actual_cost_micros = $2, settled_at = now()
        WHERE job_id = $1 AND state = 'held'
        RETURNING business_id, day, reserved_cost_micros`,
    [jobId, actualCostMicros, actualCostMicros > 0 ? "settled" : "released"]
  );
  const row = rows[0];
  if (!row) return false;
  await tx.query(
    `UPDATE curator_admission
          SET reserved_cost_micros = greatest(0, reserved_cost_micros - $3),
              actual_cost_micros = actual_cost_micros + $4
        WHERE business_id = $1 AND day = $2`,
    [row.business_id, row.day, Number(row.reserved_cost_micros), actualCostMicros]
  );
  return true;
}
