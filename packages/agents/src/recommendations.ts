import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  definitionGrantPredicate,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange, recommendationsInstalled } from '@tulipfarm/workspace-storage/recommendations';
import { requireAgentPermission } from './saved-policy.ts';
import { requireSavedSkillSources } from './skill-sources.ts';

type Kind = 'agent' | 'skill';
export async function definitionRecommendationAudience(tx: AuthorizationTransaction, kind: Kind, id: string) {
  const result = new Map<string, string>();
  if (!(await recommendationsInstalled(tx))) return result;
  const table = (name: string) => qualified(tx.schema, name);
  const entity = kind === 'agent' ? 'tf_agents' : 'tf_workspace_skills';
  const usable = kind === 'agent' ? 'invoke' : 'use';
  const state =
    kind === 'agent'
      ? `jsonb_build_object('definitions',(SELECT jsonb_agg(DISTINCT jsonb_build_array(a.definition_revision,a.scope))
         FROM ${table('tf_agent_activations')} a WHERE a.agent_id=e.id AND a.revoked_at IS NULL),
         'teams',(SELECT jsonb_agg(team_id ORDER BY team_id) FROM ${table('tf_agent_teams')} WHERE agent_id=e.id),
         'limits',(SELECT scope FROM ${table('tf_agent_limits')} WHERE agent_id=e.id))`
      : `jsonb_build_object('revision',e.active_revision)`;
  const active =
    kind === 'agent'
      ? `EXISTS(SELECT 1 FROM ${table('tf_agent_activations')} a WHERE a.agent_id=e.id AND a.revoked_at IS NULL)`
      : 'e.active_revision IS NOT NULL AND e.archived_at IS NULL';
  const rows = z
    .array(z.object({ membershipId: z.uuid(), userId: z.string(), value: z.string(), revision: z.string().nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT m.id AS "membershipId",m.user_id AS "userId",
      jsonb_build_array(${state},
        ${definitionGrantPredicate(tx, kind, 'e.id', 'm.id', `'${usable}'`)},
        ${definitionGrantPredicate(tx, kind, 'e.id', 'm.id', "'manage'")})::text AS value,
      ${kind === 'skill' ? 'e.active_revision' : 'NULL::text'} AS revision
      FROM ${table(entity)} e CROSS JOIN ${table('tf_memberships')} m
      WHERE e.id=$1 AND e.enabled AND e.deleted_at IS NULL AND ${active} AND m.removed_at IS NULL
        AND ${definitionGrantPredicate(tx, kind, 'e.id', 'm.id', "'read'")} ORDER BY m.id`,
          [id],
        )
      ).rows,
    );
  for (const row of rows) {
    const actor: HumanActor = { kind: 'human', userId: row.userId, membershipId: row.membershipId };
    try {
      if (kind === 'agent') await requireAgentPermission(tx, actor, id, 'read');
      else await requireSavedSkillSources(tx, id, row.revision!, actor);
    } catch (error) {
      if (error instanceof AccessDenied) continue;
      throw error;
    }
    result.set(row.membershipId, row.value);
  }
  return result;
}

export async function recordDefinitionRecommendationChanges(
  tx: AuthorizationTransaction,
  kind: Kind,
  id: string,
  before: Map<string, string>,
) {
  const after = await definitionRecommendationAudience(tx, kind, id);
  const changed: string[] = [],
    invalidated: string[] = [];
  for (const membershipId of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(membershipId) === after.get(membershipId)) continue;
    (before.has(membershipId) ? invalidated : changed).push(membershipId);
  }
  for (const [membershipIds, invalidate] of [
    [changed, false],
    [invalidated, true],
  ] as const) {
    if (membershipIds.length)
      await recordRecommendationChange(tx, {
        id: randomUUID(),
        kind: 'definition',
        sourceId: id,
        membershipIds,
        invalidate,
      });
  }
}
