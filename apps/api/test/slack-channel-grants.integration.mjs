import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import {
  createSlackInstallations,
  createSlackInbox,
  slackCredentialCipher,
} from '../../../packages/slack/src/index.ts';
import { registerSlack } from '../src/slack.ts';
import { authConfig, createAuth } from '../src/auth.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity } from '../src/security.ts';

const config = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic-client-secret',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
  scopeApproval: { reference: 'test-only-not-approved-manifest', botScopes: ['channels:read', 'groups:read'] },
};
const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });

test('bot channel listing requires an installation grant, not the admin role', async t => {
  const db = await fixture();
  const identityRole = `slack_identity_${randomUUID().replaceAll('-', '')}`;
  let runtime, pool, app;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const password = randomUUID();
    await db.admin.query(`CREATE ROLE ${escapeIdentifier(identityRole)} LOGIN PASSWORD ${escapeLiteral(password)}`);
    const identityUrl = new URL(db.connectionString);
    await db.platform.query(
      `GRANT CONNECT ON DATABASE ${escapeIdentifier(identityUrl.pathname.slice(1))} TO ${escapeIdentifier(identityRole)}; GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(identityRole)}; GRANT SELECT,INSERT ON app.slack_workspace_links TO ${escapeIdentifier(identityRole)}; GRANT UPDATE (team_id,generation,state,state_hash,session_id,user_id,membership_id,expires_at) ON app.slack_workspace_links TO ${escapeIdentifier(identityRole)}; GRANT SELECT,INSERT,UPDATE,DELETE ON app.users,app.accounts,app.sessions,app.verifications TO ${escapeIdentifier(identityRole)}`,
    );
    identityUrl.username = identityRole;
    identityUrl.password = password;
    pool = new Pool({ connectionString: identityUrl.href, max: 4, options: '-c search_path=app' });
    const links = [];
    const auth = createAuth(
      pool,
      async ({ url }) => links.push(url),
      async () => {},
    );
    const cookies = new Map();
    const users = new Map();
    for (const name of ['installer', 'admin', 'granted', 'member']) {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: authConfig().webOrigin }),
        body: { email: `${name}-${randomUUID()}@example.test`, name },
      });
      const response = await auth.handler(new Request(links.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      cookies.set(name, cookie);
      users.set(name, (await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id);
    }
    const workspace = await db.create(undefined, { userId: users.get('installer') });
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
    });
    const table = name => qualified(workspace.names.schema, name);
    const grantedMembership = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin'),($3,$4,'member'),($5,$6,'member')`,
      [randomUUID(), users.get('admin'), grantedMembership, users.get('granted'), randomUUID(), users.get('member')],
    );
    const calls = [];
    const fetcher = async (url, init) => {
      const method = new URL(String(url)).pathname.split('/').pop();
      calls.push(method);
      if (method === 'oauth.v2.access')
        return Response.json({
          ok: true,
          app_id: config.appId,
          team: { id: 'TGRANTS' },
          token_type: 'bot',
          bot_user_id: 'UBOT',
          access_token: 'xoxb-synthetic-secret',
          scope: 'channels:read,groups:read',
        });
      assert.equal(method, 'users.conversations');
      assert.equal(new URLSearchParams(init.body).get('types'), 'public_channel,private_channel');
      return Response.json({
        ok: true,
        channels: [{ id: 'GPRIVATE', name: 'leadership', is_private: true }],
        response_metadata: { next_cursor: '' },
      });
    };
    const installations = createSlackInstallations({ pool, runtime, config, cipher, fetcher });
    app = Fastify();
    registerSecurity(app, authConfig().webOrigin);
    await app.register(swagger, { openapi: { info: { title: 'Slack channel grants test', version: '1' } } });
    await app.register(
      async v1 => {
        protectBusinessRequests(v1);
        registerSlack(v1, auth, { config, installations, inbox: createSlackInbox(runtime) });
      },
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (method, path, user, body) => {
      const response = await fetch(`${address}/v1${path}`, {
        method,
        headers: {
          cookie: cookies.get(user),
          origin: authConfig().webOrigin,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const begun = await request('POST', `/workspaces/${workspace.id}/slack/install`, 'installer');
    assert.equal(begun.status, 200);
    const state = new URL(begun.body.url).searchParams.get('state');
    assert.equal(
      (await request('GET', `/slack/oauth/callback?code=synthetic-code&state=${state}`, 'installer')).status,
      200,
    );
    const grants = (await request('GET', `/workspaces/${workspace.id}/slack/grants`, 'installer')).body;
    assert.equal(
      (
        await request('PUT', `/workspaces/${workspace.id}/slack/grants`, 'installer', {
          ...grants,
          use: { memberIds: [...grants.use.memberIds, grantedMembership], teamIds: [] },
        })
      ).status,
      200,
    );
    const list = user => request('GET', `/workspaces/${workspace.id}/slack/channels`, user);
    const expected = {
      status: 200,
      body: { channels: [{ id: 'GPRIVATE', name: 'leadership', private: true }], complete: true, missingScopes: [] },
    };

    await t.test('an admin without a manage or use grant is refused before the bot credential is used', async () => {
      assert.equal(
        (await request('GET', `/workspaces/${workspace.id}/slack/status`, 'admin')).body.state,
        'unavailable',
      );
      const before = calls.length;
      assert.deepEqual(await list('admin'), { status: 404, body: { error: 'slack-not-found' } });
      assert.deepEqual(await list('member'), { status: 404, body: { error: 'slack-not-found' } });
      assert.equal(calls.length, before);
    });
    await t.test('an explicitly granted member and the installer list bot channels', async () => {
      assert.deepEqual(await list('granted'), expected);
      assert.deepEqual(await list('installer'), expected);
    });
  } finally {
    await app?.close();
    await runtime?.close();
    await pool?.end();
    await db.close();
    const cleanup = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    try {
      await cleanup.query(`DROP ROLE IF EXISTS ${escapeIdentifier(identityRole)}`);
    } finally {
      await cleanup.end();
    }
  }
});
