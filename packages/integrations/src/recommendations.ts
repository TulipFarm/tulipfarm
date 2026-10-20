import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  recordRecommendationChange,
  type RecommendationTransaction,
} from '@tulipfarm/workspace-storage/recommendations';

export type IntegrationRecommendationState = Map<string, string[]>;

export function changedIntegrationRecommendationMembers(
  before: IntegrationRecommendationState,
  after: IntegrationRecommendationState,
) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    id => JSON.stringify(before.get(id) ?? []) !== JSON.stringify(after.get(id) ?? []),
  );
}

export function integrationRecommendationState(rows: unknown): IntegrationRecommendationState {
  const state: IntegrationRecommendationState = new Map();
  for (const row of z.array(z.object({ membership_id: z.uuid(), facts: z.array(z.string()) })).parse(rows)) {
    state.set(row.membership_id, [...new Set([...(state.get(row.membership_id) ?? []), ...row.facts])].sort());
  }
  return state;
}

export async function recordIntegrationRecommendationChange(
  tx: RecommendationTransaction,
  sourceId: string,
  before: IntegrationRecommendationState,
  after: IntegrationRecommendationState,
) {
  const membershipIds = changedIntegrationRecommendationMembers(before, after);
  if (!membershipIds.length) return;
  const invalidate = membershipIds.some(id =>
    (before.get(id) ?? []).some(fact => !(after.get(id) ?? []).includes(fact)),
  );
  await recordRecommendationChange(tx, { id: randomUUID(), kind: 'integration', sourceId, membershipIds, invalidate });
}

export async function watchIntegrationRecommendations(
  tx: RecommendationTransaction,
  sourceId: string,
  read: () => Promise<IntegrationRecommendationState>,
) {
  const before = await read();
  return async () => recordIntegrationRecommendationChange(tx, sourceId, before, await read());
}
