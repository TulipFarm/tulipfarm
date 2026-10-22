import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const positivePicoUsd = z.string().regex(/^[1-9]\d{0,29}$/);
const picoUsd = z.string().regex(/^(0|[1-9]\d{0,29})$/);
const attemptId = z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/);
const uuid = z.uuid().transform(value => value.toLowerCase());
const limitsSchema = z.strictObject({
  workspacePicoUsd: positivePicoUsd,
  platformPicoUsd: positivePicoUsd,
  periodSeconds: z.number().int().min(1).max(31_536_000),
});
const reservationSchema = z.strictObject({
  id: attemptId,
  workspaceId: uuid,
  membershipId: uuid,
  modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/),
  maximumPicoUsd: positivePicoUsd,
});
const settlementSchema = z.strictObject({ id: attemptId, providerPicoUsd: picoUsd.nullable() });
const attemptRow = z.object({
  id: attemptId,
  workspace_id: uuid,
  membership_id: uuid,
  model_id: reservationSchema.shape.modelId,
  maximum_pico_usd: positivePicoUsd,
  period_started_at: z.date(),
  state: z.enum(['reserved', 'dispatched', 'unknown', 'settled']),
  provider_pico_usd: picoUsd.nullable(),
  created_at: z.date(),
  dispatched_at: z.date().nullable(),
  settled_at: z.date().nullable(),
  projected_at: z.date().nullable(),
});
const counterRow = z.object({
  reserved_pico_usd: z.string().regex(/^\d+$/),
  spent_pico_usd: z.string().regex(/^\d+$/),
});

/** Required operator limits. Periods are fixed UTC epoch windows, not sliding windows. */
export type RecommendationBudgetLimits = z.infer<typeof limitsSchema>;
/** One stable ID per logical provider attempt; maximumPicoUsd is its caller-proven worst case. */
export type RecommendationBudgetReservation = z.infer<typeof reservationSchema>;
/** Null means unknown usage, never free usage. A later known amount may reconcile it. */
export type RecommendationBudgetSettlement = z.infer<typeof settlementSchema>;
export type RecommendationBudgetAdmission = 'admitted' | 'existing' | 'capped';
export type RecommendationBudgetAttempt = RecommendationBudgetReservation & {
  periodStartedAt: Date;
  state: 'reserved' | 'dispatched' | 'unknown' | 'settled';
  providerPicoUsd: string | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  settledAt: Date | null;
  projectedAt: Date | null;
};
/** Known spend only; use spendId in tf_platform_recommendation_spend, then acknowledge. */
export type RecommendationBudgetProjection = {
  id: string;
  spendId: string;
  workspaceId: string;
  membershipId: string;
  modelId: string;
  providerPicoUsd: string;
  createdAt: Date;
};
export type RecommendationBudget = {
  reserve(input: RecommendationBudgetReservation): Promise<RecommendationBudgetAdmission>;
  /** Only true authorizes this caller's provider call. A retry must never redispatch the ID. */
  markDispatched(id: string): Promise<boolean>;
  settle(input: RecommendationBudgetSettlement): Promise<void>;
  getAttempt(id: string): Promise<RecommendationBudgetAttempt | null>;
  listPendingProjections(limit?: number): Promise<RecommendationBudgetProjection[]>;
  deferProjection(id: string): Promise<void>;
  /** Call only after the workspace insert commits, checking all fields on duplicate spendId. */
  markProjected(input: { id: string; providerPicoUsd: string }): Promise<void>;
};

export class RecommendationBudgetConflict extends Error {
  constructor() {
    super('recommendation-budget-conflict');
  }
}

export class RecommendationBudgetConfigurationConflict extends Error {
  constructor() {
    super('recommendation-budget-configuration-conflict');
  }
}

function viewAttempt(row: z.infer<typeof attemptRow>): RecommendationBudgetAttempt {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    membershipId: row.membership_id,
    modelId: row.model_id,
    maximumPicoUsd: row.maximum_pico_usd,
    periodStartedAt: row.period_started_at,
    state: row.state,
    providerPicoUsd: row.provider_pico_usd,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
    projectedAt: row.projected_at,
  };
}

async function readAttempt(client: PoolClient, id: string) {
  return attemptRow
    .optional()
    .parse((await client.query('SELECT * FROM app.platform_recommendation_attempts WHERE id=$1', [id])).rows[0]);
}

/**
 * The first admission pins operator limits in the application schema. All instances must
 * agree; changing that policy requires an explicit operator migration, not a process restart.
 * Settlements stay in their admission period, including unknown holds across period rollover.
 * The application ledger is authoritative. Workspace spend is an idempotent projection only.
 * Generated output belongs in a private workspace receipt, not this ledger or Temporal history.
 */
export function createRecommendationBudget(
  pool: Pick<Pool, 'connect'>,
  input: RecommendationBudgetLimits,
): RecommendationBudget {
  const limits = limitsSchema.parse(input);

  async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let reusable = false;
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      reusable = true;
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      reusable = true;
      throw error;
    } finally {
      client.release(!reusable);
    }
  }

  async function lockPolicy(client: PoolClient) {
    await client.query(
      `INSERT INTO app.platform_recommendation_budget_policy
      (id,workspace_pico_usd,platform_pico_usd,period_seconds) VALUES(true,$1,$2,$3)
      ON CONFLICT(id) DO NOTHING`,
      [limits.workspacePicoUsd, limits.platformPicoUsd, limits.periodSeconds],
    );
    const policy = z
      .object({
        workspace_pico_usd: positivePicoUsd,
        platform_pico_usd: positivePicoUsd,
        period_seconds: z.number(),
      })
      .parse(
        (await client.query('SELECT * FROM app.platform_recommendation_budget_policy WHERE id=true FOR UPDATE'))
          .rows[0],
      );
    if (
      policy.workspace_pico_usd !== limits.workspacePicoUsd ||
      policy.platform_pico_usd !== limits.platformPicoUsd ||
      policy.period_seconds !== limits.periodSeconds
    )
      throw new RecommendationBudgetConfigurationConflict();
  }

  async function lockCounters(client: PoolClient, period: Date, workspaceId: string, create: boolean) {
    const counters: z.infer<typeof counterRow>[] = [];
    // Every writer locks policy, then platform, then workspace. No workspace login is used.
    for (const scope of ['platform', `workspace:${workspaceId}`]) {
      if (create)
        await client.query(
          `INSERT INTO app.platform_recommendation_budget_counters
        (period_started_at,scope) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [period, scope],
        );
      counters.push(
        counterRow.parse(
          (
            await client.query(
              `SELECT reserved_pico_usd,spent_pico_usd
        FROM app.platform_recommendation_budget_counters
        WHERE period_started_at=$1 AND scope=$2 FOR UPDATE`,
              [period, scope],
            )
          ).rows[0],
        ),
      );
    }
    return counters;
  }

  return {
    async reserve(input) {
      const reservation = reservationSchema.parse(input);
      return transaction(async client => {
        await lockPolicy(client);
        const existing = await readAttempt(client, reservation.id);
        if (existing) {
          if (
            existing.workspace_id !== reservation.workspaceId ||
            existing.membership_id !== reservation.membershipId ||
            existing.model_id !== reservation.modelId ||
            existing.maximum_pico_usd !== reservation.maximumPicoUsd
          )
            throw new RecommendationBudgetConflict();
          return 'existing';
        }
        const { period } = z
          .object({ period: z.date() })
          .parse(
            (
              await client.query(
                `SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp())/$1::numeric)*$1::numeric) AS period`,
                [limits.periodSeconds],
              )
            ).rows[0],
          );
        const counters = await lockCounters(client, period, reservation.workspaceId, true);
        const caps = [limits.platformPicoUsd, limits.workspacePicoUsd];
        if (
          counters.some(
            (counter, index) =>
              BigInt(counter.reserved_pico_usd) + BigInt(counter.spent_pico_usd) + BigInt(reservation.maximumPicoUsd) >
              BigInt(caps[index]!),
          )
        )
          return 'capped';
        await client.query(
          `UPDATE app.platform_recommendation_budget_counters
          SET reserved_pico_usd=reserved_pico_usd+$3::numeric
          WHERE period_started_at=$1 AND scope=ANY($2::text[])`,
          [period, ['platform', `workspace:${reservation.workspaceId}`], reservation.maximumPicoUsd],
        );
        await client.query(
          `INSERT INTO app.platform_recommendation_attempts
          (id,workspace_id,membership_id,model_id,maximum_pico_usd,period_started_at)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [
            reservation.id,
            reservation.workspaceId,
            reservation.membershipId,
            reservation.modelId,
            reservation.maximumPicoUsd,
            period,
          ],
        );
        return 'admitted';
      });
    },

    async markDispatched(id) {
      const parsed = attemptId.parse(id);
      return transaction(async client => {
        await lockPolicy(client);
        const attempt = await readAttempt(client, parsed);
        if (!attempt) throw new RecommendationBudgetConflict();
        if (attempt.state !== 'reserved') return false;
        const result = await client.query(
          `UPDATE app.platform_recommendation_attempts
          SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=$1 AND state='reserved' RETURNING id`,
          [parsed],
        );
        return result.rowCount === 1;
      });
    },

    async settle(input) {
      const settlement = settlementSchema.parse(input);
      await transaction(async client => {
        await lockPolicy(client);
        const attempt = await readAttempt(client, settlement.id);
        if (!attempt) throw new RecommendationBudgetConflict();
        if (attempt.state === 'settled') {
          if (attempt.provider_pico_usd !== settlement.providerPicoUsd) throw new RecommendationBudgetConflict();
          return;
        }
        if (settlement.providerPicoUsd === null) {
          if (attempt.state === 'unknown') return;
          await client.query(
            `UPDATE app.platform_recommendation_attempts
            SET state='unknown',settled_at=clock_timestamp() WHERE id=$1`,
            [settlement.id],
          );
          return;
        }
        await lockCounters(client, attempt.period_started_at, attempt.workspace_id, false);
        // Preserve actual spend even if a caller supplied an incorrect upper bound.
        await client.query(
          `UPDATE app.platform_recommendation_budget_counters
          SET reserved_pico_usd=reserved_pico_usd-$3::numeric,spent_pico_usd=spent_pico_usd+$4::numeric
          WHERE period_started_at=$1 AND scope=ANY($2::text[])`,
          [
            attempt.period_started_at,
            ['platform', `workspace:${attempt.workspace_id}`],
            attempt.maximum_pico_usd,
            settlement.providerPicoUsd,
          ],
        );
        await client.query(
          `UPDATE app.platform_recommendation_attempts
          SET state='settled',provider_pico_usd=$2,settled_at=clock_timestamp() WHERE id=$1`,
          [settlement.id, settlement.providerPicoUsd],
        );
      });
    },

    async getAttempt(id) {
      const parsed = attemptId.parse(id);
      return withClient(async client => {
        const attempt = await readAttempt(client, parsed);
        return attempt ? viewAttempt(attempt) : null;
      });
    },

    async listPendingProjections(limit = 100) {
      const bounded = z.number().int().min(1).max(1000).parse(limit);
      return withClient(async client => {
        const rows = z.array(attemptRow).parse(
          (
            await client.query(
              `SELECT *
          FROM app.platform_recommendation_attempts WHERE state='settled' AND projected_at IS NULL
            AND next_projection_at<=clock_timestamp()
          ORDER BY next_projection_at,settled_at,id LIMIT $1`,
              [bounded],
            )
          ).rows,
        );
        return rows.map(row => ({
          id: row.id,
          spendId: `recommendation:${row.id}`,
          workspaceId: row.workspace_id,
          membershipId: row.membership_id,
          modelId: row.model_id,
          providerPicoUsd: picoUsd.parse(row.provider_pico_usd),
          createdAt: row.created_at,
        }));
      });
    },

    async deferProjection(id) {
      const parsed = attemptId.parse(id);
      await withClient(async client => {
        const result = await client.query(
          `UPDATE app.platform_recommendation_attempts
          SET next_projection_at=clock_timestamp()+interval '30 seconds'
          WHERE id=$1 AND state='settled' RETURNING id`,
          [parsed],
        );
        if (result.rowCount !== 1) throw new RecommendationBudgetConflict();
      });
    },

    async markProjected(input) {
      const projection = settlementSchema.extend({ providerPicoUsd: picoUsd }).parse(input);
      await withClient(async client => {
        const result = await client.query(
          `UPDATE app.platform_recommendation_attempts
          SET projected_at=COALESCE(projected_at,clock_timestamp())
          WHERE id=$1 AND state='settled' AND provider_pico_usd=$2 RETURNING id`,
          [projection.id, projection.providerPicoUsd],
        );
        if (result.rowCount !== 1) throw new RecommendationBudgetConflict();
      });
    },
  };
}
