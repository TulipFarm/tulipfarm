import { z } from 'zod';
import { commonCompatibility, qualified, type SqlClient } from './runtime.ts';

export const recommendationCompatibility = { minimum: 1, maximum: commonCompatibility.maximum };
export const recommendationEventChannel = 'tulipfarm_recommendations_v1';
export const recommendationWindowMs = 30_000;
export const recommendationChangeSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum([
    'definition',
    'integration',
    'memory',
    'knowledge',
    'file',
    'rows',
    'membership',
    'project',
    'settings',
    'seed',
    'repair',
  ]),
  sourceId: z.string().min(1).max(256),
  membershipIds: z.array(z.uuid()),
  invalidate: z.boolean().default(false),
});
export type RecommendationChange = z.input<typeof recommendationChangeSchema>;
export type RecommendationTransaction = { client: SqlClient; schema: string; commonVersion?: number };

export async function recommendationsInstalled(tx: RecommendationTransaction) {
  if (tx.commonVersion !== undefined) return tx.commonVersion >= recommendationCompatibility.minimum;
  const row = await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
    qualified(tx.schema, 'tf_recommendation_refresh'),
  ]);
  return z.object({ installed: z.boolean() }).parse(row.rows[0]).installed;
}

export async function recordRecommendationChange(tx: RecommendationTransaction, input: RecommendationChange) {
  const change = recommendationChangeSchema.parse(input);
  if (!(await recommendationsInstalled(tx))) return { kind: 'migration-pending' as const };
  const result = await tx.client.query(
    `SELECT ${qualified(tx.schema, 'record_recommendation_change')}($1,$2,$3,$4,$5) AS recorded`,
    [change.id, change.kind, change.sourceId, [...new Set(change.membershipIds)].sort(), change.invalidate],
  );
  return { kind: 'recorded' as const, recorded: z.object({ recorded: z.boolean() }).parse(result.rows[0]).recorded };
}

export async function invalidateRecommendationSource(
  tx: RecommendationTransaction & { workspaceId: string },
  sourceId: string,
) {
  z.string().min(1).max(256).parse(sourceId);
  z.uuid().parse(tx.workspaceId);
  if (!(await recommendationsInstalled(tx))) return;
  const table = (name: string) => qualified(tx.schema, name);
  await tx.client.query(
    `WITH affected AS (
    SELECT r.membership_id FROM ${table('tf_recommendation_refresh')} r
    JOIN ${table('tf_recommendation_dependencies')} d USING (membership_id)
    WHERE d.source_id=$1 ORDER BY r.membership_id FOR UPDATE OF r
  ), fenced AS (
    UPDATE ${table('tf_recommendation_refresh')} r SET generation=r.generation+1,
      status=CASE WHEN r.due_at IS NULL THEN 'unavailable' ELSE 'pending' END,
      claimed_generation=NULL,attempt_id=NULL,claimed_at=NULL,error_code=NULL,updated_at=clock_timestamp()
    WHERE r.membership_id IN (SELECT membership_id FROM affected)
    RETURNING r.membership_id,r.generation
  ), snapshots AS (
    DELETE FROM ${table('tf_recommendation_snapshots')} WHERE membership_id IN (SELECT membership_id FROM fenced)
  ), results AS (
    DELETE FROM ${table('tf_recommendation_results')} WHERE membership_id IN (SELECT membership_id FROM fenced)
  ), dependencies AS (
    DELETE FROM ${table('tf_recommendation_dependencies')} WHERE membership_id IN (SELECT membership_id FROM fenced)
  )
  SELECT pg_notify($2,json_build_object('workspaceId',$3::uuid,'membershipId',membership_id,
    'version',generation,'kind','invalidated')::text) FROM fenced`,
    [sourceId, recommendationEventChannel, tx.workspaceId],
  );
}

export async function activeRecommendationMembers(tx: RecommendationTransaction): Promise<string[]> {
  return z
    .array(z.object({ id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT id FROM ${qualified(tx.schema, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY id`,
        )
      ).rows,
    )
    .map(row => row.id);
}

export async function scheduleRecommendationExpiry(
  tx: RecommendationTransaction,
  invitationId: string,
  expiresAt: Date,
) {
  z.uuid().parse(invitationId);
  z.date().parse(expiresAt);
  if (!(await recommendationsInstalled(tx))) return;
  await tx.client.query(
    `INSERT INTO ${qualified(tx.schema, 'tf_recommendation_expiries')}(invitation_id,expires_at)
    VALUES($1,$2) ON CONFLICT(invitation_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,delivered_at=NULL
    WHERE ${qualified(tx.schema, 'tf_recommendation_expiries')}.expires_at<>EXCLUDED.expires_at`,
    [invitationId, expiresAt],
  );
}
