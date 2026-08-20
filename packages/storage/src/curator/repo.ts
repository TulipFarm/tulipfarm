import { randomUUID } from "node:crypto";
import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";
import { completeCuratorWork } from "./work";

/** Which half of the loop a job is: one person's private context, or the whole business's. */
export type CuratorScope = "user" | "business";

/**
 * Whether a job's effects may be applied. Set when the job is minted and never changed, so
 * enabling the loop can never reach back and apply output produced while it was in shadow.
 */
export type CuratorExecutionMode = "shadow" | "apply";

export type CuratorJobState = "minted" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * The exact inputs a job was bound to at mint time.
 *
 * This is an integrity binding, not a freshness test: it says "these are the rows and revisions
 * this job reasoned over", so the API can reload precisely them when the model's answer comes
 * back. Work that arrives afterwards stays due for the next Run rather than invalidating this one.
 */
export interface CuratorManifest {
  /** `(reason, sourceKey)` pairs, canonically sorted, that this job claimed. */
  readonly work: readonly { readonly reason: string; readonly sourceKey: string }[];
  /** Turn ids pinned as citable evidence. Nothing outside this list can support a claim. */
  readonly turnIds: readonly string[];
  /** `knowledge_promotion` candidate ids a business job may build a Knowledge page from. */
  readonly candidateIds: readonly string[];
  /** `proposal_seed` candidate ids a user job may personalise. Pinned separately from
   * `candidateIds` because the two directions cross the loop in opposite directions and a job of
   * either scope must never be able to name the other's. */
  readonly seedIds?: readonly string[];
  readonly soulDigest?: string;
}

/**
 * The content a job's context actually resolved to, captured the first time it was served.
 *
 * The manifest pins *which* rows a job reasons over; this pins *what they said*. Without it a
 * `contextDigest` proves only that two calls named the same ids, so output reasoned against one
 * version of a Memory Document could be accepted against another. It holds hashes, never content:
 * a copy of a private document here would be a second place erasure has to reach.
 */
export interface CuratorContextPin {
  readonly memoryRevisionId: string | null;
  readonly sectionHashes: Readonly<Record<string, string>>;
  /** Over the pinned candidates' ids and payloads, in pinned order. */
  readonly candidateDigest: string;
  readonly seedDigest: string;
  readonly soulDigest: string | null;
}

export interface CuratorJobRecord {
  readonly id: string;
  readonly businessId: string;
  readonly scope: CuratorScope;
  readonly userId?: string;
  readonly runId?: string;
  readonly state: CuratorJobState;
  readonly executionMode: CuratorExecutionMode;
  readonly manifestDigest: string;
  readonly manifest: CuratorManifest;
  /** Set once, the first time `GET context` resolves. Absent until then. */
  readonly contextPin?: CuratorContextPin;
  /** Set once, when a submission settles. Its presence is what makes settlement exactly-once. */
  readonly outputDigest?: string;
  readonly createdAt: Date;
}

export type CuratorEffectKind =
  | "memory_patch"
  | "proposal"
  | "knowledge_promotion"
  | "knowledge_page"
  | "proposal_seed";

/**
 * `shadowed` is its own terminal state rather than a reuse of `superseded` or `terminal_rejected`:
 * those two carry meaning in the metrics, and collapsing "we never intended to apply this" into
 * either would make both unreadable.
 */
export type CuratorEffectState =
  | "pending"
  | "applying"
  | "succeeded"
  | "retryable_failed"
  | "superseded"
  | "terminal_rejected"
  | "shadowed";

export interface CuratorEffectRecord {
  readonly id: string;
  readonly jobId: string;
  readonly businessId: string;
  readonly kind: CuratorEffectKind;
  readonly generation: number;
  readonly executionMode: CuratorExecutionMode;
  readonly state: CuratorEffectState;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** A dropped claim. Recorded, never inferred from an absence — "why" is the loop's own metric. */
export interface CuratorRejectionRecord {
  readonly jobId: string;
  readonly effect: string;
  readonly reason: string;
  readonly detail?: string;
}

/** Which way a candidate crosses between the two halves of the loop. */
export type CuratorCandidateDirection = "knowledge_promotion" | "proposal_seed";

export interface CuratorCandidateRecord {
  readonly id: string;
  readonly businessId: string;
  readonly direction: CuratorCandidateDirection;
  readonly userId?: string;
  readonly payload: unknown;
}

export interface CuratorJobRow {
  id: string;
  business_id: string;
  scope: CuratorScope;
  user_id: string | null;
  run_id: string | null;
  state: CuratorJobState;
  execution_mode: CuratorExecutionMode;
  manifest_digest: string;
  manifest: CuratorManifest;
  context_pin: CuratorContextPin | null;
  output_digest: string | null;
  created_at: Date;
}

export const CURATOR_JOB_COLUMNS = `id, business_id, scope, user_id, run_id, state, execution_mode,
              manifest_digest, manifest, context_pin, output_digest, created_at`;

export function toCuratorJob(row: CuratorJobRow): CuratorJobRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    scope: row.scope,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    state: row.state,
    executionMode: row.execution_mode,
    manifestDigest: row.manifest_digest,
    manifest: row.manifest,
    ...(row.context_pin === null ? {} : { contextPin: row.context_pin }),
    ...(row.output_digest === null ? {} : { outputDigest: row.output_digest }),
    createdAt: row.created_at,
  };
}

/**
 * A second, different answer arrived for a job that already settled.
 *
 * Not a retry and not a stale-input problem: the ledger already records what this job produced, and
 * overwriting it would erase the only evidence of what the loop actually proposed.
 */
export class CuratorSettlementConflictError extends Error {
  readonly name = "CuratorSettlementConflictError";

  constructor(readonly jobId: string) {
    super(`curator job ${jobId} already settled with different output`);
  }
}

/**
 * The Curator's own durable state. Reading a job and recording what a Run proposed are separate
 * from applying any of it: this store never mutates a Memory Document, a Task or a Knowledge page.
 */
/** A job that has stopped making progress, and what recovery must do about it. */
export interface StaleCuratorJob {
  readonly job: CuratorJobRecord;
  readonly disposition: "unstarted" | "abandoned";
}

export class CuratorRepo {
  constructor(private readonly db: Queryable) {}

  /**
   * Jobs that have stopped making progress, oldest first.
   *
   * `unstarted` — the job committed but no Run was ever bound, so the mint crashed in the window
   * between the two, and replaying `gateway.start()` under the job's own idempotency key recovers
   * it. `abandoned` — the job holds a live target but its Run is terminal without having settled,
   * so nothing will ever answer for it and the target must be freed.
   *
   * This exists because the live-target unique index is otherwise a trap: a job stuck in `minted`
   * holds its target forever, so one crash silently retires that user from the loop. Age alone
   * never decides — a Run that is merely slow is still a Run — so `unstartedBefore` must be
   * comfortably longer than a mint's own gateway call.
   *
   * `needs_reconciliation` counts as dead here even though the kernel allows a Run to leave it:
   * dispatch parks a Run there when its executor throws, nothing requeues a parked Run, and a
   * Curator Run's State never enters reconciliation, so `StateReconciler` cannot settle it either.
   * Treating it as live is what strands the target. Freeing it costs nothing, because
   * `abandonCuratorJob` still refuses any job that already recorded an answer.
   */
  async listStale(
    businessId: string,
    unstartedBefore: Date,
    limit: number
  ): Promise<StaleCuratorJob[]> {
    const { rows } = await this.db.query<
      CuratorJobRow & { disposition: "unstarted" | "abandoned" }
    >(
      `SELECT ${CURATOR_JOB_COLUMNS},
              CASE WHEN run_id IS NULL THEN 'unstarted' ELSE 'abandoned' END AS disposition
         FROM curator_job
        WHERE business_id = $1
          AND state IN ('minted', 'running')
          AND (
            (run_id IS NULL AND created_at < $2)
            OR EXISTS (SELECT 1 FROM runs
                        WHERE runs.id::text = curator_job.run_id
                          AND runs.status IN (
                                'succeeded', 'failed', 'cancelled', 'needs_reconciliation'
                              ))
          )
        ORDER BY created_at
        LIMIT $3`,
      [businessId, unstartedBefore, limit]
    );
    return rows.map((row) => ({ job: toCuratorJob(row), disposition: row.disposition }));
  }

  async getJob(businessId: string, jobId: string): Promise<CuratorJobRecord | undefined> {
    const { rows } = await this.db.query<CuratorJobRow>(
      `SELECT ${CURATOR_JOB_COLUMNS} FROM curator_job WHERE business_id = $1 AND id = $2`,
      [businessId, jobId]
    );
    const row = rows[0];
    return row ? toCuratorJob(row) : undefined;
  }

  /**
   * Reads exactly the candidates a job pinned, in the order it pinned them.
   *
   * A job must never be served "whatever is open now": candidates created after mint are outside
   * the manifest the submission is checked against, so showing them to the model produces claims
   * the API will reject, or worse, ones it accepts against inputs the digest never covered.
   * Rows that moved off `open`, or that belong to the other direction, are dropped rather than
   * served — the model may cite a candidate id, so an id must not outlive its content.
   */
  async readCandidates(
    businessId: string,
    direction: CuratorCandidateDirection,
    ids: readonly string[]
  ): Promise<CuratorCandidateRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<{
      id: string;
      business_id: string;
      direction: CuratorCandidateDirection;
      user_id: string | null;
      payload: unknown;
    }>(
      `SELECT id, business_id, direction, user_id, payload
         FROM curator_candidate
        WHERE business_id = $1 AND direction = $2 AND state = 'open' AND id = ANY($3::uuid[])`,
      [businessId, direction, ids]
    );
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      return [
        {
          id: row.id,
          businessId: row.business_id,
          direction: row.direction,
          ...(row.user_id === null ? {} : { userId: row.user_id }),
          payload: row.payload,
        },
      ];
    });
  }

  /**
   * Candidates a mint may choose to pin. Only mint reads open state; a job reads its manifest.
   *
   * Takes the caller's transaction handle because mint must read these in the same transaction that
   * inserts the job: read on a separate connection and the manifest records candidates the mint
   * never locked, so a concurrent claim can settle them before this job ever runs.
   */
  async listOpenCandidates(
    tx: Queryable,
    businessId: string,
    direction: CuratorCandidateDirection,
    limit: number
  ): Promise<CuratorCandidateRecord[]> {
    const { rows } = await tx.query<{
      id: string;
      business_id: string;
      direction: CuratorCandidateDirection;
      user_id: string | null;
      payload: unknown;
    }>(
      `SELECT id, business_id, direction, user_id, payload
         FROM curator_candidate
        WHERE business_id = $1 AND direction = $2 AND state = 'open'
        ORDER BY created_at
        LIMIT $3`,
      [businessId, direction, limit]
    );
    return rows.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      direction: row.direction,
      ...(row.user_id === null ? {} : { userId: row.user_id }),
      payload: row.payload,
    }));
  }

  /**
   * Settles one submission: the effects, the rejections and the job's terminal state, in one
   * transaction, exactly once.
   *
   * `output_digest` is claimed with a compare-and-set on `IS NULL`, and that claim is what makes
   * settlement exactly-once rather than merely idempotent-looking. A Worker that retries the same
   * output replays the stored counts and writes nothing; one that posts *different* output for a
   * job that already settled is refused, because the alternative is silently overwriting the
   * ledger with a second answer to a question that was only asked once.
   *
   * Effect ids are derived from the job, generation and ordinal rather than generated fresh, and
   * the effect state is taken from the job's own execution mode, never from the caller: the mode
   * is the whole protection against applying shadow output, so it cannot be a field a caller
   * supplies.
   */
  async settle(input: {
    readonly job: CuratorJobRecord;
    readonly outputDigest: string;
    readonly generation: number;
    readonly effects: readonly { readonly kind: CuratorEffectKind; readonly payload: unknown }[];
    readonly rejections: readonly {
      readonly effect: string;
      readonly reason: string;
      readonly detail?: string;
    }[];
  }): Promise<{ recorded: number; rejected: number; replayed: boolean }> {
    const { job, outputDigest, generation, effects, rejections } = input;
    return withTransaction(this.db, async (tx) => {
      const claimed = await tx.query<{ id: string }>(
        `UPDATE curator_job
            SET output_digest = $2, state = 'succeeded', updated_at = now()
          WHERE id = $1 AND output_digest IS NULL
          RETURNING id`,
        [job.id, outputDigest]
      );
      if (claimed.rows.length === 0) {
        const stored = await tx.query<{ output_digest: string | null }>(
          `SELECT output_digest FROM curator_job WHERE id = $1`,
          [job.id]
        );
        if (stored.rows[0]?.output_digest !== outputDigest) {
          throw new CuratorSettlementConflictError(job.id);
        }
        const counts = await tx.query<{ recorded: string; rejected: string }>(
          `SELECT (SELECT count(*) FROM curator_effect WHERE job_id = $1) AS recorded,
                  (SELECT count(*) FROM curator_rejection WHERE job_id = $1) AS rejected`,
          [job.id]
        );
        return {
          recorded: Number(counts.rows[0]?.recorded ?? 0),
          rejected: Number(counts.rows[0]?.rejected ?? 0),
          replayed: true,
        };
      }

      const state: CuratorEffectState = job.executionMode === "shadow" ? "shadowed" : "pending";
      for (const [ordinal, effect] of effects.entries()) {
        await tx.query(
          `INSERT INTO curator_effect
             (id, job_id, business_id, kind, generation, execution_mode, state, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            `${job.id}:${generation}:${ordinal}`,
            job.id,
            job.businessId,
            effect.kind,
            generation,
            job.executionMode,
            state,
            JSON.stringify(effect.payload),
          ]
        );
      }
      for (const rejection of rejections) {
        await tx.query(
          `INSERT INTO curator_rejection (job_id, effect, reason, detail) VALUES ($1, $2, $3, $4)`,
          [job.id, rejection.effect, rejection.reason, rejection.detail ?? null]
        );
      }
      // In the same transaction as the terminal state: work left `claimed` behind a settled job is
      // never picked up again and never released, so it would silently disappear from the loop.
      await completeCuratorWork(tx, job.id, new Date());
      return { recorded: effects.length, rejected: rejections.length, replayed: false };
    });
  }

  /**
   * Fixes what a job's context resolved to, first call wins.
   *
   * Returns the pin now in force, which is the caller's own only if it got there first. A later
   * resolution that disagrees is not merged and not overwritten: the job reasons over one version
   * of the world or it is retired, because two different answers to "what did it see" make the
   * whole binding meaningless.
   */
  async pinContext(jobId: string, pin: CuratorContextPin): Promise<CuratorContextPin> {
    const { rows } = await this.db.query<{ context_pin: CuratorContextPin }>(
      `UPDATE curator_job SET context_pin = $2
        WHERE id = $1 AND context_pin IS NULL
        RETURNING context_pin`,
      [jobId, JSON.stringify(pin)]
    );
    const claimed = rows[0]?.context_pin;
    if (claimed) return claimed;
    const stored = await this.db.query<{ context_pin: CuratorContextPin | null }>(
      `SELECT context_pin FROM curator_job WHERE id = $1`,
      [jobId]
    );
    const existing = stored.rows[0]?.context_pin;
    if (!existing) throw new Error(`curator job ${jobId} vanished while pinning context`);
    return existing;
  }

  /** Every effect a job produced, newest generation last. Reads the ledger, never applies it. */
  async listEffects(jobId: string): Promise<CuratorEffectRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      job_id: string;
      business_id: string;
      kind: CuratorEffectKind;
      generation: number;
      execution_mode: CuratorExecutionMode;
      state: CuratorEffectState;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT id, job_id, business_id, kind, generation, execution_mode, state, payload, created_at
         FROM curator_effect WHERE job_id = $1 ORDER BY generation, id`,
      [jobId]
    );
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      businessId: row.business_id,
      kind: row.kind,
      generation: row.generation,
      executionMode: row.execution_mode,
      state: row.state,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  async listRejections(jobId: string): Promise<CuratorRejectionRecord[]> {
    const { rows } = await this.db.query<{
      job_id: string;
      effect: string;
      reason: string;
      detail: string | null;
    }>(
      `SELECT job_id, effect, reason, detail FROM curator_rejection WHERE job_id = $1 ORDER BY id`,
      [jobId]
    );
    return rows.map((row) => ({
      jobId: row.job_id,
      effect: row.effect,
      reason: row.reason,
      ...(row.detail === null ? {} : { detail: row.detail }),
    }));
  }

  /**
   * Mints one job, or refuses because the target already has a live one.
   *
   * `undefined` is the whole point: the live-target unique indexes turn "two Runs for one user"
   * into a failed insert inside the caller's transaction, so the claim of work rows rolls back with
   * it and there is no compensating unwind to crash halfway through.
   */
  async insertJob(
    tx: Queryable,
    input: Omit<CuratorJobRecord, "id" | "createdAt" | "outputDigest"> & { readonly id?: string }
  ): Promise<CuratorJobRecord | undefined> {
    const { rows } = await tx.query<CuratorJobRow>(
      `INSERT INTO curator_job
         (id, business_id, scope, user_id, run_id, state, execution_mode, manifest_digest, manifest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING ${CURATOR_JOB_COLUMNS}`,
      [
        input.id ?? randomUUID(),
        input.businessId,
        input.scope,
        input.userId ?? null,
        input.runId ?? null,
        input.state,
        input.executionMode,
        input.manifestDigest,
        JSON.stringify(input.manifest),
      ]
    );
    const row = rows[0];
    return row ? toCuratorJob(row) : undefined;
  }

  /**
   * Binds a job to the Run that will execute it, compare-and-set.
   *
   * Re-attaching the same Run is how a replayed mint recovers from a crash between the job
   * transaction committing and the Run being started. Attaching a *different* Run would leave two
   * Runs reasoning over one manifest, so it is refused rather than overwritten.
   */
  async attachRun(jobId: string, runId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE curator_job SET run_id = $2, updated_at = now()
        WHERE id = $1 AND (run_id IS NULL OR run_id = $2)
        RETURNING id`,
      [jobId, runId]
    );
    if (rows.length === 0) throw new Error(`curator job ${jobId} is already bound to another Run`);
  }
}
