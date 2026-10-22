import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization } from '@tulipfarm/access';
import { qualified, type createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import {
  activeRecommendationMembers,
  recordRecommendationChange,
  recommendationCompatibility,
  recommendationEventChannel,
  type RecommendationTransaction,
} from '@tulipfarm/workspace-storage/recommendations';
import {
  recommendationItemsSchema,
  recommendationLimit,
  recommendationPolicy,
  recommendationSourceSchema,
  type RecommendationSource,
} from './contracts.ts';

const version = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const claimSchema = z.object({ membershipId: z.uuid(), generation: version, attemptId: z.uuid() });
export type RecommendationClaim = z.infer<typeof claimSchema>;
type Runtime = Pick<ReturnType<typeof createWorkspaceRuntime>, 'transaction'>;
type Failure = 'failed' | 'budget-paused' | 'unavailable';
const table = (tx: RecommendationTransaction, name: string) => qualified(tx.schema, name);
const outputSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  onboarding: z.boolean(),
  items: recommendationItemsSchema.length(recommendationLimit),
  sources: z.array(recommendationSourceSchema).max(200),
});
export type RecommendationOutput = z.infer<typeof outputSchema>;

export function createRecommendationWork(runtime: Runtime) {
  function transaction<T>(workspaceId: string, operation: (tx: RecommendationTransaction) => Promise<T>) {
    return runtime.transaction(z.uuid().parse(workspaceId), recommendationCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  }

  async function notify(tx: RecommendationTransaction, workspaceId: string, membershipId: string, generation: number) {
    await tx.client.query('SELECT pg_notify($1,$2)', [
      recommendationEventChannel,
      JSON.stringify({ workspaceId, membershipId, version: generation, kind: 'changed' }),
    ]);
  }
  async function track(tx: RecommendationTransaction, membershipId: string, sources: RecommendationSource[]) {
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_recommendation_dependencies')}(membership_id,source_id)
      SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [membershipId, [...new Set(sources.map(source => source.id))]],
    );
  }
  async function retainPublishedSources(tx: RecommendationTransaction, membershipId: string) {
    await tx.client.query(`DELETE FROM ${table(tx, 'tf_recommendation_dependencies')} WHERE membership_id=$1`, [
      membershipId,
    ]);
    await tx.client.query(
      `INSERT INTO ${table(tx, 'tf_recommendation_dependencies')}(membership_id,source_id)
      SELECT s.membership_id,source->>'id' FROM ${table(tx, 'tf_recommendation_snapshots')} s,
        jsonb_array_elements(s.sources) source WHERE s.membership_id=$1 ON CONFLICT DO NOTHING`,
      [membershipId],
    );
  }

  return {
    compactEvents(workspaceId: string) {
      return transaction(workspaceId, async tx => {
        const result = await tx.client.query(`WITH expired AS (
          SELECT id FROM ${table(tx, 'tf_recommendation_events')}
          WHERE compacted_at IS NULL AND created_at<clock_timestamp()-interval '7 days'
          ORDER BY created_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED
        ) UPDATE ${table(tx, 'tf_recommendation_events')} e SET membership_ids='{}',compacted_at=clock_timestamp()
          FROM expired WHERE e.id=expired.id`);
        return result.rowCount ?? 0;
      });
    },
    trackSources(workspaceId: string, input: RecommendationClaim, inputSources: RecommendationSource[]) {
      const claim = claimSchema.parse(input);
      const sources = z.array(recommendationSourceSchema).max(200).parse(inputSources);
      return transaction(workspaceId, async tx => {
        const current = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_recommendation_refresh')}
          WHERE membership_id=$1 AND attempt_id=$2 AND generation=$3 AND claimed_generation=$3 FOR UPDATE`,
          [claim.membershipId, claim.attemptId, claim.generation],
        );
        if (!current.rowCount) return false;
        await track(tx, claim.membershipId, sources);
        return true;
      });
    },
    pending(workspaceId: string, after: string | null = null) {
      return transaction(workspaceId, async tx =>
        z.array(z.object({ membershipId: z.uuid(), userId: z.string(), queuedAt: z.date() })).parse(
          (
            await tx.client.query(
              `SELECT r.membership_id AS "membershipId",m.user_id AS "userId",
          COALESCE(r.first_event_at,r.claimed_at) AS "queuedAt"
          FROM ${table(tx, 'tf_recommendation_refresh')} r JOIN ${table(tx, 'tf_memberships')} m ON m.id=r.membership_id
          WHERE (r.due_at<=clock_timestamp() OR r.claimed_at IS NOT NULL)
            AND ($1::uuid IS NULL OR r.membership_id>$1)
          ORDER BY r.membership_id LIMIT 100`,
              [after],
            )
          ).rows,
        ),
      );
    },

    claim(workspaceId: string, membershipId: string) {
      return transaction(workspaceId, async tx => {
        const row = z
          .object({
            generation: version,
            claimed_generation: version.nullable(),
            attempt_id: z.uuid().nullable(),
            due: z.boolean(),
          })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT generation,claimed_generation,attempt_id,
          COALESCE(due_at<=clock_timestamp(),false) AS due FROM ${table(tx, 'tf_recommendation_refresh')}
          WHERE membership_id=$1 FOR UPDATE`,
                [z.uuid().parse(membershipId)],
              )
            ).rows[0],
          );
        if (!row) return null;
        if (row.claimed_generation !== null)
          return claimSchema.parse({ membershipId, generation: row.claimed_generation, attemptId: row.attempt_id });
        if (!row.due) return null;
        const attemptId = randomUUID();
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_recommendation_refresh')} SET
          claimed_generation=generation,attempt_id=$2,claimed_at=clock_timestamp(),
          first_event_at=NULL,due_at=NULL,status='running',error_code=NULL,updated_at=clock_timestamp()
          WHERE membership_id=$1`,
          [membershipId, attemptId],
        );
        await notify(tx, workspaceId, membershipId, row.generation);
        return { membershipId, generation: row.generation, attemptId };
      });
    },

    output(workspaceId: string, input: RecommendationClaim) {
      const claim = claimSchema.parse(input);
      return transaction(workspaceId, async tx =>
        outputSchema.optional().parse(
          (
            await tx.client.query(
              `SELECT o.fingerprint,o.onboarding,o.items,o.sources FROM ${table(tx, 'tf_recommendation_results')} o
         JOIN ${table(tx, 'tf_recommendation_refresh')} r ON r.membership_id=o.membership_id AND r.generation=o.generation AND r.attempt_id=o.attempt_id
         WHERE o.membership_id=$1 AND o.attempt_id=$2 AND o.generation=$3`,
              [claim.membershipId, claim.attemptId, claim.generation],
            )
          ).rows[0],
        ),
      );
    },

    saveOutput(workspaceId: string, input: RecommendationClaim, snapshot: RecommendationOutput) {
      const claim = claimSchema.parse(input);
      const output = outputSchema.parse(snapshot);
      return transaction(workspaceId, async tx => {
        const current = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_recommendation_refresh')}
          WHERE membership_id=$1 AND attempt_id=$2 AND generation=$3 AND claimed_generation=$3 FOR UPDATE`,
          [claim.membershipId, claim.attemptId, claim.generation],
        );
        if (!current.rowCount) return false;
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_recommendation_results')}
          (membership_id,attempt_id,generation,fingerprint,onboarding,items,sources) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(membership_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id,generation=EXCLUDED.generation,
          fingerprint=EXCLUDED.fingerprint,onboarding=EXCLUDED.onboarding,items=EXCLUDED.items,sources=EXCLUDED.sources`,
          [
            claim.membershipId,
            claim.attemptId,
            claim.generation,
            output.fingerprint,
            output.onboarding,
            JSON.stringify(output.items),
            JSON.stringify(output.sources),
          ],
        );
        await track(tx, claim.membershipId, output.sources);
        return true;
      });
    },

    publish(
      workspaceId: string,
      input: RecommendationClaim,
      snapshot: {
        fingerprint: string;
        onboarding: boolean;
        items: unknown;
        sources: RecommendationSource[];
      },
    ) {
      const claim = claimSchema.parse(input);
      const items = recommendationItemsSchema.parse(snapshot.items);
      if (items.length !== recommendationLimit) throw new Error('recommendation-incomplete-list');
      const fingerprint = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(snapshot.fingerprint);
      const sources = z.array(recommendationSourceSchema).parse(snapshot.sources);
      return transaction(workspaceId, async tx => {
        const row = z
          .object({ generation: version, current: z.boolean() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT r.generation, r.generation=$3 AND m.removed_at IS NULL AS current
           FROM ${table(tx, 'tf_recommendation_refresh')} r JOIN ${table(tx, 'tf_memberships')} m ON m.id=r.membership_id
           WHERE r.membership_id=$1 AND r.attempt_id=$2 AND r.claimed_generation=$3 FOR UPDATE OF r`,
                [claim.membershipId, claim.attemptId, claim.generation],
              )
            ).rows[0],
          );
        if (!row) return 'superseded' as const;
        if (row.current) {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_recommendation_snapshots')}
            (membership_id,fingerprint,items,onboarding,generation,policy,sources)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(membership_id) DO UPDATE SET
            fingerprint=EXCLUDED.fingerprint,items=EXCLUDED.items,onboarding=EXCLUDED.onboarding,
            generation=EXCLUDED.generation,policy=EXCLUDED.policy,sources=EXCLUDED.sources,generated_at=clock_timestamp()`,
            [
              claim.membershipId,
              fingerprint,
              JSON.stringify(items),
              snapshot.onboarding,
              claim.generation,
              recommendationPolicy,
              JSON.stringify(sources),
            ],
          );
        }
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_recommendation_refresh')} SET
          status=CASE WHEN generation=$3 THEN $4 ELSE 'pending' END,
          claimed_generation=NULL,attempt_id=NULL,claimed_at=NULL,updated_at=clock_timestamp()
          WHERE membership_id=$1 AND attempt_id=$2`,
          [claim.membershipId, claim.attemptId, claim.generation, row.current ? 'ready' : 'unavailable'],
        );
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_recommendation_results')} WHERE membership_id=$1 AND attempt_id=$2`,
          [claim.membershipId, claim.attemptId],
        );
        await retainPublishedSources(tx, claim.membershipId);
        await notify(tx, workspaceId, claim.membershipId, row.generation);
        return row.current ? ('published' as const) : ('superseded' as const);
      });
    },

    fail(workspaceId: string, input: RecommendationClaim, status: Failure, code: string) {
      const claim = claimSchema.parse(input);
      z.enum(['failed', 'budget-paused', 'unavailable']).parse(status);
      z.string()
        .regex(/^[a-z][a-z0-9-]{0,99}$/)
        .parse(code);
      return transaction(workspaceId, async tx => {
        const result = await tx.client.query(
          `UPDATE ${table(tx, 'tf_recommendation_refresh')} SET
          status=CASE WHEN generation=$3 THEN $4 ELSE 'pending' END,
          error_code=CASE WHEN generation=$3 THEN $5 ELSE NULL END,
          claimed_generation=NULL,attempt_id=NULL,claimed_at=NULL,updated_at=clock_timestamp()
          WHERE membership_id=$1 AND attempt_id=$2 AND claimed_generation=$3 RETURNING generation`,
          [claim.membershipId, claim.attemptId, claim.generation, status, code],
        );
        if (result.rowCount)
          await notify(tx, workspaceId, claim.membershipId, version.parse(result.rows[0].generation));
        await tx.client.query(
          `DELETE FROM ${table(tx, 'tf_recommendation_results')} WHERE membership_id=$1 AND attempt_id=$2`,
          [claim.membershipId, claim.attemptId],
        );
        if (result.rowCount) await retainPublishedSources(tx, claim.membershipId);
      });
    },

    expireInvitations(workspaceId: string) {
      return runtime.transaction(z.uuid().parse(workspaceId), recommendationCompatibility, async tx => {
        await lockAuthorization(tx, 'write');
        const rows = z.array(z.object({ invitation_id: z.uuid(), expired: z.boolean() })).parse(
          (
            await tx.client.query(`SELECT e.invitation_id,
            i.revoked_at IS NULL AND i.consumed_membership_id IS NULL AND i.expires_at=e.expires_at
              AND i.expires_at<=clock_timestamp() AS expired
            FROM ${table(tx, 'tf_recommendation_expiries')} e JOIN ${table(tx, 'tf_invitations')} i ON i.id=e.invitation_id
            WHERE e.delivered_at IS NULL AND e.expires_at<=clock_timestamp()
            ORDER BY e.expires_at,e.invitation_id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`)
          ).rows,
        );
        for (const row of rows) {
          if (row.expired)
            await recordRecommendationChange(tx, {
              id: randomUUID(),
              kind: 'membership',
              sourceId: row.invitation_id,
              membershipIds: await activeRecommendationMembers(tx),
            });
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_recommendation_expiries')} SET delivered_at=clock_timestamp() WHERE invitation_id=$1`,
            [row.invitation_id],
          );
        }
        return rows.length;
      });
    },
  };
}
