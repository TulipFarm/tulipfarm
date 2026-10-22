import { z } from 'zod';
import { canAccessAsset, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationRecommendationState } from './recommendations.ts';

export async function integrationCreationRecommendations(tx: AuthorizationTransaction, owningTeamId: string) {
  const table = (name: string) => qualified(tx.schema, name);
  return integrationRecommendationState(
    (
      await tx.client.query(
        `SELECT mt.membership_id,ARRAY['integration-create'] AS facts FROM ${table('tf_integration_creation_grants')} g
      JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id JOIN ${table('tf_memberships')} m ON m.id=mt.membership_id
      WHERE g.owning_team_id=$1 AND g.permission='integration.create' AND m.removed_at IS NULL`,
        [owningTeamId],
      )
    ).rows,
  );
}

export async function integrationRecommendations(tx: AuthorizationTransaction, id: string) {
  const table = (name: string) => qualified(tx.schema, name);
  const integration = z
    .object({ enabled: z.boolean(), owning_team_id: z.uuid() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT enabled,owning_team_id FROM ${table('tf_integrations')} WHERE id=$1 AND deleted_at IS NULL`,
          [id],
        )
      ).rows[0],
    );
  if (!integration) return new Map<string, string[]>();
  const members = z.array(z.object({ id: z.uuid(), user_id: z.string() })).parse(
    (
      await tx.client.query(
        `SELECT m.id,m.user_id FROM ${table('tf_memberships')} m WHERE m.removed_at IS NULL AND
      (EXISTS (SELECT 1 FROM ${table('tf_integration_person_grants')} g WHERE g.integration_id=$1 AND g.membership_id=m.id)
      OR EXISTS (SELECT 1 FROM ${table('tf_integration_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.integration_id=$1 AND mt.membership_id=m.id))`,
        [id],
      )
    ).rows,
  );
  const sources = z
    .array(z.object({ id: z.uuid(), owner: z.string(), repo: z.string() }))
    .parse(
      (
        await tx.client.query(`SELECT id,owner,repo FROM ${table('tf_integration_sources')} WHERE integration_id=$1`, [
          id,
        ])
      ).rows,
    );
  const rows = [];
  for (const member of members) {
    const actor = { kind: 'human' as const, userId: member.user_id, membershipId: member.id };
    if (!(await canAccessAsset(tx, actor, id, 'integration.read'))) continue;
    const facts = ['read', `owner:${integration.owning_team_id}`];
    if (await canAccessAsset(tx, actor, id, 'integration.manage')) facts.push('manage');
    if (integration.enabled && (await canAccessAsset(tx, actor, id, 'integration.use'))) {
      facts.push('use');
      for (const source of sources)
        if (await canAccessAsset(tx, actor, source.id, 'github.issue.read')) {
          facts.push(`source:${source.id}:${source.owner}/${source.repo}`);
        }
    }
    rows.push({ membership_id: member.id, facts });
  }
  return integrationRecommendationState(rows);
}
