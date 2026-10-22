import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createGitHubAccounts } from '@tulipfarm/github';

export async function githubFixture({ connectionsPerPool = 4, scopes = ['repo', 'read:user'] } = {}) {
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
      connectionsPerPool,
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
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member.membershipId,
      member.userId,
    ]);
    const keyring = { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } };
    const configuration = {
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      redirectUri: 'http://127.0.0.1:5218/github/callback',
      scopes,
    };
    const calls = [];
    let profile = { id: 123, login: 'octocat' };
    const defaultBehavior = async url =>
      url.endsWith('/access_token')
        ? Response.json({ access_token: 'synthetic-access-token', token_type: 'bearer', scope: scopes.join(',') })
        : Response.json(profile);
    let behavior = defaultBehavior;
    const makeService = (overrides = {}) =>
      createGitHubAccounts({
        runtime,
        configuration,
        keyring,
        fetcher: async (...args) => {
          calls.push(args);
          return behavior(...args);
        },
        ...overrides,
      });
    const service = makeService();
    const begin = async (user = member.userId) => {
      const result = await service.begin(one.id, user, 'test-session');
      return { ...result, state: new URL(result.url).searchParams.get('state') };
    };
    const complete = (started, user = member.userId) =>
      service.complete({ code: 'fixture-code', state: started.state }, 'test-session', user);
    const connect = async (id = 123) => {
      profile = { id, login: `person-${id}` };
      const started = await begin();
      await complete(started);
      return started.accountId;
    };
    return {
      db,
      one,
      two,
      member,
      runtime,
      table,
      keyring,
      configuration,
      service,
      makeService,
      calls,
      begin,
      complete,
      connect,
      defaultBehavior,
      setProfile(value) {
        profile = value;
      },
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
