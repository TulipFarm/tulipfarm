import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import {
  createSlackInstallations,
  createSlackInbox,
  createSlackMemberLinking,
  slackCredentialCipher,
} from '../../../packages/slack/src/index.ts';
import { memberProviderFixture } from '../../../packages/slack/test/member-provider-fixture.mjs';
import { registerSlack } from '../src/slack.ts';
import { authConfig, createAuth } from '../src/auth.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity } from '../src/security.ts';
import { verifyWorkspaceIsolation } from '@tulipfarm/workspace-storage/provisioning';

const config = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic-client-secret',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
  scopeApproval: { reference: 'test-only-not-approved-manifest', botScopes: ['chat:write'] },
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/v1/slack/link/identity',
    operationalRedirectUri: 'https://api.example.test/v1/slack/link/complete',
    distribution: 'internal',
    scopeApproval: {
      reference: 'synthetic-no-release-approval',
      userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
    },
  },
};
const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
const token = team => ({
  ok: true,
  app_id: config.appId,
  team: { id: team },
  token_type: 'bot',
  bot_user_id: 'UBOT',
  access_token: 'xoxb-synthetic-secret',
  scope: 'chat:write',
});

test('real SQL and HTTP installation, signed intake, isolation and replay', async t => {
  const db = await fixture();
  const identityRole = `slack_identity_${randomUUID().replaceAll('-', '')}`;
  let runtime, pool, app;
  try {
    await db.platform.query('DROP TABLE app.accounts; SET search_path TO app');
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
    const links = [];
    const auth = createAuth(
      pool,
      async ({ url }) => links.push(url),
      async () => {},
    );
    const cookies = new Map();
    const identities = new Map();
    for (const name of ['admin', 'second', 'member', 'outsider']) {
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
      identities.set(name, (await auth.api.getSession({ headers: new Headers({ cookie }) })).user.id);
    }
    const one = await db.create(undefined, { userId: identities.get('admin') });
    const two = await db.create(undefined, { userId: identities.get('second') });
    const table = (name, workspace = one) => qualified(workspace.names.schema, name);
    await t.test('fresh provisioning has matching grants', async () => {
      for (const workspace of [one, two]) {
        await verifyWorkspaceIsolation(db.platform, workspace.id);
        const rights = (
          await db.platform.query(
            `SELECT has_table_privilege($1,$2,'INSERT') AS insert,has_table_privilege($1,$2,'DELETE') AS delete,has_column_privilege($1,$2,'payload','UPDATE') AS rewrite`,
            [workspace.names.runtime, qualified(workspace.names.schema, 'tf_slack_events')],
          )
        ).rows[0];
        assert.deepEqual(rights, { insert: true, delete: false, rewrite: false });
      }
    });
    const member = identities.get('member');
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      randomUUID(),
      member,
    ]);
    let provider = async () => Response.json(token('TONE'));
    let exchanges = 0;
    const installations = createSlackInstallations({
      pool,
      runtime,
      config,
      cipher,
      fetcher: async (...args) => {
        exchanges++;
        return provider(...args);
      },
    });
    const inbox = createSlackInbox(runtime);
    const memberProvider = await memberProviderFixture(config);
    const memberLinking = createSlackMemberLinking({
      runtime,
      config,
      cipher,
      installations,
      fetcher: memberProvider.fetcher,
    });
    app = Fastify();
    registerSecurity(app, authConfig().webOrigin);
    await app.register(swagger, { openapi: { info: { title: 'Slack test', version: '1' } } });
    await app.register(
      async v1 => {
        protectBusinessRequests(v1);
        registerSlack(v1, auth, { config, installations, inbox, memberLinking });
      },
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const http = async (method, path, headers, payload) => {
      const response = await fetch(`${address}/v1${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
      const body = await response.text();
      return { statusCode: response.status, body, json: () => JSON.parse(body) };
    };
    const request = async (method, path, cookie = 'admin', payload) =>
      http(method, path, { cookie: cookies.get(cookie) ?? '', origin: authConfig().webOrigin }, payload);
    const begin = async (workspace = one, cookie = 'admin') => {
      const response = await request('POST', `/workspaces/${workspace.id}/slack/install`, cookie);
      assert.equal(response.statusCode, 200, response.body);
      return new URL(response.json().url).searchParams.get('state');
    };
    const complete = (state, cookie = 'admin') =>
      request('GET', `/slack/oauth/callback?code=synthetic-code&state=${state}`, cookie);
    const send = (event, override = {}) => {
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return http(
        'POST',
        '/slack/events',
        {
          'content-type': 'application/json',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
          ...override,
        },
        body,
      );
    };
    const event = (id, body, team = 'TONE') => ({
      type: 'event_callback',
      api_app_id: config.appId,
      team_id: team,
      event_id: id,
      event_time: Math.ceil(Date.now() / 1000) + 1,
      event: body,
    });
    const message = (id, ts = '1234567890.123456') =>
      event(id, { type: 'message', channel: 'CONE', user: 'UPERSON', ts, text: 'private request' });
    await t.test('admin and origin boundaries reject ordinary members and forged callbacks', async () => {
      assert.equal((await request('POST', `/workspaces/${one.id}/slack/install`, 'member')).statusCode, 404);
      assert.equal((await request('POST', `/workspaces/${one.id}/slack/install`, 'outsider')).statusCode, 404);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${one.id}/slack/install`,
            headers: { cookie: 'admin' },
          })
        ).statusCode,
        403,
      );
      assert.equal((await complete('forged')).statusCode, 409);
      assert.equal(exchanges, 0);
    });
    let firstState;
    await t.test(
      'a session-bound single-use callback encrypts the bot credential and reserves one-to-one mapping',
      async () => {
        firstState = await begin();
        assert.equal((await complete(firstState, 'member')).statusCode, 409);
        const replies = await Promise.all([complete(firstState), complete(firstState)]);
        assert.deepEqual(replies.map(r => r.statusCode).sort(), [200, 409]);
        assert.equal(exchanges, 1);
        const stored = (await db.platform.query(`SELECT * FROM ${table('tf_slack_installations')}`)).rows[0];
        assert.equal(stored.state, 'active');
        assert.equal(
          cipher.decrypt(
            { workspaceId: one.id, installationId: stored.id, generation: 1, kind: 'bot' },
            stored.bot_credential,
          ),
          'xoxb-synthetic-secret',
        );
        const status = await request('GET', `/workspaces/${one.id}/slack/status`, 'member');
        assert.deepEqual(status.json(), {
          state: 'active',
          teamId: 'TONE',
          canManage: false,
          linked: false,
          execution: 'disabled',
          scopes: ['chat:write'],
        });
        assert.equal(JSON.stringify(stored).includes('xoxb-synthetic-secret'), false);
        const second = await begin(two, 'second');
        assert.equal((await complete(second, 'second')).statusCode, 409);
        assert.deepEqual(
          (await db.platform.query('SELECT workspace_id FROM app.slack_workspace_links WHERE team_id=$1', ['TONE']))
            .rows,
          [{ workspace_id: one.id }],
        );
        provider = async () => Response.json(token('TTWO'));
        assert.equal((await complete(await begin(two, 'second'), 'second')).statusCode, 200);
      },
    );
    await t.test('bot channel listing is admin-only and follows granted read scopes', async () => {
      const list = cookie => request('GET', `/workspaces/${one.id}/slack/channels`, cookie);
      assert.deepEqual((await list('admin')).json(), {
        channels: [],
        complete: true,
        missingScopes: ['channels:read', 'groups:read'],
      });
      assert.equal((await list('outsider')).statusCode, 404);
      assert.equal((await list('member')).statusCode, 404);
      await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET scopes=$1`, [
        ['chat:write', 'channels:read', 'groups:read'],
      ]);
      const previous = provider;
      const calls = [];
      provider = async (url, init) => {
        const form = new URLSearchParams(init.body);
        calls.push([String(url), init.headers.Authorization, form.get('types'), form.get('cursor')]);
        return Response.json(
          form.get('cursor')
            ? {
                ok: true,
                channels: [{ id: 'GSECRET', name: 'leadership', is_private: true }],
                response_metadata: { next_cursor: '' },
              }
            : {
                ok: true,
                channels: [
                  { id: 'CRANDOM', name: 'random', is_private: false },
                  { id: 'COLD', name: 'old', is_archived: true },
                ],
                response_metadata: { next_cursor: 'page-2' },
              },
        );
      };
      try {
        const expected = {
          channels: [
            { id: 'GSECRET', name: 'leadership', private: true },
            { id: 'CRANDOM', name: 'random', private: false },
          ],
          complete: true,
          missingScopes: [],
        };
        assert.deepEqual((await list('admin')).json(), expected);
        assert.equal((await list('member')).statusCode, 404);
        assert.deepEqual(calls.slice(0, 2), [
          [
            'https://slack.com/api/users.conversations',
            'Bearer xoxb-synthetic-secret',
            'public_channel,private_channel',
            null,
          ],
          [
            'https://slack.com/api/users.conversations',
            'Bearer xoxb-synthetic-secret',
            'public_channel,private_channel',
            'page-2',
          ],
        ]);
        provider = async () => Response.json({ ok: false, error: 'invalid_auth' });
        assert.equal((await list('admin')).statusCode, 503);
      } finally {
        provider = previous;
        await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET scopes=$1`, [['chat:write']]);
      }
    });
    await t.test(
      'signed challenge, wrong signature, wrong app and unknown team never contaminate the inbox',
      async () => {
        assert.deepEqual((await send({ type: 'url_verification', challenge: 'challenge' })).json(), {
          challenge: 'challenge',
        });
        assert.equal((await send(message('bad'), { 'x-slack-signature': 'v0=' + '0'.repeat(64) })).statusCode, 401);
        assert.equal((await send({ ...message('wrong-app'), api_app_id: 'AOTHER' })).statusCode, 403);
        assert.equal((await send({ ...message('wrong-team'), team_id: 'TUNKNOWN' })).statusCode, 404);
        assert.equal((await send(message('stale'), { 'x-slack-request-timestamp': '1000000000' })).statusCode, 401);
        assert.equal((await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_events')}`)).rows[0].count, '0');
      },
    );
    await t.test(
      'bot recovery rejects another team then reconnects the same pair without replacing its generation',
      async () => {
        const before = (await db.platform.query(`SELECT * FROM ${table('tf_slack_installations')}`)).rows[0];
        await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET bot_credential=$1`, [
          { ...before.bot_credential, rotation: { state: 'reconnect-required' } },
        ]);
        assert.equal((await request('GET', `/workspaces/${one.id}/slack/status`)).json().state, 'reconnect-required');
        provider = async () => Response.json(token('TOTHER'));
        assert.equal((await complete(await begin())).statusCode, 409);
        provider = async () =>
          Response.json({
            ...token('TONE'),
            access_token: 'xoxe.xoxb-renewed',
            refresh_token: 'xoxe-bot-renewed',
            expires_in: 43200,
          });
        assert.equal((await complete(await begin())).statusCode, 200);
        const after = (await db.platform.query(`SELECT * FROM ${table('tf_slack_installations')}`)).rows[0];
        assert.equal(after.id, before.id);
        assert.equal(after.generation, before.generation);
        assert.equal(after.accepts_events_after, before.accepts_events_after);
        assert.equal(
          cipher.decrypt(
            { workspaceId: one.id, installationId: before.id, generation: 1, kind: 'bot' },
            after.bot_credential,
          ),
          'xoxe.xoxb-renewed',
        );
        assert.equal((await request('GET', `/workspaces/${one.id}/slack/status`)).json().state, 'active');
        provider = async () => Response.json(token('TTWO'));
      },
    );
    await t.test(
      'message and mention delivery races commit one held receipt, retries survive a new inbox instance',
      async () => {
        const original = message('event-one');
        const mention = { ...original, event_id: 'event-mention', event: { ...original.event, type: 'app_mention' } };
        const responses = await Promise.all([send(original), send(original), send(mention)]);
        assert.deepEqual(
          responses.map(r => r.statusCode),
          [200, 200, 200],
        );
        assert.equal(responses.filter(r => !r.json().duplicate).length, 1);
        const route = await installations.route('ATEST', 'TONE');
        assert.deepEqual(await createSlackInbox(runtime).accept(route, original), {
          accepted: true,
          duplicate: true,
          execution: 'disabled',
        });
        assert.deepEqual(
          (await db.platform.query(`SELECT disposition,payload->>'text' AS text FROM ${table('tf_slack_events')}`))
            .rows,
          [{ disposition: 'held', text: 'private request' }],
        );
        assert.equal(
          (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_events', two)}`)).rows[0].count,
          '0',
        );
        assert.equal((await send({ ...message('second-workspace'), team_id: 'TTWO' })).statusCode, 200);
        assert.equal(
          (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_events', two)}`)).rows[0].count,
          '1',
        );
        await assert.rejects(
          runtime.transaction(one.id, commonCompatibility, tx =>
            tx.client.query(`SELECT * FROM ${table('tf_slack_events', two)}`),
          ),
          error => error.code === '42501',
        );
      },
    );
    await t.test('failed persistence returns retryable HTTP failure and leaves no receipt', async () => {
      await db.platform.query(
        `ALTER TABLE ${table('tf_slack_events')} ADD CONSTRAINT reject_fixture CHECK (event_id<>'database-failure')`,
      );
      assert.equal((await send(message('database-failure', '1234567891.000001'))).statusCode, 503);
      await db.platform.query(`ALTER TABLE ${table('tf_slack_events')} DROP CONSTRAINT reject_fixture`);
      assert.deepEqual((await send(message('database-failure', '1234567891.000001'))).json(), {
        accepted: true,
        duplicate: false,
        execution: 'disabled',
      });
    });
    const heldId = (
      await db.platform.query(
        `SELECT id FROM ${table('tf_slack_events')} WHERE semantic_key='message:CONE:1234567890.123456'`,
      )
    ).rows[0].id;
    const linkStart = async (name = 'member', eventId = heldId) => {
      const response = await fetch(`${address}/v1/workspaces/${one.id}/slack/link`, {
        method: 'POST',
        headers: { cookie: cookies.get(name), origin: authConfig().webOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ eventId }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      const url = new URL(result.url);
      assert.equal(url.origin + url.pathname, 'https://slack.com/openid/connect/authorize');
      assert.equal(url.searchParams.get('scope'), 'openid');
      assert.match(response.headers.get('set-cookie'), /Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=600/);
      return {
        state: url.searchParams.get('state'),
        nonce: url.searchParams.get('nonce'),
        cookie: response.headers.get('set-cookie').split(';')[0],
      };
    };
    const prove = async (flow, source = 'https://slack.com', cookie = flow.cookie) =>
      fetch(`${address}/v1/slack/link/identity`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: source, cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state: flow.state, code: 'identity-code' }),
      });
    const consent = (flow, name = 'member') =>
      fetch(`${address}/v1/slack/link/consent?state=${flow.state}`, {
        redirect: 'manual',
        headers: { cookie: `${cookies.get(name)}; ${flow.cookie}` },
      });
    const operational = (flow, name = 'member') =>
      fetch(`${address}/v1/slack/link/complete?state=${flow.state}&code=operational-code`, {
        redirect: 'manual',
        headers: { cookie: `${cookies.get(name)}; ${flow.cookie}` },
      });
    await t.test('Slack query-mode identity redirects preserve browser binding and reject replay', async () => {
      const flow = await linkStart();
      memberProvider.set({ nonce: flow.nonce });
      const callback = cookie =>
        fetch(`${address}/v1/slack/link/identity?state=${encodeURIComponent(flow.state)}&code=identity-code`, {
          redirect: 'manual',
          headers: { cookie },
        });
      assert.equal((await callback('')).status, 404);
      const response = await callback(flow.cookie);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), `/v1/slack/link/consent?state=${encodeURIComponent(flow.state)}`);
      assert.equal((await callback(flow.cookie)).status, 404);
      assert.equal((await consent(flow, 'admin')).status, 404);
      assert.equal(
        (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_identities')}`)).rows[0].count,
        '0',
      );
      const denied = await linkStart();
      const recovery = await fetch(
        `${address}/v1/slack/link/identity?state=${encodeURIComponent(denied.state)}&error=access_denied`,
        {
          redirect: 'manual',
          headers: { cookie: denied.cookie, accept: 'text/html' },
        },
      );
      assert.equal(recovery.status, 303);
      assert.equal(
        recovery.headers.get('location'),
        `${authConfig().webOrigin}/slack/link?workspaceId=${one.id}&eventId=${heldId}&recovery=retry`,
      );
    });
    await t.test(
      'linking requires current membership, exact sender proof, browser cookie and signed nonce claims',
      async () => {
        assert.equal(
          (
            await http(
              'POST',
              `/workspaces/${one.id}/slack/link`,
              { cookie: cookies.get('outsider'), origin: authConfig().webOrigin, 'content-type': 'application/json' },
              JSON.stringify({ eventId: heldId }),
            )
          ).statusCode,
          404,
        );
        const flow = await linkStart();
        memberProvider.set({ nonce: flow.nonce });
        assert.equal((await prove(flow, 'https://evil.test')).status, 403);
        assert.equal((await prove(flow, 'https://slack.com', '')).status, 404);
        assert.equal((await prove(flow)).status, 303);
        assert.equal((await consent(flow, 'admin')).status, 404);
        assert.equal(
          (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_identities')}`)).rows[0].count,
          '0',
        );
        for (const mismatch of [
          { user: 'UATTACKER' },
          { team: 'TOTHER' },
          { nonce: 'wrong' },
          { audience: 'other-app' },
          { issuer: 'https://evil.test' },
          { expired: true },
          { badSignature: true },
        ]) {
          const attack = await linkStart();
          memberProvider.set({ nonce: attack.nonce, ...mismatch });
          assert.notEqual((await prove(attack)).status, 303);
        }
        assert.equal(
          (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_identities')}`)).rows[0].count,
          '0',
        );
      },
    );
    await t.test(
      'denial recovery validates the stored challenge and browser before returning a fixed content-free destination',
      async () => {
        const flow = await linkStart();
        const denial = (state = flow.state, cookie = flow.cookie, name = 'member') =>
          fetch(
            `${address}/v1/slack/link/complete?state=${encodeURIComponent(state)}&error=access_denied&redirect_uri=https://evil.test`,
            { redirect: 'manual', headers: { cookie: `${cookies.get(name)}; ${cookie}`, accept: 'text/html' } },
          );
        for (const response of [
          await denial(flow.state, ''),
          await denial(`${one.id}.forged`),
          await denial(flow.state, flow.cookie, 'admin'),
        ]) {
          assert.equal(response.status, 404);
          assert.equal(response.headers.get('location'), null);
        }
        const response = await denial();
        assert.equal(response.status, 303);
        assert.equal(
          response.headers.get('location'),
          `${authConfig().webOrigin}/slack/link?workspaceId=${one.id}&eventId=${heldId}&recovery=retry`,
        );
        assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
        memberProvider.set({ nonce: flow.nonce });
        assert.equal((await prove(flow)).status, 404);
        assert.equal((await consent(flow)).status, 404);
        assert.equal((await operational(flow)).status, 404);
        assert.deepEqual(
          (
            await db.platform.query(`SELECT stage FROM ${table('tf_slack_link_challenges')} WHERE nonce=$1`, [
              flow.nonce,
            ])
          ).rows,
          [{ stage: 'used' }],
        );
        assert.equal(
          (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_identities')}`)).rows[0].count,
          '0',
        );
      },
    );
    let authorizedFlow;
    await t.test(
      'identity linking automatically continues to MCP consent and never resumes before a credential exists',
      async () => {
        const flow = await linkStart();
        memberProvider.set({ nonce: flow.nonce });
        assert.equal((await prove(flow)).status, 303);
        const redirect = await consent(flow);
        assert.equal(redirect.status, 302);
        const url = new URL(redirect.headers.get('location'));
        assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2_user/authorize');
        assert.equal(url.searchParams.get('scope'), 'channels:history,groups:history,im:history,mpim:history');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.deepEqual(
          (await db.platform.query(`SELECT state,credential FROM ${table('tf_slack_identities')}`)).rows,
          [{ state: 'consent-required', credential: null }],
        );
        assert.deepEqual((await db.platform.query(`SELECT state FROM ${table('tf_slack_continuations')}`)).rows, [
          { state: 'consent-required' },
        ]);
        memberProvider.set({ deny: true });
        assert.notEqual((await operational(flow)).status, 200);
        assert.deepEqual((await db.platform.query(`SELECT state FROM ${table('tf_slack_continuations')}`)).rows, [
          { state: 'consent-required' },
        ]);
        for (const failure of [{ user: 'UOTHER' }, { team: 'TOTHER' }, { scopes: 'chat:write' }, { rotating: true }]) {
          const retry = await linkStart();
          memberProvider.set({ nonce: retry.nonce });
          assert.equal((await prove(retry)).status, 303);
          assert.equal((await consent(retry)).status, 302);
          memberProvider.set(failure);
          assert.notEqual((await operational(retry)).status, 200);
        }
        authorizedFlow = await linkStart();
        memberProvider.set({ nonce: authorizedFlow.nonce });
        assert.equal((await prove(authorizedFlow)).status, 303);
        assert.equal((await consent(authorizedFlow)).status, 302);
        memberProvider.set({});
        const outcomes = await Promise.all([operational(authorizedFlow), operational(authorizedFlow)]);
        assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 404]);
        assert.deepEqual(await outcomes.find(r => r.status === 200).json(), {
          workspaceId: one.id,
          eventId: heldId,
          state: 'dispatch-held',
          execution: 'disabled',
        });
        const identity = (await db.platform.query(`SELECT * FROM ${table('tf_slack_identities')}`)).rows[0];
        assert.equal(identity.user_id, member);
        assert.equal(identity.state, 'authorized');
        assert.equal(
          cipher.decrypt(
            {
              workspaceId: one.id,
              installationId: identity.installation_id,
              generation: identity.generation,
              kind: 'user',
              identityId: identity.id,
              membershipId: identity.membership_id,
              slackUserId: 'UPERSON',
            },
            identity.credential,
          ),
          'xoxp-synthetic-user-token',
        );
        assert.equal(JSON.stringify(identity).includes('xoxp-synthetic-user-token'), false);
        const actor = { kind: 'human', userId: member, membershipId: identity.membership_id };
        assert.deepEqual(await memberLinking.withPendingReadCredential(one.id, heldId, actor, async input => input), {
          token: 'xoxp-synthetic-user-token',
          identity: {
            appId: 'ATEST',
            teamId: 'TONE',
            userId: 'UPERSON',
            installationGeneration: 1,
            distribution: 'internal',
          },
        });
        await assert.rejects(
          memberLinking.withPendingReadCredential(
            one.id,
            heldId,
            { ...actor, userId: identities.get('admin') },
            async () => 'forbidden',
          ),
        );
        assert.deepEqual(
          (await db.platform.query(`SELECT event_id,state FROM ${table('tf_slack_continuations')}`)).rows,
          [{ event_id: heldId, state: 'dispatch-held' }],
        );
        assert.equal(memberProvider.requests.at(-1).url, 'https://slack.com/api/oauth.v2.user.access');
        assert.equal(memberProvider.requests.at(-1).form.get('code_verifier'), authorizedFlow.cookie.split('=')[1]);
        assert.equal(
          (
            await db.platform.query(`SELECT payload->>'text' AS text FROM ${table('tf_slack_events')} WHERE id=$1`, [
              heldId,
            ])
          ).rows[0].text,
          'private request',
        );
      },
    );
    await t.test('unlink cancels held dispatch and an old challenge cannot revive a revoked identity', async () => {
      const stale = await linkStart();
      memberProvider.set({ nonce: stale.nonce });
      assert.equal((await prove(stale)).status, 303);
      assert.equal((await consent(stale)).status, 302);
      assert.equal((await request('POST', `/workspaces/${one.id}/slack/unlink`, 'member')).statusCode, 200);
      memberProvider.set({});
      assert.equal((await operational(stale)).status, 404);
      assert.deepEqual((await db.platform.query(`SELECT state,credential FROM ${table('tf_slack_identities')}`)).rows, [
        { state: 'revoked', credential: null },
      ]);
      assert.deepEqual((await db.platform.query(`SELECT state FROM ${table('tf_slack_continuations')}`)).rows, [
        { state: 'cancelled' },
      ]);
      const identity = (await db.platform.query(`SELECT membership_id FROM ${table('tf_slack_identities')}`)).rows[0];
      await assert.rejects(
        memberLinking.withPendingReadCredential(
          one.id,
          heldId,
          { kind: 'human', userId: member, membershipId: identity.membership_id },
          async () => 'forbidden',
        ),
      );
    });
    if (process.env.PLAYWRIGHT_MODULE)
      await t.test(
        'Chromium recovers denied and failed consent in the real linker UI, then completes with secure cookies',
        async () => {
          const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
          const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5196', '--strictPort'], {
            cwd: new URL('../../web', import.meta.url),
            env: { ...process.env, VITE_API_URL: 'https://api.example.test' },
            stdio: 'ignore',
          });
          for (let attempt = 0; ; attempt++) {
            try {
              if ((await fetch('http://127.0.0.1:5196')).ok) break;
            } catch {
              if (attempt === 100) {
                vite.kill();
                throw new Error('Vite unavailable');
              }
            }
            await setTimeout(100);
          }
          const directory = await mkdtemp(join(tmpdir(), 'slack-link-tls-'));
          execFileSync(
            'openssl',
            [
              'req',
              '-x509',
              '-newkey',
              'rsa:2048',
              '-nodes',
              '-keyout',
              join(directory, 'key.pem'),
              '-out',
              join(directory, 'cert.pem'),
              '-days',
              '1',
              '-subj',
              '/CN=api.example.test',
            ],
            { stdio: 'ignore' },
          );
          let crossSiteCookie = '';
          let scenario = 'success',
            linkStarts = 0;
          let context;
          const proxy = createServer(
            { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) },
            async (request, response) => {
              const url = new URL(request.url, `https://${request.headers.host}`);
              if (url.hostname === 'app.example.test') {
                if (url.pathname === '/start') {
                  response.setHeader('content-type', 'text/html');
                  response.end('<h1>Local start</h1>');
                  return;
                }
                const upstream = await fetch('http://127.0.0.1:5196' + url.pathname + url.search);
                const headers = Object.fromEntries(upstream.headers);
                delete headers['content-length'];
                delete headers['content-encoding'];
                response.writeHead(upstream.status, headers);
                response.end(Buffer.from(await upstream.arrayBuffer()));
                return;
              }
              if (url.hostname === 'slack.com') {
                if (url.pathname === '/openid/connect/authorize') {
                  memberProvider.set({
                    nonce: url.searchParams.get('nonce'),
                    user: 'UBROWSER',
                    deny: scenario === 'identity-exchange-failure',
                  });
                  if (scenario === 'expired')
                    await db.platform.query(
                      `UPDATE ${table('tf_slack_link_challenges')} SET expires_at=now()-interval '1 second' WHERE stage='identity'`,
                    );
                  const field =
                    scenario === 'identity-denial'
                      ? '<input name="error" value="access_denied">'
                      : '<input name="code" value="browser-identity">';
                  response.setHeader('content-type', 'text/html');
                  response.end(
                    `<form method="post" action="https://api.example.test/v1/slack/link/identity"><input name="state" value="${url.searchParams.get('state')}">${field}</form><script>document.forms[0].submit()</script>`,
                  );
                  return;
                }
                if (scenario === 'missing-session') await context.clearCookies({ name: /session/ });
                memberProvider.set({ user: 'UBROWSER', deny: scenario === 'operational-exchange-failure' });
                const outcome = scenario === 'operational-denial' ? 'error=access_denied' : 'code=browser-operational';
                response.writeHead(302, {
                  location: `https://api.example.test/v1/slack/link/complete?${outcome}&state=${url.searchParams.get('state')}`,
                });
                response.end();
                return;
              }
              if (url.pathname.startsWith('/v1/auth/')) {
                const upstream = await auth.handler(
                  new Request(url, {
                    headers: new Headers(
                      Object.entries(request.headers).filter(([, value]) => typeof value === 'string'),
                    ),
                  }),
                );
                response.writeHead(upstream.status, {
                  ...Object.fromEntries(upstream.headers),
                  'access-control-allow-origin': 'https://app.example.test',
                  'access-control-allow-credentials': 'true',
                });
                response.end(Buffer.from(await upstream.arrayBuffer()));
                return;
              }
              if (request.method === 'POST' && url.pathname.endsWith('/slack/link')) linkStarts++;
              if (url.pathname === '/v1/slack/link/identity') crossSiteCookie = request.headers.cookie ?? '';
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const headers = { ...request.headers };
              delete headers.host;
              delete headers['content-length'];
              const upstream = await fetch(address + url.pathname + url.search, {
                method: request.method,
                headers,
                body: chunks.length ? Buffer.concat(chunks) : undefined,
                redirect: 'manual',
              });
              const outgoing = Object.fromEntries(upstream.headers);
              delete outgoing['content-length'];
              delete outgoing['content-encoding'];
              response.writeHead(upstream.status, outgoing);
              response.end(Buffer.from(await upstream.arrayBuffer()));
            },
          );
          await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
          const port = proxy.address().port;
          const browser = await chromium.launch({
            headless: true,
            args: [
              `--host-resolver-rules=MAP api.example.test 127.0.0.1:${port}, MAP app.example.test 127.0.0.1:${port}, MAP slack.com 127.0.0.1:${port}`,
              '--no-proxy-server',
            ],
          });
          try {
            await send(
              event('browser-request', {
                type: 'message',
                channel: 'CONE',
                user: 'UBROWSER',
                ts: '1234567891.000003',
                text: 'browser original request',
              }),
            );
            const id = (
              await db.platform.query(`SELECT id FROM ${table('tf_slack_events')} WHERE event_id='browser-request'`)
            ).rows[0].id;
            context = await browser.newContext({ ignoreHTTPSErrors: true });
            const restoreSession = () =>
              context.addCookies(
                cookies
                  .get('admin')
                  .split('; ')
                  .map(cookie => {
                    const at = cookie.indexOf('=');
                    return {
                      name: cookie.slice(0, at),
                      value: cookie.slice(at + 1),
                      domain: 'api.example.test',
                      path: '/',
                      secure: true,
                      httpOnly: true,
                      sameSite: 'Lax',
                    };
                  }),
              );
            await restoreSession();
            const page = await context.newPage();
            await page.goto('https://app.example.test/start');
            const start = () =>
              page.evaluate(
                async ({ workspaceId, eventId, origin }) => {
                  const response = await fetch(`https://api.example.test/v1/workspaces/${workspaceId}/slack/link`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ eventId }),
                  });
                  if (!response.ok) throw new Error(`begin ${response.status} ${origin}`);
                  return (await response.json()).url;
                },
                { workspaceId: one.id, eventId: id, origin: authConfig().webOrigin },
              );
            for (const mode of [
              'identity-denial',
              'operational-denial',
              'identity-exchange-failure',
              'operational-exchange-failure',
              'expired',
              'missing-session',
            ]) {
              scenario = mode;
              await restoreSession();
              await page.goto('https://app.example.test/start');
              const destination = await start();
              const starts = linkStarts;
              await page.goto(destination);
              if (mode === 'missing-session') {
                await page.waitForURL('**/login?redirect=*');
                assert.match(new URL(page.url()).searchParams.get('redirect'), /recovery=retry/);
                await restoreSession();
                await page.goto(
                  `https://app.example.test/slack/link?workspaceId=${one.id}&eventId=${id}&recovery=retry`,
                );
              }
              await page.getByRole('heading', { name: 'Slack integration was not completed' }).waitFor();
              assert.equal(await page.getByRole('button', { name: 'Try Slack integration again' }).count(), 1);
              assert.equal(linkStarts, starts, 'recovery must not automatically restart consent');
              const recovered = new URL(page.url());
              assert.equal(recovered.origin, 'https://app.example.test');
              assert.equal(recovered.searchParams.get('workspaceId'), one.id);
              assert.equal(recovered.searchParams.get('eventId'), id);
              assert.deepEqual([...recovered.searchParams.keys()].sort(), ['eventId', 'recovery', 'workspaceId']);
              assert.equal(
                (
                  await db.platform.query(
                    `SELECT count(*)::int AS n FROM ${table('tf_slack_continuations')} WHERE event_id=$1 AND state='dispatch-held'`,
                    [id],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (
                  await db.platform.query(
                    `SELECT count(*)::int AS n FROM ${table('tf_slack_identities')} WHERE slack_user_id='UBROWSER' AND credential IS NOT NULL`,
                  )
                ).rows[0].n,
                0,
              );
            }
            scenario = 'success';
            await page.getByRole('button', { name: 'Try Slack integration again' }).click();
            await page.waitForURL(`**/slack/link?workspaceId=${one.id}&eventId=${id}`, { timeout: 10000 });
            await page.getByRole('heading', { name: 'Slack connected', exact: true }).waitFor();
            assert.match(crossSiteCookie, /__Host-slack-link=/);
            assert.equal(crossSiteCookie.includes('session_token'), false);
            assert.deepEqual(
              (await db.platform.query(`SELECT state FROM ${table('tf_slack_continuations')} WHERE event_id=$1`, [id]))
                .rows,
              [{ state: 'dispatch-held' }],
            );
          } finally {
            await browser.close();
            await new Promise(resolve => proxy.close(resolve));
            await rm(directory, { recursive: true, force: true });
            vite.kill('SIGTERM');
          }
        },
      );
    await t.test('remove and rejoin cannot resurrect the original membership or bind its sender', async () => {
      const removedUser = identities.get('outsider');
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        removedUser,
      ]);
      await send(
        event('member-removal', {
          type: 'message',
          channel: 'CONE',
          user: 'UREMOVED',
          ts: '1234567891.000002',
          text: 'original membership request',
        }),
      );
      const id = (await db.platform.query(`SELECT id FROM ${table('tf_slack_events')} WHERE event_id='member-removal'`))
        .rows[0].id;
      const flow = await linkStart('outsider', id);
      memberProvider.set({ nonce: flow.nonce, user: 'UREMOVED' });
      assert.equal((await prove(flow)).status, 303);
      assert.equal((await consent(flow, 'outsider')).status, 302);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE user_id=$1`, [removedUser]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        randomUUID(),
        removedUser,
      ]);
      memberProvider.set({ user: 'UREMOVED' });
      assert.equal((await operational(flow, 'outsider')).status, 404);
      assert.equal(
        (
          await http(
            'POST',
            `/workspaces/${one.id}/slack/link`,
            { cookie: cookies.get('outsider'), origin: authConfig().webOrigin, 'content-type': 'application/json' },
            JSON.stringify({ eventId: id }),
          )
        ).statusCode,
        404,
      );
    });
    await t.test('expired and revoked-during-exchange challenges cannot create operational authority', async () => {
      await send(
        event('revocation-race', {
          type: 'message',
          channel: 'CONE',
          user: 'URACE',
          ts: '1234567891.000004',
          text: 'held for revocation',
        }),
      );
      const eventId = (
        await db.platform.query(`SELECT id FROM ${table('tf_slack_events')} WHERE event_id='revocation-race'`)
      ).rows[0].id;
      const expired = await linkStart('outsider', eventId);
      await db.platform.query(
        `UPDATE ${table('tf_slack_link_challenges')} SET expires_at=now()-interval '1 second' WHERE event_id=$1`,
        [eventId],
      );
      memberProvider.set({ nonce: expired.nonce, user: 'URACE' });
      assert.equal((await prove(expired)).status, 404);
      const race = await linkStart('outsider', eventId);
      memberProvider.set({ nonce: race.nonce, user: 'URACE' });
      assert.equal((await prove(race)).status, 303);
      assert.equal((await consent(race, 'outsider')).status, 302);
      memberProvider.set({
        user: 'URACE',
        during: async () => {
          assert.equal(
            (await send(event('race-revoked', { type: 'tokens_revoked', tokens: { oauth: ['URACE'] } }))).statusCode,
            200,
          );
        },
      });
      assert.equal((await operational(race, 'outsider')).status, 404);
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT state,credential FROM ${table('tf_slack_identities')} WHERE slack_user_id='URACE'`,
          )
        ).rows,
        [{ state: 'revoked', credential: null }],
      );
      assert.deepEqual(
        (await db.platform.query(`SELECT state FROM ${table('tf_slack_continuations')} WHERE event_id=$1`, [eventId]))
          .rows,
        [{ state: 'cancelled' }],
      );
      memberProvider.set({});
    });
    await t.test(
      'user revocation targets only named users and unrelated bot IDs do not uninstall the app',
      async () => {
        const revocation = event('revoke-user', {
          type: 'tokens_revoked',
          tokens: { oauth: ['UPERSON'], bot: ['UOTHERBOT'] },
        });
        assert.equal((await send(revocation)).statusCode, 200);
        assert.deepEqual(
          (
            await db.platform.query(
              `SELECT slack_user_id FROM ${table('tf_slack_user_revocations')} WHERE event_id='revoke-user'`,
            )
          ).rows,
          [{ slack_user_id: 'UPERSON' }],
        );
        assert.equal(
          (await db.platform.query(`SELECT state FROM ${table('tf_slack_installations')}`)).rows[0].state,
          'active',
        );
        assert.equal((await send(message('after-user-revoke', '1234567892.000001'))).statusCode, 200);
        assert.equal(
          (await send(event('bot-self', { ...message('unused').event, user: 'UBOT', ts: '1234567893.000001' })))
            .statusCode,
          200,
        );
        assert.equal(
          (await db.platform.query(`SELECT disposition FROM ${table('tf_slack_events')} WHERE event_id='bot-self'`))
            .rows[0].disposition,
          'ignored',
        );
      },
    );
    await t.test('bot revocation clears its credential and replay acknowledges without reviving it', async () => {
      const revoked = event('revoke-bot', { type: 'tokens_revoked', tokens: { bot: ['UBOT'] } });
      assert.equal((await send(revoked)).statusCode, 200);
      assert.deepEqual((await send(revoked)).json(), { accepted: true, duplicate: true, execution: 'disabled' });
      assert.deepEqual(
        (await db.platform.query(`SELECT state,generation,bot_credential FROM ${table('tf_slack_installations')}`))
          .rows,
        [{ state: 'revoked', generation: 2, bot_credential: null }],
      );
      assert.equal((await send(message('after-revoke', '1234567894.000001'))).statusCode, 503);
      assert.equal((await request('GET', `/workspaces/${two.id}/slack/status`, 'second')).json().state, 'active');
    });
    await t.test(
      'disconnect fences callbacks, reconnect preserves reservation and refuses old-generation events',
      async () => {
        assert.equal((await request('POST', `/workspaces/${one.id}/slack/disconnect`)).statusCode, 200);
        const state = await begin();
        provider = async () => Response.json(token('TOTHER'));
        assert.equal((await complete(state)).statusCode, 409);
        provider = async () => Response.json(token('TONE'));
        assert.equal((await complete(await begin())).statusCode, 200);
        assert.equal((await complete(firstState)).statusCode, 409);
        assert.equal((await send({ ...message('old-unseen', '1234567895.000001'), event_time: 1 })).statusCode, 503);
        assert.equal((await send(message('reconnected', '1234567896.000001'))).statusCode, 200);
        const uninstall = event('uninstalled', { type: 'app_uninstalled' });
        assert.equal((await send(uninstall)).statusCode, 200);
        assert.equal((await send(uninstall)).json().duplicate, true);
      },
    );
    await t.test('current admin is rechecked after provider exchange and missing scopes stay explicit', async () => {
      await request('POST', `/workspaces/${two.id}/slack/disconnect`, 'second');
      const state = await begin(two, 'second');
      provider = async () => {
        await db.platform.query(`UPDATE ${table('tf_memberships', two)} SET role='member' WHERE user_id=$1`, [
          two.userId,
        ]);
        return Response.json(token('TTWO'));
      };
      assert.equal((await complete(state, 'second')).statusCode, 409);
      assert.equal(
        (await db.platform.query(`SELECT state FROM ${table('tf_slack_installations', two)}`)).rows[0].state,
        'revoked',
      );
      await db.platform.query(`UPDATE ${table('tf_memberships', two)} SET role='admin' WHERE user_id=$1`, [two.userId]);
      provider = async () => Response.json({ ...token('TTWO'), scope: 'app_mentions:read' });
      assert.equal((await complete(await begin(two, 'second'), 'second')).json().state, 'scope-missing');
      assert.equal(
        (await request('GET', `/workspaces/${two.id}/slack/status`, 'second')).json().state,
        'scope-missing',
      );
    });
    await t.test('disconnect during provider exchange cannot activate the consumed generation', async () => {
      await request('POST', `/workspaces/${two.id}/slack/disconnect`, 'second');
      const state = await begin(two, 'second');
      provider = async () => {
        assert.equal((await request('POST', `/workspaces/${two.id}/slack/disconnect`, 'second')).statusCode, 200);
        return Response.json(token('TTWO'));
      };
      assert.equal((await complete(state, 'second')).statusCode, 409);
      assert.equal(await installations.route('ATEST', 'TTWO'), null);
      assert.equal((await request('GET', `/workspaces/${two.id}/slack/status`, 'second')).json().state, 'revoked');
    });
    await t.test('removed and readmitted admins cannot complete an older membership consent', async () => {
      const state = await begin(two, 'second');
      await db.platform.query(`UPDATE ${table('tf_memberships', two)} SET removed_at=now() WHERE user_id=$1`, [
        two.userId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships', two)} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        two.userId,
      ]);
      const before = exchanges;
      assert.equal((await complete(state, 'second')).statusCode, 409);
      assert.equal(exchanges, before);
      await request('POST', `/workspaces/${two.id}/slack/disconnect`, 'second');
      provider = async () => Response.json(token('TTWO'));
      assert.equal((await complete(await begin(two, 'second'), 'second')).statusCode, 200);
    });
    await t.test('two workspace callbacks racing for a fresh team activate only one mapping', async () => {
      const contenders = [await db.create(stream), await db.create(stream)];
      const states = await Promise.all(contenders.map(w => installations.begin(w.id, w.userId, 'race-session')));
      let arrivals = 0,
        release;
      const both = new Promise(resolve => {
        release = resolve;
      });
      provider = async () => {
        if (++arrivals === 2) release();
        await both;
        return Response.json(token('TRACE'));
      };
      const outcomes = await Promise.allSettled(
        contenders.map((w, i) =>
          installations.complete('code', new URL(states[i].url).searchParams.get('state'), 'race-session', w.userId),
        ),
      );
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.deepEqual(
        (
          await db.platform.query(
            "SELECT state,count(*)::integer AS n FROM app.slack_workspace_links WHERE team_id='TRACE' GROUP BY state",
          )
        ).rows,
        [{ state: 'active', n: 1 }],
      );
    });
    await t.test('held intake remains below the acknowledgement budget in a local serial probe', async () => {
      const durations = [];
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        const response = await send(
          event(
            `probe-${i}`,
            {
              type: 'message',
              user: 'UPERSON',
              channel: 'CTWO',
              ts: `1234567899.${String(i).padStart(6, '0')}`,
              text: 'synthetic latency probe',
            },
            'TTWO',
          ),
        );
        assert.equal(response.statusCode, 200, response.body);
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      assert.ok(durations.at(-1) < 3000, 'local signed acknowledgement exceeds three seconds');
      t.diagnostic(
        `50 serial local signed callbacks: p95=${durations[47].toFixed(2)}ms max=${durations.at(-1).toFixed(2)}ms; not Slack or production capacity qualification`,
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*) FROM ${table('tf_slack_events', two)} WHERE event_id LIKE 'probe-%'`))
          .rows[0].count,
        '50',
      );
    });
    await t.test('immutable receipt grants and documented routes match the actual handlers', async () => {
      for (const sql of [
        `DELETE FROM ${table('tf_slack_events')}`,
        `UPDATE ${table('tf_slack_events')} SET payload='{}'`,
        `UPDATE ${table('tf_slack_identities')} SET membership_id=gen_random_uuid()`,
        `UPDATE ${table('tf_slack_continuations')} SET event_id=gen_random_uuid()`,
        `UPDATE ${table('tf_slack_link_challenges')} SET slack_user_id='UFORGED'`,
        'SELECT * FROM app.slack_workspace_links',
      ])
        await assert.rejects(
          runtime.transaction(one.id, commonCompatibility, tx => tx.client.query(sql)),
          error => error.code === '42501',
        );
      await assert.rejects(pool.query('DELETE FROM app.slack_workspace_links'), error => error.code === '42501');
      await assert.rejects(
        pool.query(`SELECT * FROM ${table('tf_slack_installations')}`),
        error => error.code === '42501',
      );
      assert.equal(app.swagger().paths['/v1/slack/events'].post.operationId, 'receiveSlackEventV1');
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
