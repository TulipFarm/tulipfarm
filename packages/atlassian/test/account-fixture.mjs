import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createAtlassianAccounts } from '../dist/accounts.js';

export async function accountFixture() {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    const one = await db.create(stream);
    const two = await db.create(stream);
    for (const workspace of [one, two]) await verifyWorkspaceIsolation(db.platform, workspace.id);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(w => w.id === id);
        if (!workspace) throw new Error('unknown-workspace');
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const table = (name, workspace = one) => qualified(workspace.names.schema, name);
    const member = { userId: randomUUID(), membershipId: randomUUID() };
    const teamId = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Account users')`, [teamId]);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      member.membershipId,
      teamId,
    ]);
    const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
    const common = {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'https://api.example.test/v1/atlassian/oauth/callback',
      scopes: ['offline_access'],
    };
    const configurations = {
      'atlassian-mcp': common,
      'atlassian-rest': { ...common, scopes: ['read:me', 'offline_access'] },
      trello: { ...common, scopes: ['read:member:trello', 'offline_access'] },
    };
    const calls = [];
    const defaultBehavior = async url => {
      if (url.endsWith('/token'))
        return Response.json({
          access_token: 'synthetic-access-token',
          refresh_token: 'synthetic-refresh-token',
          expires_in: 3600,
        });
      if (url.includes('/1/members/me'))
        return Response.json({ id: 'abcdef123456abcdef123456', username: 'test-person' });
      if (url.endsWith('/me')) return Response.json({ account_id: 'verified-atlassian-id', name: 'Test person' });
      return Response.json([
        { id: 'cloud-id', name: 'Test site', url: 'https://example.atlassian.net', scopes: ['read:me'] },
      ]);
    };
    let behavior = defaultBehavior;
    const makeService = (overrides = {}) =>
      createAtlassianAccounts({
        runtime,
        configurations,
        keyring,
        fetcher: async (...args) => {
          calls.push(args);
          return behavior(...args);
        },
        ...overrides,
      });
    const service = makeService();
    const begin = async (protocol = 'trello', ownership = 'personal', user = member.userId) => {
      const result = await service.begin(one.id, user, 'test-session', { protocol, ownership: { kind: ownership } });
      return { ...result, state: new URL(result.url).searchParams.get('state') };
    };
    const connect = async (...args) => {
      const started = await begin(...args);
      const user = args[2] ?? member.userId;
      await service.complete('test-code', started.state, 'test-session', user);
      return started.accountId;
    };
    return {
      db,
      one,
      two,
      member,
      teamId,
      runtime,
      table,
      keyring,
      configurations,
      service,
      makeService,
      calls,
      begin,
      connect,
      defaultBehavior,
      setBehavior(value) {
        behavior = value;
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
