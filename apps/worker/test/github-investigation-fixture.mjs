import { randomUUID } from 'node:crypto';
import { createIntegrationService } from '@tulipfarm/integrations';

export async function addInvestigationIntegration(f, { id = randomUUID(), keyring = f.keyring } = {}) {
  const actor = { kind: 'human', ...f.member },
    teamId = randomUUID(),
    sourceId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Investigation team')`, [teamId]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    actor.membershipId,
    teamId,
  ]);
  const service = createIntegrationService({ runtime: f.runtime, keyring });
  const input = {
    id,
    name: 'Team investigation',
    owningTeamId: teamId,
    token: 'synthetic-team-token',
    repositories: [{ id: sourceId, owner: 'example', repo: 'web' }],
  };
  await service.create(f.one.id, actor, input);
  const grants = {
    grants: [{ teamId, permissions: ['read', 'use'] }],
    sourceGrants: [],
    investigationGrants: [{ teamId, sourceId, permissions: ['github.code.read'] }],
  };
  await service.setGrants(f.one.id, actor, id, { ...grants, expectedGrantsVersion: 1 });
  return { id, sourceId, teamId, actor, service, grants, choice: { kind: 'team', id, generation: 1 } };
}
