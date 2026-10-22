import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { fixture as integrationFixture } from '../../integrations/test/fixture.mjs';
import { operationFixture, cardId } from '../../atlassian/test/operation-fixture.mjs';
import { createChatTools } from '../src/tools.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('GitHub discovery retains integration generation and source grants without lending human access to a named agent', async t => {
  const f = await integrationFixture();
  t.after(() => f.close());
  const { workspaceId, actor: admin, creator, member, input, runtime, service } = f;
  await service.create(workspaceId, creator, input);
  await service.setGrants(workspaceId, creator, input.id, {
    expectedGrantsVersion: 1,
    grants: [{ teamId: f.teamId, permissions: ['read', 'use'] }],
    sourceGrants: [{ teamId: f.teamId, sourceId: input.repositories[0].id }],
    sourcePersonGrants: [f.sourceGrant(creator)],
  });
  const tools = createChatTools(runtime, { integrations: service });
  const result = await tools.invokeWithSources(
    { workspaceId, actor: member, callId: randomUUID() },
    { tool: 'github.issue.read', integrationId: input.id, sourceId: input.repositories[0].id, issueNumber: 17 },
  );
  assert.equal(result.result.title, 'Issue title');
  assert.deepEqual(result.sources, [
    {
      kind: 'github-source',
      integrationId: input.id,
      sourceId: input.repositories[0].id,
      generation: 1,
      grantsVersion: 2,
    },
  ]);
  const check = (human, sources, runId) =>
    runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await requireDraftSources(tx, human, sources, new Set(), runId);
    });
  await check(member, result.sources);
  await check(creator, result.sources);
  await assert.rejects(check(admin, result.sources), AccessDenied);
  for (const human of [member, creator]) await assert.rejects(check(human, result.sources, randomUUID()), AccessDenied);
  const legacy = [{ kind: 'integration-source', integrationId: input.id, sourceId: input.repositories[0].id }];
  await check(member, legacy);
  await assert.rejects(check(creator, legacy, randomUUID()), AccessDenied);
  await service.rotate(workspaceId, creator, input.id, { expectedGeneration: 1, token: 'new-synthetic-token' });
  await assert.rejects(check(member, result.sources), AccessDenied);
  await assert.rejects(check(creator, result.sources), AccessDenied);
  const current = await tools.invokeWithSources(
    { workspaceId, actor: member, callId: randomUUID() },
    { tool: 'github.issue.read', integrationId: input.id, sourceId: input.repositories[0].id, issueNumber: 17 },
  );
  assert.equal(current.sources[0].generation, 2);
  await f.owner.query(`DELETE FROM ${f.table('tf_integration_source_grants')} WHERE source_id=$1`, [
    input.repositories[0].id,
  ]);
  await assert.rejects(check(member, current.sources), AccessDenied);
  await check(creator, current.sources);
});

test('Atlassian discovery retains account identity, incarnation and binding without impersonating the human', async t => {
  const f = await operationFixture();
  t.after(() => f.close());
  const actor = { kind: 'human', ...f.member },
    admin = { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId };
  const result = await createChatTools(f.runtime, { atlassian: f.operations }).invokeWithSources(
    { workspaceId: f.one.id, actor, callId: randomUUID() },
    { tool: 'atlassian.read', sourceId: f.source.id, operation: { kind: 'card.read', cardId } },
  );
  assert.equal(result.sources[0].accountId, f.accountId);
  assert.equal(result.sources[0].sourceId, f.source.id);
  const check = (human, sources, runId) =>
    f.runtime.transaction(f.one.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await requireDraftSources(tx, human, sources, new Set(), runId);
    });
  await check(actor, result.sources);
  await assert.rejects(check(admin, result.sources), AccessDenied);
  await assert.rejects(check(actor, result.sources, randomUUID()), AccessDenied);
  await f.db.platform.query(`UPDATE ${f.table('tf_atlassian_accounts')} SET generation=generation+1 WHERE id=$1`, [
    f.accountId,
  ]);
  await assert.rejects(check(actor, result.sources), AccessDenied);
  const current = await createChatTools(f.runtime, { atlassian: f.operations }).invokeWithSources(
    { workspaceId: f.one.id, actor, callId: randomUUID() },
    { tool: 'atlassian.sources' },
  );
  assert.equal(current.result.sources[0].id, f.source.id);
  await check(actor, current.sources);
  await f.db.platform.query(
    `UPDATE ${f.table('tf_atlassian_sources')} SET binding=jsonb_set(binding,'{boardId}','"444444444444444444444444"') WHERE id=$1`,
    [f.source.id],
  );
  await assert.rejects(check(actor, current.sources), AccessDenied);
});
