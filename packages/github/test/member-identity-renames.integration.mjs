import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGitHubAccounts, githubCompatibility } from '@tulipfarm/github';
import { observeGitHubHandles } from '@tulipfarm/github/events';
import { listMemberIdentities, resolveMemberIdentities } from '@tulipfarm/integrations/member-identities';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';

async function setupWorkspace() {
  const db = await fixture();
  let runtime;
  try {
    const ws = await db.create();
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        if (id !== ws.id) throw new Error('unknown-workspace');
        return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
      },
    });
    const table = name => qualified(ws.names.schema, name);
    const member = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    const membersTable = (
      await db.platform.query(`SELECT table_id FROM ${table('tf_system_tables')} WHERE kind = 'workspace-members'`)
    ).rows[0].table_id;
    const memberId = (
      await db.platform.query(
        `SELECT member_id FROM ${table('tf_workspace_member_accounts')} WHERE membership_id = $1`,
        [member.membershipId],
      )
    ).rows[0].member_id;
    await db.platform.query(
      `UPDATE ${table('tf_table_identities')} SET live = true WHERE table_id = $1 AND row_id = $2`,
      [membersTable, memberId],
    );
    let profile = { id: 424242, login: 'dhruv-old' };
    const service = createGitHubAccounts({
      runtime,
      configuration: {
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        redirectUri: 'http://127.0.0.1:5218/github/callback',
      },
      keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
      fetcher: async url =>
        url.endsWith('/access_token')
          ? Response.json({ access_token: 'synthetic-access-token', token_type: 'bearer', scope: '' })
          : Response.json(profile),
    });
    const begin = async () => {
      const result = await service.begin(ws.id, member.userId, 'test-session');
      return { ...result, state: new URL(result.url).searchParams.get('state') };
    };
    const complete = started =>
      service.complete({ code: 'fixture-code', state: started.state }, 'test-session', member.userId);
    return {
      db,
      ws,
      member,
      memberId,
      runtime,
      table,
      service,
      begin,
      complete,
      setProfile(next) {
        profile = next;
      },
      async close() {
        await runtime.close();
        await db.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    await db.close();
    throw error;
  }
}

test('GitHub OAuth connect, webhook rename observation, unlinked filtering, out-of-order timestamps and OAuth reconnect', async () => {
  const f = await setupWorkspace();
  try {
    const { memberId } = f;
    const inWorkspace = run => f.runtime.transaction(f.ws.id, githubCompatibility, run);

    f.setProfile({ id: 424242, login: 'dhruv-old' });
    const started = await f.begin();
    await f.complete(started);

    const initialList = await inWorkspace(tx => listMemberIdentities(tx, memberId));
    assert.deepEqual(
      initialList.map(({ provider, scope, externalId, handle, aliases, trust }) => ({
        provider,
        scope,
        externalId,
        handle,
        aliases,
        trust,
      })),
      [
        {
          provider: 'github',
          scope: 'github.com',
          externalId: '424242',
          handle: 'dhruv-old',
          aliases: [],
          trust: 'verified',
        },
      ],
    );

    const initialResolution = await inWorkspace(tx =>
      resolveMemberIdentities(tx, {
        provider: 'github',
        scope: 'github.com',
        externalIds: ['424242'],
        handles: ['dhruv-old'],
      }),
    );
    assert.deepEqual(
      initialResolution.map(({ key, status, memberId: resolvedId, trust }) => ({
        key: key.value,
        status,
        memberId: resolvedId,
        trust,
      })),
      [
        { key: '424242', status: 'resolved', memberId, trust: 'verified' },
        { key: 'dhruv-old', status: 'resolved', memberId, trust: 'verified' },
      ],
    );

    const renameTime = new Date(Date.now() + 60_000);
    const recorded = await inWorkspace(tx =>
      observeGitHubHandles(
        tx,
        {
          sender: { id: 999999, login: 'stranger' },
          pull_request: {
            user: { id: 424242, login: 'dhruv-new' },
          },
        },
        renameTime,
      ),
    );
    assert.equal(recorded, 1);

    const afterRenameList = await inWorkspace(tx => listMemberIdentities(tx, memberId));
    assert.deepEqual(
      { handle: afterRenameList[0].handle, aliases: afterRenameList[0].aliases },
      { handle: 'dhruv-new', aliases: ['dhruv-old'] },
    );

    const afterRenameResolution = await inWorkspace(tx =>
      resolveMemberIdentities(tx, {
        provider: 'github',
        scope: 'github.com',
        externalIds: ['424242', '999999'],
        handles: ['dhruv-new', 'dhruv-old', 'stranger'],
      }),
    );
    assert.deepEqual(
      afterRenameResolution.map(({ key, status, memberId: resolvedId, hits }) => ({
        key: key.value,
        status,
        memberId: resolvedId,
        via: hits[0]?.via ?? null,
      })),
      [
        { key: '424242', status: 'resolved', memberId, via: 'external-id' },
        { key: '999999', status: 'unresolved', memberId: null, via: null },
        { key: 'dhruv-new', status: 'resolved', memberId, via: 'handle' },
        { key: 'dhruv-old', status: 'resolved', memberId, via: 'alias' },
        { key: 'stranger', status: 'unresolved', memberId: null, via: null },
      ],
    );

    const strangerRows = await f.db.platform.query(
      `SELECT count(*)::int AS n FROM ${f.table('tf_member_external_handle_observations')} WHERE external_id = '999999'`,
    );
    assert.equal(strangerRows.rows[0].n, 0);

    const staleRecorded = await inWorkspace(tx =>
      observeGitHubHandles(
        tx,
        {
          pull_request: {
            user: { id: 424242, login: 'dhruv-old' },
          },
        },
        new Date(renameTime.getTime() - 120_000),
      ),
    );
    assert.equal(staleRecorded, 0);

    const afterStaleList = await inWorkspace(tx => listMemberIdentities(tx, memberId));
    assert.deepEqual(
      { handle: afterStaleList[0].handle, aliases: afterStaleList[0].aliases },
      { handle: 'dhruv-new', aliases: ['dhruv-old'] },
    );

    const preMigrationCount = await observeGitHubHandles(
      {
        client: {
          query: async () => assert.fail('pre-117 transaction must not query identity tables'),
        },
        schema: f.ws.names.schema,
        commonVersion: 116,
      },
      { pull_request: { user: { id: 424242, login: 'dhruv-ignored' } } },
    );
    assert.equal(preMigrationCount, 0);

    await f.db.platform.query(
      `DELETE FROM ${f.table('tf_member_external_handle_observations')} WHERE external_id = '424242'`,
    );
    const reconnect = await f.service.reconnect(f.ws.id, f.member.userId, 'test-session', started.accountId);
    f.setProfile({ id: 424242, login: 'dhruv-reconnected' });
    await f.complete({ state: new URL(reconnect.url).searchParams.get('state') });

    const afterReconnectList = await inWorkspace(tx => listMemberIdentities(tx, memberId));
    assert.deepEqual(
      { handle: afterReconnectList[0].handle, aliases: afterReconnectList[0].aliases },
      { handle: 'dhruv-reconnected', aliases: ['dhruv-old'] },
    );
    const afterReconnectResolution = await inWorkspace(tx =>
      resolveMemberIdentities(tx, {
        provider: 'github',
        scope: 'github.com',
        handles: ['dhruv-reconnected', 'dhruv-old'],
      }),
    );
    assert.deepEqual(
      afterReconnectResolution.map(({ key, status, memberId: resolvedId, hits }) => ({
        key: key.value,
        status,
        memberId: resolvedId,
        via: hits[0]?.via ?? null,
      })),
      [
        { key: 'dhruv-reconnected', status: 'resolved', memberId, via: 'handle' },
        { key: 'dhruv-old', status: 'resolved', memberId, via: 'alias' },
      ],
    );
  } finally {
    await f.close();
  }
});
