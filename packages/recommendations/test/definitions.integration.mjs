import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createWorkflows } from '../../workflows/src/service.ts';
import { activate } from '../../workflows/test/commands.fixture.mjs';
import { createWorkspaceSkills } from '../../agents/src/workspace-skills.ts';
import { createAgentStore } from '../../agents/src/store.ts';
import { savedTaskAgent } from '../../agents/test/task-fixture.mjs';

const eventsFor = (f, id) => async () =>
  (
    await f.db.platform.query(
      `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE source_id=$1 ORDER BY created_at,id`,
      [id],
    )
  ).rows;
const snapshot = (f, membershipId) =>
  f.db.platform.query(
    `INSERT INTO ${f.table('tf_recommendation_snapshots')}(membership_id,fingerprint,items,policy)
   VALUES($1,$2,'[]','event-driven-v1') ON CONFLICT(membership_id) DO NOTHING`,
    [membershipId, 'a'.repeat(64)],
  );
const hasSnapshot = async (f, membershipId) =>
  !!(
    await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_recommendation_snapshots')} WHERE membership_id=$1`, [
      membershipId,
    ])
  ).rowCount;

test(
  'Workflow drafts and runs do not trigger; active replacement and grants invalidate only readers',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const { id: workspaceId, userId, membershipId } = f.workspace;
      const reader = randomUUID(),
        outsider = randomUUID(),
        id = randomUUID(),
        revision = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,'reader','member'),($2,'outsider','member')`,
        [reader, outsider],
      );
      const service = createWorkflows(f.runtime),
        events = eventsFor(f, id);
      const definition = {
        version: 1,
        name: 'Prepare a checklist',
        trigger: { kind: 'manual' },
        steps: [{ id: 'copy', kind: 'transform', fields: { text: { kind: 'input', path: ['text'] } } }],
      };
      await service.save(workspaceId, userId, id, { revision, expectedRevision: null, definition });
      const share = permissions =>
        service.share(workspaceId, userId, id, { principal: { kind: 'person', id: reader }, permissions });
      await share(['read', 'invoke']);
      await share(['read', 'invoke']);
      assert.equal((await events()).length, 0, 'draft saves and sharing are excluded');
      await activate(service, workspaceId, userId, id, revision, true);
      assert.deepEqual((await events())[0], { membership_ids: [membershipId, reader].sort(), invalidate: false });
      await activate(service, workspaceId, userId, id, revision, true);
      assert.equal((await events()).length, 1, 'an identical active save is not a change');
      const started = await service.start(workspaceId, userId, id, {
        requestId: randomUUID(),
        input: { text: 'hello' },
      });
      await service.advance({ workspaceId, runId: started.runId });
      await service.advance({ workspaceId, runId: started.runId });
      assert.equal((await events()).length, 1, 'run completion is not a definition change');
      for (const member of [membershipId, reader, outsider]) await snapshot(f, member);
      const next = randomUUID();
      await service.save(workspaceId, userId, id, {
        revision: next,
        expectedRevision: revision,
        definition: { ...definition, name: 'Prepare a new checklist' },
      });
      assert.equal((await events()).length, 1, 'a draft over an active revision remains excluded');
      await activate(service, workspaceId, userId, id, next, true);
      assert.equal((await events()).at(-1).invalidate, true);
      assert.equal(await hasSnapshot(f, membershipId), false);
      assert.equal(await hasSnapshot(f, reader), false);
      assert.equal(await hasSnapshot(f, outsider), true);
      await snapshot(f, reader);
      await share([]);
      assert.deepEqual((await events()).at(-1), { membership_ids: [reader], invalidate: true });
      assert.equal(await hasSnapshot(f, reader), false);
      await share([]);
      assert.equal((await events()).length, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  'skill review, lifecycle and effective sharing emit; draft and repeated commands do not',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const { id: workspaceId, userId, membershipId } = f.workspace;
      const skills = createWorkspaceSkills(f.runtime),
        id = randomUUID(),
        events = eventsFor(f, id);
      const input = {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: { name: 'Checklist', description: 'Prepare a checklist.', instructions: 'Ask before edits.' },
      };
      const draft = await skills.save(workspaceId, userId, id, input);
      await skills.save(workspaceId, userId, id, input);
      assert.equal((await events()).length, 0);
      const review = { requestId: randomUUID(), expectedVersion: 1, revision: draft.savedRevision };
      await skills.review(workspaceId, userId, id, review);
      await skills.review(workspaceId, userId, id, review);
      assert.deepEqual(await events(), [{ membership_ids: [membershipId], invalidate: false }]);
      const edited = await skills.save(workspaceId, userId, id, {
        ...input,
        requestId: randomUUID(),
        expectedVersion: 2,
        definition: { ...input.definition, instructions: 'Ask before all edits.' },
      });
      assert.equal((await events()).length, 1);
      await snapshot(f, membershipId);
      await skills.review(workspaceId, userId, id, {
        requestId: randomUUID(),
        expectedVersion: 3,
        revision: edited.savedRevision,
      });
      assert.equal((await events()).at(-1).invalidate, true);
      assert.equal(await hasSnapshot(f, membershipId), false);
      const disable = { requestId: randomUUID(), expectedVersion: 4, enabled: false };
      await skills.setEnabled(workspaceId, userId, id, disable);
      await skills.setEnabled(workspaceId, userId, id, disable);
      assert.equal((await events()).length, 3);
      await skills.setEnabled(workspaceId, userId, id, { requestId: randomUUID(), expectedVersion: 5, enabled: true });
      assert.equal((await events()).length, 4);
      await skills.share(workspaceId, userId, id, {
        version: 6,
        grants: [],
        personGrants: [{ membershipId, permissions: ['read', 'use', 'manage'] }],
      });
      assert.equal((await events()).length, 4, 'same effective permissions are excluded');
    } finally {
      await f.close();
    }
  },
);

test('agent activation sets compare semantic authority, not activation receipts', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    const { id: workspaceId, userId, membershipId } = f.workspace;
    const agent = await savedTaskAgent(f.db, f.workspace, f.runtime, userId, membershipId);
    const store = createAgentStore(f.runtime),
      events = eventsFor(f, agent.agentId);
    const actor = { kind: 'human', userId, membershipId };
    assert.equal((await events()).length, 1);
    const request = { agentId: agent.agentId, revision: agent.revision, scope: [], requestId: randomUUID() };
    const duplicate = await store.activate(workspaceId, actor, request);
    await store.activate(workspaceId, actor, request);
    assert.equal((await events()).length, 1, 'duplicate authority and command replay are excluded');
    await store.revokeActivation(workspaceId, actor, { agentId: agent.agentId, activationId: duplicate.activationId });
    assert.equal((await events()).length, 1, 'another identical active receipt still supplies the capability');
    await snapshot(f, membershipId);
    await store.revokeActivation(workspaceId, actor, { agentId: agent.agentId, activationId: agent.activationId });
    assert.equal((await events()).length, 2);
    assert.equal(await hasSnapshot(f, membershipId), false);
    await store.revokeActivation(workspaceId, actor, { agentId: agent.agentId, activationId: agent.activationId });
    assert.equal((await events()).length, 2);
  } finally {
    await f.close();
  }
});
