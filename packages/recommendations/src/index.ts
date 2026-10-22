import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { recommendationCompatibility } from '@tulipfarm/workspace-storage/recommendations';
import {
  recommendationItemsSchema,
  recommendationListSchema,
  recommendationPolicy,
  recommendationSourceSchema,
  recommendationStatusSchema,
  type RecommendationList,
} from './contracts.ts';
import { fallbackRecommendations } from './rules.ts';

export * from './contracts.ts';
export * from './rules.ts';
export * from './context.ts';

const generation = z
  .union([z.string().regex(/^(0|[1-9]\d*)$/), z.number().int().nonnegative(), z.bigint().nonnegative()])
  .transform(value => Number(value))
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const savedRowSchema = z.object({
  refresh_generation: generation.nullable(),
  status: recommendationStatusSchema.nullable(),
  snapshot_generation: generation.nullable(),
  policy: z.string().nullable(),
  onboarding: z.boolean().nullable(),
  items: z.unknown(),
  sources: z.unknown(),
});

/** Authorization is the caller's job. This read never collects context or creates refresh work. */
export async function readSavedRecommendations(
  tx: AuthorizationTransaction & { commonVersion?: number },
  membershipId: string,
): Promise<RecommendationList> {
  const fallback = (status: RecommendationList['status'], version: number) =>
    recommendationListSchema.parse({
      onboarding: false,
      items: fallbackRecommendations,
      status,
      version,
    });
  if (tx.commonVersion === undefined || tx.commonVersion < recommendationCompatibility.minimum)
    return fallback('unavailable', 0);
  const row = savedRowSchema.optional().parse(
    (
      await tx.client.query(
        `SELECT r.generation::text AS refresh_generation,r.status,s.generation::text AS snapshot_generation,
      s.policy,s.onboarding,s.items,s.sources
    FROM ${qualified(tx.schema, 'tf_recommendation_refresh')} r
    FULL JOIN ${qualified(tx.schema, 'tf_recommendation_snapshots')} s USING (membership_id)
    WHERE COALESCE(r.membership_id,s.membership_id)=$1`,
        [membershipId],
      )
    ).rows[0],
  );
  if (!row) return fallback('unavailable', 0);
  const version = Math.max(row.refresh_generation ?? 0, row.snapshot_generation ?? 0);
  if (row.policy !== recommendationPolicy)
    return fallback(row.status === 'ready' ? 'unavailable' : (row.status ?? 'unavailable'), version);
  const items = recommendationItemsSchema.length(5).parse(row.items);
  z.array(recommendationSourceSchema).max(200).parse(row.sources);
  const onboarding = z.boolean().parse(row.onboarding);
  if (
    onboarding !== items.some(item => item.kind === 'onboarding') ||
    items.some(
      (item, index) => item.kind === 'onboarding' && items.slice(0, index).some(prior => prior.kind !== 'onboarding'),
    ) ||
    items.some(item => item.kind === 'prompt' && item.action.kind !== 'prompt') ||
    row.snapshot_generation === null
  )
    throw new Error('Corrupt recommendation snapshot');
  return recommendationListSchema.parse({ onboarding, items, status: row.status ?? 'ready', version });
}
