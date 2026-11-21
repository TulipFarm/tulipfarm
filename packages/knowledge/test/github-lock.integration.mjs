import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { lockAuthorization } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createGitHubKnowledge } from '../dist/index.js';

const blocked = () => new Promise(resolve => setTimeout(resolve, 5000, 'blocked').unref());

// A workspace with one active GitHub source whose provider stalls on its first call while `hold` is set.
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
  const accountId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
    [accountId, ws.membershipId, { id: '101', login: 'owner' }],
  );
  const binding = { accountId, accountGeneration: 1, githubUserId: '101', login: 'owner' };
  const repository = { repositoryId: '1', fullName: 'acme/repo-1', visibility: 'private', title: 'acme/repo-1' };
  const state = { hold: null, calls: 0, reached: null, reach: null };
  const stall = async () => {
    if (!state.hold) return;
    state.calls++;
    state.reach?.();
    await state.hold;
  };
  const provider = {
    discover: async () => {
      await stall();
      return { binding, items: [repository], nextCursor: null };
    },
    inspectSelection: async () => ({ binding, title: 'Chosen', repositories: [repository] }),
    access: async () => ({ ...repository, accessedAt: new Date().toISOString(), readable: true }),
    list: async () => {
      await stall();
      return { observations: [], nextCursor: null };
    },
    read: async () => assert.fail('no documents are listed'),
  };
  const github = createGitHubKnowledge({ runtime, provider, sync: { sleep: async () => {} } });
  const { sourceId } = await github.configure(ws.id, ws.userId, {
    commandId: randomUUID(),
    accountId,
    selection: { scope: 'all', repositories: [], kinds: ['docs'] },
    memberIds: [],
  });
  const row = async () =>
    (
      await db.platform.query(`SELECT generation,lease_token FROM ${table('github_sources')} WHERE source_id=$1`, [
        sourceId,
      ])
    ).rows[0];
  const next = async () => {
    await db.platform.query(
      `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
      [sourceId],
    );
    return (await github.due(ws.id)).find(w => w.sourceId === sourceId);
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
  return { db, ws, table, runtime, github, sourceId, row, next, state, stalled, close };
}

test('a sync claim and the due sweep share the workspace lock with other readers', { timeout: 120000 }, async () => {
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
      assert.ok(
        Array.isArray(await Promise.race([s.github.due(s.ws.id), blocked()])),
        'due is not held up by a reader',
      );
      const pass = s.github.process(work);
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

test('two claims on one source: exactly one wins', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    const work = await s.next();
    const release = s.stalled();
    const first = s.github.process(work);
    const second = s.github.process(work);
    const early = await Promise.race([first, second, blocked()]);
    assert.deepEqual(early, { disposition: 'busy' });
    await s.state.reached;
    assert.equal(s.state.calls, 1, 'only the winning claim ran a pass');
    release();
    const settled = await Promise.all([first, second]);
    assert.equal(settled.filter(r => r.disposition === 'busy').length, 1);
  } finally {
    await s.close();
  }
});

test('a worker whose lease was taken over is refused', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    const work = await s.next();
    const release = s.stalled();
    const stale = s.github.process(work);
    await s.state.reached;
    await s.db.platform.query(
      `UPDATE ${s.table('github_sources')} SET lease_until=clock_timestamp()-interval '1 second' WHERE source_id=$1`,
      [s.sourceId],
    );
    await s.github.due(s.ws.id);
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

test('member reads share the workspace lock with other readers', { timeout: 120000 }, async () => {
  const s = await setup();
  try {
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
      const listed = await Promise.race([s.github.list(s.ws.id, s.ws.userId), blocked()]);
      assert.deepEqual(
        listed.items?.map(item => item.sourceId),
        [s.sourceId],
        'listing sources is not held up by a reader',
      );
      const documents = await Promise.race([s.github.listDocuments(s.ws.id, s.ws.userId, s.sourceId), blocked()]);
      assert.deepEqual(documents.items, [], 'listing documents is not held up by a reader');
    } finally {
      free();
      await reader;
    }
  } finally {
    await s.close();
  }
});
