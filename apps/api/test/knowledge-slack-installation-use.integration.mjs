import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import {
  createSlackInstallations,
  createSlackInbox,
  slackCredentialCipher,
} from '../../../packages/slack/src/index.ts';
import { createSlackCorpusProvider, slackCorpusCredentials } from '../../../packages/slack/src/corpus-provider.ts';
import { registerSlack } from '../src/slack.ts';
import { authConfig } from '../src/auth.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity } from '../src/security.ts';
import { knowledgeFixture } from './knowledge-fixture.mjs';

const config = {
  appId: 'AUSEGRANT',
  clientId: 'client',
  clientSecret: 'synthetic-client-secret',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
  scopeApproval: { reference: 'test-only-not-approved-manifest', botScopes: ['channels:read', 'groups:read'] },
};
const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ef'.repeat(32) } });

test(
  'Slack Knowledge corpus use follows the installation use grant, not a retained member link',
  { timeout: 180000 },
  async t => {
    const userToken = `xoxp-synthetic-${randomUUID()}`;
    const userCalls = [];
    const fetcher = async (input, init) => {
      const url = new URL(String(input));
      const method = url.pathname.split('/').pop();
      if (method === 'oauth.v2.access')
        return Response.json({
          ok: true,
          app_id: config.appId,
          team: { id: 'TUSEGRANT' },
          token_type: 'bot',
          bot_user_id: 'UBOT',
          access_token: 'xoxb-synthetic-secret',
          scope: 'channels:read,groups:read',
        });
      assert.equal(init.headers.authorization, `Bearer ${userToken}`);
      userCalls.push(method);
      if (method === 'users.conversations')
        return Response.json({
          ok: true,
          channels: [{ id: 'GPRIVATE', name: 'leadership', is_private: true, is_member: true }],
          response_metadata: { next_cursor: '' },
        });
      assert.equal(method, 'conversations.info');
      return Response.json({
        ok: true,
        channel: { id: 'GPRIVATE', name: 'leadership', is_private: true, is_member: true, is_archived: false },
      });
    };
    const f = await knowledgeFixture({
      slackCorpus: runtime =>
        createSlackCorpusProvider({
          credentials: slackCorpusCredentials({ runtime, appId: config.appId, cipher }),
          fetcher,
        }),
    });
    const identityRole = `slack_identity_${randomUUID().replaceAll('-', '')}`;
    let pool, app;
    try {
      const member = await f.signed.signIn();
      const membershipId = randomUUID();
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        membershipId,
        member.id,
      ]);
      const password = randomUUID();
      await f.db.admin.query(`CREATE ROLE ${escapeIdentifier(identityRole)} LOGIN PASSWORD ${escapeLiteral(password)}`);
      const identityUrl = new URL(f.db.connectionString);
      await f.db.platform.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(identityUrl.pathname.slice(1))} TO ${escapeIdentifier(identityRole)}; GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(identityRole)}; GRANT SELECT,INSERT ON app.slack_workspace_links TO ${escapeIdentifier(identityRole)}; GRANT UPDATE (team_id,generation,state,state_hash,session_id,user_id,membership_id,expires_at) ON app.slack_workspace_links TO ${escapeIdentifier(identityRole)}; GRANT SELECT,INSERT,UPDATE,DELETE ON app.users,app.accounts,app.sessions,app.verifications TO ${escapeIdentifier(identityRole)}`,
      );
      identityUrl.username = identityRole;
      identityUrl.password = password;
      pool = new Pool({ connectionString: identityUrl.href, max: 4, options: '-c search_path=app' });
      app = Fastify();
      registerSecurity(app, authConfig().webOrigin);
      await app.register(swagger, {
        openapi: { info: { title: 'Slack Knowledge installation use test', version: '1' } },
      });
      await app.register(
        async v1 => {
          protectBusinessRequests(v1);
          registerSlack(v1, f.signed.auth, {
            config,
            installations: createSlackInstallations({ pool, runtime: f.runtime, config, cipher, fetcher }),
            inbox: createSlackInbox(f.runtime),
          });
        },
        { prefix: '/v1' },
      );
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const slack = async (method, path, cookie, body) => {
        const response = await fetch(`${address}/v1/workspaces/${f.workspace.id}/slack${path}`, {
          method,
          headers: { cookie, origin: authConfig().webOrigin, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      };
      const begun = await slack('POST', '/install', f.signed.owner.cookie);
      assert.equal(begun.status, 200);
      const callback = await fetch(
        `${address}/v1/slack/oauth/callback?code=synthetic-code&state=${new URL(begun.body.url).searchParams.get('state')}`,
        { headers: { cookie: f.signed.owner.cookie, origin: authConfig().webOrigin } },
      );
      assert.equal(callback.status, 200);
      const setUse = async granted => {
        const current = (await slack('GET', '/grants', f.signed.owner.cookie)).body;
        const memberIds = current.use.memberIds.filter(id => id !== membershipId);
        const result = await slack('PUT', '/grants', f.signed.owner.cookie, {
          ...current,
          use: { ...current.use, memberIds: granted ? [...memberIds, membershipId] : memberIds },
        });
        assert.equal(result.status, 200);
      };
      await setUse(true);
      const installation = (await f.db.platform.query(`SELECT id,generation FROM ${f.table('tf_slack_installations')}`))
        .rows[0];
      const identityId = randomUUID();
      const credential = cipher.encrypt(
        {
          workspaceId: f.workspace.id,
          installationId: installation.id,
          generation: installation.generation,
          kind: 'user',
          identityId,
          membershipId,
          slackUserId: 'UMEMBER',
        },
        userToken,
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes,authorized_at) VALUES ($1,$2,$3,'UMEMBER',$4,$5,'authorized',$6,$7,now())`,
        [
          identityId,
          installation.id,
          installation.generation,
          member.id,
          membershipId,
          credential,
          ['channels:read', 'channels:history', 'groups:read', 'groups:history'],
        ],
      );
      const options = { cookie: member.cookie };
      const discover = () => f.call('/slack/discover?kind=channels', options);
      const configure = after =>
        f.call('/slack/sources', {
          ...options,
          method: 'POST',
          body: {
            commandId: randomUUID(),
            selection: { kind: 'channels', conversationIds: ['GPRIVATE'], after },
            memberIds: [],
          },
        });
      const day = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let sourceId;

      await t.test('a granted member discovers and configures with their own linked identity', async () => {
        const found = await discover();
        assert.equal(found.status, 200, found.bytes.toString());
        assert.deepEqual(
          found.json().items.map(item => item.conversationId),
          ['GPRIVATE'],
        );
        const configured = await configure(day(30));
        assert.equal(configured.status, 200, configured.bytes.toString());
        sourceId = configured.json().sourceId;
        assert.deepEqual(userCalls, ['users.conversations', 'conversations.info']);
      });
      await t.test(
        'removing the use grant stops corpus use of the retained identity before any Slack call',
        async () => {
          await setUse(false);
          assert.equal(
            (await f.db.platform.query(`SELECT state FROM ${f.table('tf_slack_identities')} WHERE id=$1`, [identityId]))
              .rows[0].state,
            'authorized',
          );
          const before = userCalls.length;
          const found = await discover();
          assert.equal(found.status, 409);
          assert.deepEqual(found.json(), { error: 'slack-not-linked' });
          const configured = await configure(day(7));
          assert.equal(configured.status, 409);
          assert.deepEqual(configured.json(), { error: 'slack-not-linked' });
          const refreshed = await f.call(`/slack/sources/${sourceId}/refresh`, { ...options, method: 'POST' });
          assert.deepEqual(refreshed.json(), { refreshed: 0, unavailable: 1, bounded: true });
          assert.equal(userCalls.length, before);
        },
      );
      await t.test('restoring the use grant restores corpus use', async () => {
        await setUse(true);
        const found = await discover();
        assert.equal(found.status, 200, found.bytes.toString());
        assert.deepEqual(
          found.json().items.map(item => item.conversationId),
          ['GPRIVATE'],
        );
        assert.equal(userCalls.at(-1), 'users.conversations');
      });
    } finally {
      await app?.close();
      await pool?.end();
      await f.close();
      const cleanup = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      try {
        await cleanup.query(`DROP ROLE IF EXISTS ${escapeIdentifier(identityRole)}`);
      } finally {
        await cleanup.end();
      }
    }
  },
);
