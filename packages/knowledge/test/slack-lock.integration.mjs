import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { lockAuthorization } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createSlackKnowledge } from '../dist/index.js';

const blocked = () => new Promise(resolve => setTimeout(resolve, 5000, 'blocked').unref());

// A workspace with one active Slack source whose provider stalls on its first listing while `hold` is set.
async function setup() {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const ws = await db.create(await workspaceTableMigrations());
  const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    connectionsPerPool: 4,
    databaseConnectionBudget: 40,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
  });
  const installationId = randomUUID();
  const identityId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'AAPP','TTEAM','UBOT',1,'active','{chat:write}','{}',0)`,
    [installationId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UOWNER',$3,$4,'authorized','{}','{channels:history,channels:read}')`,
    [identityId, installationId, ws.userId, ws.membershipId],
  );
  const binding = { installationId, installationGeneration: 1, identityId, slackUserId: 'UOWNER', teamId: 'TTEAM' };
  const conversation = { conversationId: 'CGENERAL', kind: 'public', title: '#general' };
  const state = { hold: null, calls: 0, reached: null, reach: null };
  const provider = {
    discover: async () => ({ binding, items: [], nextCursor: null }),
    inspectSelection: async () => ({ binding, title: 'Chosen', conversations: [conversation] }),
    access: async () => ({ ...conversation, accessedAt: new Date().toISOString(), member: true, archived: false }),
    list: async () => {
      if (state.hold) {
        state.calls++;
        state.reach?.();
        await state.hold;
      }
      return { observations: [], nextCursor: null };
    },
    read: async () => assert.fail('no threads are listed'),
  };
  const slack = createSlackKnowledge({ runtime, provider });
  const { sourceId } = await slack.configure(ws.id, ws.userId, {
    commandId: randomUUID(),
    selection: {
      kind: 'channels',
      conversationIds: ['CGENERAL'],
      after: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    },
    memberIds: [],
  });
  const row = async () =>
    (
      await db.platform.query(`SELECT generation,lease_token FROM ${table('slack_sources')} WHERE source_id=$1`, [
        sourceId,
      ])
    ).rows[0];
  const next = async () => {
    await db.platform.query(
      `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
      [sourceId],
    );
    return (await slack.due(ws.id)).find(w => w.sourceId === sourceId);
  };
  const stalled = () => {
    let release;
    state.hold = new Promise(resolve => (release = resolve));
    state.reached = new Promise(resolve => (state.reach = resolve));
    return () => {
      state.hold = null;
      release();
    };
  };
  const close = async () => {
    await runtime.close();
    await db.close();
  };
  return { db, ws, table, runtime, slack, sourceId, row, next, state, stalled, close };
}

test('a Slack claim and the due sweep share the workspace lock with other readers', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    const work = await s.next();
    assert.ok(work);
    const release = s.stalled();
    let free, held;
    const locked = new Promise(resolve => (held = resolve)),
      done = new Promise(resolve => (free = resolve));
    const reader = s.runtime.transaction(s.ws.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      held();
      await done;
    });
    await locked;
    try {
      assert.ok(Array.isArray(await Promise.race([s.slack.due(s.ws.id), blocked()])), 'due is not held up by a reader');
      const pass = s.slack.process(work);
      const leased = async () => {
        while (!(await s.row()).lease_token) await new Promise(resolve => setTimeout(resolve, 50));
        return 'claimed';
      };
      assert.equal(await Promise.race([leased(), blocked()]), 'claimed', 'the claim is not held up by a reader');
      free();
      await reader;
      release();
      await pass;
    } finally {
      release();
      free();
      await reader;
    }
  } finally {
    await s.close();
  }
});

test('two Slack claims on one source: exactly one wins', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    const work = await s.next();
    const release = s.stalled();
    const first = s.slack.process(work);
    const second = s.slack.process(work);
    assert.deepEqual(await Promise.race([first, second, blocked()]), { disposition: 'busy' });
    await s.state.reached;
    assert.equal(s.state.calls, 1, 'only the winning claim listed');
    release();
    const settled = await Promise.all([first, second]);
    assert.equal(settled.filter(r => r.disposition === 'busy').length, 1);
  } finally {
    await s.close();
  }
});

test('a Slack worker whose lease was taken over is refused and writes nothing', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    const work = await s.next();
    const release = s.stalled();
    const stale = s.slack.process(work);
    await s.state.reached;
    await s.db.platform.query(
      `UPDATE ${s.table('slack_sources')} SET lease_until=clock_timestamp()-interval '1 second' WHERE source_id=$1`,
      [s.sourceId],
    );
    await s.slack.due(s.ws.id);
    const taken = await s.row();
    assert.equal(taken.lease_token, null);
    assert.equal(taken.generation, work.generation + 1);
    release();
    assert.deepEqual(await stale, { disposition: 'stale' });
    assert.deepEqual(await s.row(), taken, 'the refused worker wrote nothing');
  } finally {
    await s.close();
  }
});
