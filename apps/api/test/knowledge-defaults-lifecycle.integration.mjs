import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import {
  createDefaultKnowledge,
  recordDefaultKnowledgeIntent,
  defaultKnowledgeFlagEnabled,
} from '@tulipfarm/knowledge';
import { createSlackMemberLinking, slackCredentialCipher } from '@tulipfarm/slack';
import { googleFixture } from '../../../packages/google-workspace/test/fixture.mjs';
import { githubFixture } from '../../../packages/github/test/fixture.mjs';
import { accountFixture } from '../../../packages/atlassian/test/account-fixture.mjs';
import { memberProviderFixture } from '../../../packages/slack/test/member-provider-fixture.mjs';
import { fixture, loadPlatformBaseline } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { authConfig } from '../src/auth.ts';
import { registerDefaultKnowledge } from '../src/knowledge-defaults.ts';
import { defaultKnowledgeStarter } from '../src/knowledge-defaults-dispatch.ts';

const flag = 'default-connection-knowledge';
async function flagOff(operation) {
  const prior = process.env.FEATURE_FLAGS_OFF;
  process.env.FEATURE_FLAGS_OFF = flag;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.FEATURE_FLAGS_OFF;
    else process.env.FEATURE_FLAGS_OFF = prior;
  }
}
function hook() {
  const started = [];
  return {
    started,
    hook: {
      enabled: defaultKnowledgeFlagEnabled,
      record: recordDefaultKnowledgeIntent,
      started: (workspaceId, ids) => started.push({ workspaceId, ids }),
    },
  };
}
const intents = async (db, table) =>
  (
    await db.platform.query(
      `SELECT id,product,membership_id,account_key,account_label,state,sync_state FROM ${table('tf_knowledge_default_intents')} ORDER BY product,account_key`,
    )
  ).rows;

test(
  'Google records Drive and Gmail only for newly granted read scopes, after commit, without backfill',
  { timeout: 60000 },
  async () => {
    const f = await googleFixture();
    const table = name => qualified(f.workspace.names.schema, name);
    try {
      const spy = hook();
      const service = createGoogleWorkspaceService({ ...f.serviceOptions, defaultKnowledge: spy.hook });
      const connect = async (who, scopes, app) => {
        if (scopes) f.behavior({ scopes });
        else f.behavior({});
        const result = await service.begin(f.workspace.id, who, app);
        const url = new URL(result.authorizationUrl);
        f.challenge(url.searchParams.get('code_challenge'));
        return {
          state: url.searchParams.get('state'),
          complete: input => service.complete(who, { state: url.searchParams.get('state'), ...input }),
        };
      };
      const identity = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
      const denied = await connect(f.principal);
      await assert.rejects(denied.complete({ error: 'access_denied' }));
      assert.deepEqual(await intents(f.db, table), [], 'denied consent records nothing');
      await (
        await connect(f.principal, [...identity, 'https://www.googleapis.com/auth/calendar'], 'calendar')
      ).complete({ code: 'private-code' });
      assert.deepEqual(await intents(f.db, table), [], 'a non-Knowledge grant is not an eligible enablement');
      const drive = await connect(f.principal, [
        ...identity,
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive',
      ]);
      await drive.complete({ code: 'private-code' });
      let rows = await intents(f.db, table);
      assert.deepEqual(
        rows.map(row => [
          row.product,
          row.membership_id,
          row.account_key,
          row.account_label,
          row.state,
          row.sync_state,
        ]),
        [['google-drive', f.member.membershipId, 'google-account-1', 'member@example.com', 'active', 'queued']],
      );
      assert.deepEqual(
        spy.started,
        [{ workspaceId: f.workspace.id, ids: [rows[0].id] }],
        'start follows commit with the new intent only',
      );
      await assert.rejects(drive.complete({ code: 'private-code' }), 'callback replay is refused');
      const gmail = await connect(f.principal, [
        ...identity,
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/gmail.modify',
      ]);
      await gmail.complete({ code: 'private-code' });
      rows = await intents(f.db, table);
      assert.deepEqual(
        rows.map(row => row.product),
        ['gmail', 'google-drive'],
        'an incremental Gmail grant adds Gmail only',
      );
      await (await connect(f.principal)).complete({ code: 'private-code' });
      assert.equal((await intents(f.db, table)).length, 2, 'reauthorization adds nothing');
      assert.equal(spy.started.length, 2);
      await service.disconnect(f.workspace.id, f.principal.userId);
      await (await connect(f.principal)).complete({ code: 'private-code' });
      assert.equal(
        (await intents(f.db, table)).length,
        2,
        'reconnect after disconnect reuses the durable intent identity',
      );
      const admin = { userId: f.admin.userId, sessionId: randomUUID() };
      await flagOff(async () => (await connect(admin)).complete({ code: 'private-code' }));
      assert.equal(
        (await intents(f.db, table)).filter(row => row.membership_id === f.admin.membershipId).length,
        0,
        'flag off records nothing',
      );
      await (await connect(admin)).complete({ code: 'private-code' });
      assert.equal(
        (await intents(f.db, table)).filter(row => row.membership_id === f.admin.membershipId).length,
        0,
        'enabling the flag later does not backfill an existing grant',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'GitHub records one intent per first authorization, even with the flag off; replay and reconnect do not',
  { timeout: 60000 },
  async () => {
    const f = await githubFixture();
    try {
      const spy = hook();
      const service = f.makeService({ defaultKnowledge: spy.hook });
      const connect = async id => {
        f.setProfile({ id, login: `person-${id}` });
        const result = await service.begin(f.one.id, f.member.userId, 'test-session');
        const state = new URL(result.url).searchParams.get('state');
        await service.complete({ code: 'fixture-code', state }, 'test-session', f.member.userId);
        return {
          accountId: result.accountId,
          replay: () => service.complete({ code: 'fixture-code', state }, 'test-session', f.member.userId),
        };
      };
      const first = await connect(123);
      let rows = await intents(f.db, f.table);
      assert.deepEqual(
        rows.map(row => [row.product, row.account_key, row.account_label]),
        [['github', first.accountId, 'person-123']],
      );
      await assert.rejects(first.replay());
      const next = await service.reconnect(f.one.id, f.member.userId, 'test-session', first.accountId);
      await service.complete(
        { code: 'fixture-code', state: new URL(next.url).searchParams.get('state') },
        'test-session',
        f.member.userId,
      );
      assert.equal((await intents(f.db, f.table)).length, 1, 'reconnect is reauthorization');
      await connect(456);
      assert.equal((await intents(f.db, f.table)).length, 2, 'a different identity is a separate enablement');
      await flagOff(() => connect(789));
      rows = await intents(f.db, f.table);
      assert.equal(rows.length, 3, 'GitHub Knowledge is on for everyone, so the flag does not stop it');
      assert.equal(spy.started.length, 3);
    } finally {
      await f.close();
    }
  },
);

test(
  'Atlassian records Jira and Confluence only after sufficient personal REST consent; MCP stays tool-only',
  { timeout: 60000 },
  async () => {
    const f = await accountFixture();
    try {
      const spy = hook();
      const service = f.makeService({ defaultKnowledge: spy.hook });
      const scoped = scope =>
        f.setBehavior(async (url, init) =>
          url.endsWith('/token')
            ? Response.json({
                access_token: 'synthetic-access-token',
                refresh_token: 'synthetic-refresh-token',
                expires_in: 3600,
                scope,
              })
            : f.defaultBehavior(url, init),
        );
      const connect = async (protocol, ownership = 'personal') => {
        const started = await service.begin(f.one.id, f.member.userId, 'test-session', {
          protocol,
          ownership: { kind: ownership },
        });
        const state = new URL(started.url).searchParams.get('state');
        await service.complete('test-code', state, 'test-session', f.member.userId);
        return started.accountId;
      };
      scoped('offline_access read:jira-work read:page:confluence');
      await connect('atlassian-mcp');
      assert.deepEqual(await intents(f.db, f.table), [], 'MCP tools never permit indexing');
      scoped('read:me offline_access');
      await connect('atlassian-rest');
      assert.deepEqual(await intents(f.db, f.table), [], 'insufficient REST consent records nothing');
      f.setBehavior(async url =>
        url.endsWith('/token') ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : f.defaultBehavior(url),
      );
      await assert.rejects(connect('atlassian-rest'));
      assert.deepEqual(await intents(f.db, f.table), [], 'failed exchange records nothing');
      scoped('read:me offline_access read:jira-work read:page:confluence');
      const account = await connect('atlassian-rest');
      const rows = await intents(f.db, f.table);
      assert.deepEqual(
        rows.map(row => [row.product, row.account_key, row.account_label]),
        [
          ['confluence', account, 'Test person'],
          ['jira', account, 'Test person'],
        ],
      );
      assert.equal(spy.started.length, 1);
      assert.equal(spy.started[0].ids.length, 2);
      const next = await service.reconnect(f.one.id, f.member.userId, 'test-session', account);
      await service.complete('test-code', new URL(next.url).searchParams.get('state'), 'test-session', f.member.userId);
      assert.equal((await intents(f.db, f.table)).length, 2, 'REST reauthorization adds nothing');
    } finally {
      await f.close();
    }
  },
);

const slackConfig = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/v1/slack/oauth/callback',
  scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/v1/slack/link/identity',
    operationalRedirectUri: 'https://api.example.test/v1/slack/link/complete',
    distribution: 'internal',
    scopeApproval: {
      reference: 'test',
      userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
    },
  },
};

test(
  'Slack member-link completion is the enablement; installation alone and relinking are not',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await loadPlatformBaseline(db.platform);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name),
        installationId = randomUUID();
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member'`);
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_installations')}(id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES($1,'ATEST','TONE','UBOT',1,'active','{}','{}',0)`,
        [installationId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_installation_grants')}(installation_id,membership_id) SELECT $1,id FROM ${table('tf_memberships')}`,
        [installationId],
      );
      assert.deepEqual(await intents(db, table), [], 'installation alone records nothing');
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        connectionsPerPool: 4,
        reservedConnections: 2,
        databaseConnectionBudget: 40,
        resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
      });
      const provider = await memberProviderFixture(slackConfig);
      const spy = hook();
      const linker = createSlackMemberLinking({
        runtime,
        config: slackConfig,
        cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
        installations: { route: async () => ({ workspaceId: w.id, installationId, generation: 1 }) },
        fetcher: provider.fetcher,
        defaultKnowledge: spy.hook,
      });
      const link = async (deny = false) => {
        const eventId = randomUUID();
        await db.platform.query(
          `INSERT INTO ${table('tf_slack_events')}(id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES($1,$2,1,$3,$4,1,$5,'held')`,
          [
            eventId,
            installationId,
            `event-${eventId}`,
            `message:CONE:${eventId}`,
            { type: 'message', channel: 'CONE', user: 'UPERSON', ts: '1.000001', text: 'request' },
          ],
        );
        const flow = await linker.begin(w.id, eventId, w.userId, 'session');
        const url = new URL(flow.url),
          state = url.searchParams.get('state');
        provider.set({ nonce: url.searchParams.get('nonce') });
        await linker.proveIdentity(state, flow.browser, 'identity');
        await linker.consent(state, flow.browser, w.userId, 'session');
        if (deny) provider.set({ nonce: url.searchParams.get('nonce'), deny: true });
        return linker.complete(state, flow.browser, 'operational', w.userId, 'session');
      };
      await assert.rejects(link(true));
      assert.deepEqual(await intents(db, table), [], 'denied operational consent records nothing');
      await link();
      const rows = await intents(db, table);
      assert.deepEqual(
        rows.map(row => [row.product, row.account_key, row.account_label]),
        [['slack', 'TONE:UPERSON', '@UPERSON']],
        'the intent belongs to the Slack account, not one identity row',
      );
      assert.deepEqual(spy.started, [{ workspaceId: w.id, ids: [rows[0].id] }]);
      await link().catch(() => undefined);
      assert.equal((await intents(db, table)).length, 1, 'relinking an authorized identity adds nothing');
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'default Knowledge routes are owner-scoped, flag-gated and restart work with stable identity',
  { timeout: 60000 },
  async () => {
    const f = await githubFixture();
    const app = Fastify();
    try {
      const service = f.makeService({ defaultKnowledge: hook().hook });
      f.setProfile({ id: 321, login: 'route-person' });
      const begun = await service.begin(f.one.id, f.member.userId, 'test-session');
      await service.complete(
        { code: 'fixture-code', state: new URL(begun.url).searchParams.get('state') },
        'test-session',
        f.member.userId,
      );
      const defaults = createDefaultKnowledge({ runtime: f.runtime, engines: {} });
      const origin = authConfig().webOrigin;
      const sessions = new Map([
        ['session=member', { user: { id: f.member.userId }, session: { id: 'm' } }],
        ['session=admin', { user: { id: f.one.userId }, session: { id: 'a' } }],
      ]);
      const auth = { api: { getSession: async ({ headers }) => sessions.get(headers.get('cookie')) ?? null } };
      const restarted = [];
      await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'defaults', version: '1' } } });
      await app.register(
        async routes =>
          registerDefaultKnowledge(routes, {
            auth,
            service: defaults,
            enabled: defaultKnowledgeFlagEnabled,
            started: (workspaceId, ids) => restarted.push(...ids),
          }),
        { prefix: '/v1' },
      );
      await app.ready();
      const base = `/v1/workspaces/${f.one.id}/knowledge/defaults`;
      const call = async (options, status, cookie = 'session=member') => {
        const response = await app.inject({ headers: { cookie, origin }, ...options });
        assert.equal(response.statusCode, status, response.body);
        return response.json();
      };
      const list = await call({ url: base }, 200);
      assert.equal(list.enabled, true);
      assert.deepEqual(
        list.items.map(item => [item.product, item.accountLabel, item.state, item.syncState]),
        [['github', 'route-person', 'active', 'queued']],
      );
      const intentId = list.items[0].intentId;
      assert.deepEqual((await call({ url: base }, 200, 'session=admin')).items, [], 'admins do not see member intents');
      await call(
        { method: 'POST', url: `${base}/${intentId}/manage`, payload: { action: 'opt-out' } },
        404,
        'session=admin',
      );
      assert.equal(
        (await call({ method: 'POST', url: `${base}/${intentId}/manage`, payload: { action: 'opt-out' } }, 200)).state,
        'opted-out',
      );
      assert.deepEqual(restarted, []);
      assert.equal(
        (await call({ method: 'POST', url: `${base}/${intentId}/manage`, payload: { action: 'resume' } }, 200)).state,
        'active',
      );
      assert.deepEqual(restarted, [intentId], 'resume restarts the same intent');
      await call({ method: 'POST', url: `${base}/${intentId}/manage`, payload: { action: 'unknown' } }, 400);
      await flagOff(async () => {
        assert.deepEqual(await call({ url: base }, 200), { enabled: false, items: [] });
        await call({ method: 'POST', url: `${base}/${intentId}/manage`, payload: { action: 'retry' } }, 404);
      });
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_knowledge_default_intents')}`)).rows[0]
          .n,
        1,
        'flag off retains data',
      );
      const schema =
        app.swagger().paths['/v1/workspaces/{workspaceId}/knowledge/defaults'].get.responses['200'].content[
          'application/json'
        ].schema;
      assert.equal(schema.additionalProperties, false);
      const starter = defaultKnowledgeStarter(
        { log: { warn() {} } },
        {
          connection: { withDeadline: (_deadline, run) => run() },
          client: {
            workflow: {
              start: async (name, options) => {
                restarted.push([name, options.workflowId, options.args]);
              },
            },
          },
        },
      );
      starter.attach(defaults);
      await starter.start(f.one.id);
      const started = restarted.at(-1);
      assert.equal(started[0], 'knowledgeDefaultsSync');
      assert.match(started[1], new RegExp(`^knowledge-defaults-${f.one.id}-${intentId}-\\d+$`));
      assert.deepEqual(Object.keys(started[2][0]).sort(), ['generation', 'intentId', 'workspaceId']);
    } finally {
      await app.close();
      await f.close();
    }
  },
);
