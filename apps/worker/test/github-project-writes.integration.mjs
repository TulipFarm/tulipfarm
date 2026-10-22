import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { githubProjectFixture } from './github-project-fixture.mjs';
import {
  projectOperations,
  projectTarget,
  draftTarget,
} from '../../../packages/github/test/project-provider-fixture.mjs';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const unrelated = {
  kind: 'issue.comment',
  owner: 'octocat',
  repo: 'private',
  issueNumber: 7,
  body: 'Project changes complete.',
};
test('batch receipt reads still reject MCP-derived conversation closure after approval', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[1]]);
    await f.approve(batch);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_conversation_model_sources')} VALUES ($1,1,1,$2)`, [
      batch.snapshot.origin.turnId,
      JSON.stringify([{ kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 }]),
    ]);
    await assert.rejects(f.read(batch), /Resource not found/);
    await assert.rejects(f.execute(batch), /Resource not found/);
    assert.deepEqual(await f.status(batch), {
      id: batch.snapshot.id,
      decision: 'approve',
      actions: [{ ordinal: 0, status: 'unattempted' }],
    });
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
for (const mode of [
  'owner-null',
  'project-null',
  'content-null',
  'personal-rights',
  'organization-rights',
  'source-revoked',
])
  test(`approval list isolates ${mode} and restores exact details after recovery`, async () => {
    const f = await githubProjectFixture(),
      app = Fastify();
    try {
      const other = await f.propose([unrelated]);
      const operation =
        mode === 'personal-rights'
          ? { kind: 'project.delete', ...projectTarget }
          : mode === 'organization-rights'
            ? {
                kind: 'project.delete',
                owner: 'company',
                ownerType: 'organization',
                ownerNodeId: 'O_9',
                projectId: 'P_2',
                projectNumber: 2,
              }
            : mode === 'content-null'
              ? projectOperations[8]
              : projectOperations[1];
      const batch = await f.propose(
        [operation],
        mode === 'source-revoked' ? [{ kind: 'repository.read', owner: 'outside', repo: 'source' }] : [],
      );
      if (mode.endsWith('-rights')) {
        await f.approve(batch);
        await f.worker(batch);
      }
      registerGitHubBatches(app, {
        auth: { api: { getSession: async () => ({ user: { id: f.member.userId } }) } },
        batches: f.batches,
        decide: async () => assert.fail('No approval write'),
      });
      const url = `/workspaces/${f.one.id}/github/chats/${f.chatId}/batches`;
      const project = f.projects.get('P_1'),
        content = f.contents.get('I_7');
      if (mode === 'owner-null') f.state.deny = true;
      if (mode === 'project-null') f.projects.delete('P_1');
      if (mode === 'content-null') f.contents.delete('I_7');
      if (mode === 'personal-rights') f.user.isViewer = false;
      if (mode === 'organization-rights') f.organization.viewerCanAdminister = false;
      if (mode === 'source-revoked') f.state.outsideDeny = true;
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      const views = response.json().batches;
      assert.equal(views.length, 2);
      assert.deepEqual(
        views.find(view => view.id === batch.snapshot.id),
        {
          id: batch.snapshot.id,
          decision: mode.endsWith('-rights') ? 'approve' : null,
          actions: [{ ordinal: 0, status: mode.endsWith('-rights') ? 'succeeded' : 'unattempted' }],
        },
      );
      assert.deepEqual(views.find(view => view.snapshot?.id === other.snapshot.id).snapshot, other.snapshot);
      f.state.deny = false;
      f.state.outsideDeny = false;
      f.user.isViewer = true;
      f.organization.viewerCanAdminister = true;
      if (mode === 'project-null') f.projects.set('P_1', project);
      if (mode === 'content-null') f.contents.set('I_7', content);
      const recovered = await app.inject({ method: 'GET', url });
      assert.equal(recovered.statusCode, 200);
      assert.deepEqual(
        recovered.json().batches.find(view => view.snapshot?.id === batch.snapshot.id).snapshot,
        batch.snapshot,
      );
      assert.equal(f.effects.length, mode.endsWith('-rights') ? 1 : 0);
    } finally {
      await app.close();
      await f.close();
    }
  });
const exactValues = [
  ['TEXT', { text: 'Approved' }, { text: 'Different' }, 'Text'],
  ['NUMBER', { number: 12.5 }, { number: 12.6 }, 'Number'],
  ['DATE', { date: '2026-10-02' }, { date: '2026-10-03' }, 'Date'],
  ['SINGLE_SELECT', { singleSelectOptionId: 'OPT_1' }, { optionId: 'OPT_2' }, 'SingleSelect'],
  ['ITERATION', { iterationId: 'ITER_1' }, { iterationId: 'ITER_2' }, 'Iteration'],
  [
    'MULTI_SELECT',
    { multiSelectOptionIds: ['OPT_1', 'OPT_2'] },
    { options: [{ id: 'OPT_1' }, { id: 'OPT_1' }] },
    'MultiSelect',
  ],
];
for (const [dataType, expected, wrong, type] of exactValues)
  test(`wrong exact ${dataType} acknowledgement remains unknown and stops the registered worker`, async () => {
    const f = await githubProjectFixture();
    try {
      const field = f.fields.get(`F_${dataType}`);
      if (dataType === 'MULTI_SELECT')
        field.multiSelectOptions.push({ id: 'OPT_2', name: 'Second', color: 'GREEN', description: '' });
      const batch = await f.propose([
        { kind: 'project.value-set', ...draftTarget, fieldId: field.id, value: { dataType, ...expected } },
        unrelated,
      ]);
      await f.approve(batch);
      f.items.get('PI_1').fieldValues = () => ({
        nodes: [{ __typename: `ProjectV2ItemField${type}Value`, field, ...wrong }],
        pageInfo: { hasNextPage: false },
      });
      await f.worker(batch);
      assert.deepEqual(f.schemaErrors, []);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      assert.deepEqual(f.items.get('PI_1').values.get(field.id), expected);
      await f.reconcile(batch);
      await f.execute(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        ['unknown', 'unattempted'],
      );
      assert.deepEqual(
        f.effects.map(effect => effect.name),
        ['updateProjectV2ItemFieldValue'],
      );
    } finally {
      await f.close();
    }
  });
test('reordered unique multi-select acknowledgement confirms exact values and permits the next effect', async () => {
  const f = await githubProjectFixture();
  try {
    const field = f.fields.get('F_MULTI_SELECT');
    field.multiSelectOptions.push({ id: 'OPT_2', name: 'Second', color: 'GREEN', description: '' });
    const batch = await f.propose([
      {
        kind: 'project.value-set',
        ...draftTarget,
        fieldId: field.id,
        value: { dataType: 'MULTI_SELECT', multiSelectOptionIds: ['OPT_1', 'OPT_2'] },
      },
      unrelated,
    ]);
    await f.approve(batch);
    f.items.get('PI_1').fieldValues = () => ({
      nodes: [{ __typename: 'ProjectV2ItemFieldMultiSelectValue', field, options: [{ id: 'OPT_2' }, { id: 'OPT_1' }] }],
      pageInfo: { hasNextPage: false },
    });
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    assert.deepEqual(
      f.effects.map(effect => effect.name),
      ['updateProjectV2ItemFieldValue', 'issueComment'],
    );
    assert.deepEqual(f.schemaErrors, []);
  } finally {
    await f.close();
  }
});
for (const wrongType of [false, true])
  test(`explicit-null clear ${wrongType ? 'wrong type stops' : 'matching type continues'} the registered worker`, async () => {
    const f = await githubProjectFixture();
    try {
      const batch = await f.propose([projectOperations[15], unrelated]);
      await f.approve(batch);
      const field = f.fields.get('F_TEXT');
      f.items.get('PI_1').fieldValues = () => ({
        nodes: [
          wrongType
            ? { __typename: 'ProjectV2ItemFieldNumberValue', field, number: null }
            : { __typename: 'ProjectV2ItemFieldTextValue', field, text: null },
        ],
        pageInfo: { hasNextPage: false },
      });
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(action => action.status),
        wrongType ? ['unknown', 'unattempted'] : ['succeeded', 'succeeded'],
      );
      await f.reconcile(batch);
      await f.execute(batch);
      assert.deepEqual(
        f.effects.map(effect => effect.name),
        wrongType ? ['clearProjectV2ItemFieldValue'] : ['clearProjectV2ItemFieldValue', 'issueComment'],
      );
      assert.deepEqual(f.schemaErrors, []);
    } finally {
      await f.close();
    }
  });
for (const operation of projectOperations)
  test(`registered ${operation.kind} requires exact approval and persists ordered receipts without replay`, async () => {
    const f = await githubProjectFixture();
    try {
      const batch = await f.propose([operation, unrelated]);
      await assert.rejects(f.execute(batch), /batch-approval-required/);
      assert.equal(f.effects.length, 0);
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(a => a.status),
        ['succeeded', 'succeeded'],
      );
      assert.equal(f.effects.at(-1).name, 'issueComment');
      assert.deepEqual(f.schemaErrors, []);
      await f.worker(batch);
      await f.execute(batch);
      assert.equal(f.effects.length, 2);
    } finally {
      await f.close();
    }
  });
for (const change of ['generation', 'selection', 'turn-generation', 'cancel', 'expiry'])
  test(`Projects ${change} fencing stops approved writes`, async () => {
    const f = await githubProjectFixture();
    try {
      const batch = await f.propose([projectOperations[0]]);
      await f.approve(batch);
      if (change === 'generation')
        await f.options.accounts.reconnect(f.one.id, f.member.userId, 'new-session', f.accountId);
      if (change === 'selection')
        await f.db.platform.query(`UPDATE ${f.table('tf_github_chat_selection')} SET version=version+1`);
      if (change === 'turn-generation')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
          [batch.snapshot.origin.turnId],
        );
      if (change === 'cancel')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled',response_message_id=NULL,lease_until=NULL WHERE id=$1`,
          [batch.snapshot.origin.turnId],
        );
      if (change === 'expiry')
        await f.db.platform.query(
          `UPDATE ${f.table('tf_github_batches')} SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
          [batch.snapshot.id],
        );
      await assert.rejects(f.execute(batch));
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });
test('protected Projects approval and concurrent executors cannot create duplicate effects', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[0]]);
    await assert.rejects(
      f.runtime.transaction(f.one.id, commonCompatibility, tx =>
        tx.client.query(
          `INSERT INTO ${f.table('tf_github_batch_decisions')} (batch_id,digest,decision) VALUES ($1,$2,'approve')`,
          [batch.snapshot.id, batch.digest],
        ),
      ),
      /permission denied/,
    );
    await f.approve(batch);
    await Promise.allSettled([f.execute(batch), f.execute(batch)]);
    assert.equal((await f.read(batch)).actions[0].status, 'succeeded');
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
for (const operation of projectOperations.filter(op => op.kind !== 'project.draft-create'))
  test(`lost ${operation.kind} stays unknown without replay and leaves reads available`, async () => {
    const f = await githubProjectFixture();
    try {
      const batch = await f.propose([operation, unrelated]);
      await f.approve(batch);
      f.state.lose = true;
      await f.worker(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      await f.execute(batch).catch(() => {});
      await f.reconcileStatus(batch);
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      assert.equal(f.effects.length, 1);
      const sent = await f.store.send(f.one.id, f.member.userId, f.chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        model: 'claude-sonnet',
        parts: [{ kind: 'text', text: 'Read and replacement intent' }],
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_turns')} SET status='processing',lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1`,
        [sent.turnId],
      );
      const read = await f.reads.read(
        f.one.id,
        { kind: 'human', ...f.member },
        { conversationId: f.chatId, turnId: sent.turnId },
        { kind: 'repository.read', owner: 'octocat', repo: 'private' },
      );
      assert.equal(read.result.data.id, 42);
      await assert.rejects(
        f.batches.propose(
          f.one.id,
          { kind: 'human', ...f.member },
          randomUUID(),
          { conversationId: f.chatId, turnId: sent.turnId, sources: [] },
          { actions: [unrelated] },
        ),
        /batch-unresolved/,
      );
    } finally {
      await f.close();
    }
  });
for (const kind of ['project.read', 'project.fields', 'project.items', 'project.item', 'project.item-field'])
  test(`own deletion preserves ${kind} batch receipts without a vanished shared snapshot deadlock`, async () => {
    const f = await githubProjectFixture();
    try {
      const operation = {
        kind,
        owner: 'octocat',
        ownerType: 'user',
        number: 1,
        ...(['project.item', 'project.item-field'].includes(kind) ? { itemId: 'PI_1' } : {}),
        ...(kind === 'project.item-field' ? { fieldName: 'Notes' } : {}),
      };
      const batch = await f.propose(
        [
          { kind: 'project.item-delete', ...draftTarget },
          { kind: 'project.close', ...projectTarget },
          { kind: 'project.delete', ...projectTarget },
          unrelated,
        ],
        [operation, { kind: 'repository.read', owner: 'outside', repo: 'source' }],
      );
      assert.equal(
        batch.snapshot.sources.some(s => s.proof?.projectIdentity?.projectId === 'P_1'),
        true,
      );
      await f.approve(batch);
      await f.worker(batch);
      assert.deepEqual(
        (await f.read(batch)).actions.map(a => a.status),
        ['succeeded', 'succeeded', 'succeeded', 'succeeded'],
      );
      assert.equal(f.projects.has('P_1'), false);
      assert.equal(f.items.has('PI_1'), false);
      f.state.outsideDeny = true;
      await assert.rejects(f.read(batch));
      assert.equal('snapshot' in (await f.status(batch)), false);
      f.state.outsideDeny = false;
      assert.deepEqual((await f.read(batch)).snapshot, batch.snapshot);
      if (kind === 'project.items') {
        f.state.repositoryDeny = true;
        await assert.rejects(f.read(batch));
      } else {
        f.user.isViewer = false;
        await assert.rejects(f.read(batch));
      }
    } finally {
      await f.close();
    }
  });
test('lost draft creation recovers only exact content creator marker and project', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[9], unrelated]);
    await f.approve(batch);
    f.state.lose = true;
    await f.worker(batch);
    const draft = f.contents.get('DI_NEW'),
      body = draft.body;
    draft.body = 'No marker';
    await f.reconcile(batch);
    assert.equal((await f.status(batch)).actions[0].status, 'unknown');
    draft.body = body;
    draft.creator = { __typename: 'User', databaseId: 999 };
    await f.reconcile(batch);
    assert.equal((await f.status(batch)).actions[0].status, 'unknown');
    draft.creator = f.user;
    const view = await f.reconcile(batch);
    assert.equal(view.actions[0].status, 'succeeded');
    assert.equal(view.actions[0].result.contentId, 'DI_NEW');
    f.state.lose = false;
    await f.execute(batch);
    await f.execute(batch);
    assert.equal(f.effects.length, 2);
  } finally {
    await f.close();
  }
});
for (const mode of ['partial', 'malformed'])
  test(`${mode} GraphQL response with an effect stops remaining actions`, async () => {
    const f = await githubProjectFixture();
    try {
      const batch = await f.propose([projectOperations[1], unrelated]);
      await f.approve(batch);
      f.state[mode] = true;
      await f.worker(batch);
      assert.equal(f.projects.get('P_1').title, 'Updated plan');
      assert.deepEqual(
        (await f.status(batch)).actions.map(a => a.status),
        ['unknown', 'unattempted'],
      );
      await f.reconcile(batch);
      await f.execute(batch);
      assert.equal(f.effects.length, 1);
    } finally {
      await f.close();
    }
  });
test('current update permission loss rejects writes but preserves readable approval details', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[1], unrelated]);
    await f.approve(batch);
    f.projects.get('P_1').viewerCanUpdate = false;
    await f.worker(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(a => a.status),
      ['rejected', 'unattempted'],
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});
test('deferred receipt failure leaves durable unknown and never repeats a project mutation', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[1], unrelated]);
    await f.approve(batch);
    await f.db.platform.query(
      `CREATE FUNCTION ${f.table('fail_project_receipt')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`,
    );
    await f.db.platform.query(
      `CREATE CONSTRAINT TRIGGER fail_project_receipt AFTER UPDATE ON ${f.table('tf_github_action_receipts')} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${f.table('fail_project_receipt')}()`,
    );
    await f.worker(batch);
    assert.deepEqual(
      (await f.status(batch)).actions.map(a => a.status),
      ['unknown', 'unattempted'],
    );
    assert.equal(f.projects.get('P_1').title, 'Updated plan');
    await f.db.platform.query(`DROP TRIGGER fail_project_receipt ON ${f.table('tf_github_action_receipts')}`);
    await f.reconcile(batch);
    await f.execute(batch);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});
test('owner discovery permits creation from an empty list and source lists retain original projects across own deletion', async () => {
  const f = await githubProjectFixture();
  try {
    const list = { kind: 'project.list', owner: 'octocat', ownerType: 'user' };
    const first = await f.propose([{ kind: 'project.delete', ...projectTarget }, unrelated], [list]);
    assert.equal(
      first.snapshot.sources.some(source => source.proof?.projectList?.projects[0]?.projectId === 'P_1'),
      true,
    );
    await f.approve(first);
    await f.execute(first);
    assert.deepEqual(
      (await f.read(first)).actions.map(action => action.status),
      ['succeeded', 'succeeded'],
    );
    await f.freshChat();
    const next = await f.propose([projectOperations[0]], [list]);
    assert.deepEqual(next.snapshot.sources.find(source => source.proof?.projectList)?.proof.projectList, {
      ownerNodeId: 'U_123',
      projects: [],
    });
    await f.approve(next);
    await f.execute(next);
    assert.equal(f.projects.get('P_3').title, 'Delivery plan');
    await f.freshChat();
    const later = await f.propose([unrelated], [list]);
    f.projects.delete('P_3');
    await assert.rejects(f.read(later));
    assert.equal('snapshot' in (await f.status(later)), false);
  } finally {
    await f.close();
  }
});
test('organization deletion reveals full receipts only with current owner administration and keeps status otherwise', async () => {
  const f = await githubProjectFixture();
  try {
    const operation = {
      kind: 'project.delete',
      owner: 'company',
      ownerType: 'organization',
      ownerNodeId: 'O_9',
      projectId: 'P_2',
      projectNumber: 2,
    };
    const batch = await f.propose(
      [operation, unrelated],
      [{ kind: 'project.read', owner: 'company', ownerType: 'organization', number: 2 }],
    );
    await f.approve(batch);
    await f.execute(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(a => a.status),
      ['succeeded', 'succeeded'],
    );
    f.organization.viewerCanAdminister = false;
    await assert.rejects(f.read(batch));
    assert.equal('snapshot' in (await f.status(batch)), false);
    f.organization.viewerCanAdminister = true;
    assert.equal((await f.read(batch)).actions[0].result.deleted, true);
  } finally {
    await f.close();
  }
});
test('linked repository revocation hides target details and stops dispatch independently of project rights', async () => {
  const f = await githubProjectFixture();
  try {
    const batch = await f.propose([projectOperations[8], unrelated]);
    await f.approve(batch);
    f.state.repositoryDeny = true;
    await assert.rejects(f.read(batch));
    await assert.rejects(f.execute(batch));
    assert.equal(f.effects.length, 0);
    f.state.repositoryDeny = false;
    await f.execute(batch);
    assert.deepEqual(
      (await f.read(batch)).actions.map(a => a.status),
      ['succeeded', 'succeeded'],
    );
  } finally {
    await f.close();
  }
});
