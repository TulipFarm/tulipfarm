import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import {
  createSlackInstallations,
  createSlackMemberLinking,
  createSlackInbox,
  createSlackRecovery,
  slackCredentialCipher,
} from '../src/index.ts';
import { encryptSlackToken } from '../src/credentials.ts';
import { memberProviderFixture } from './member-provider-fixture.mjs';

const config = {
  appId: 'ATEST',
  clientId: 'client',
  clientSecret: 'synthetic',
  signingSecret: 'synthetic-signing-secret',
  redirectUri: 'https://api.example.test/oauth',
  scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
  memberLinking: {
    identityRedirectUri: 'https://api.example.test/identity',
    operationalRedirectUri: 'https://api.example.test/operational',
    distribution: 'internal',
    scopeApproval: {
      reference: 'test',
      userScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
    },
  },
};

async function setup() {
  const db = await fixture();
  let runtime;
  try {
    await loadPlatformBaseline(db.platform);
    const w = await db.create(await workspaceTableMigrations());
    const table = name => qualified(w.names.schema, name);
    const installationId = randomUUID(),
      eventId = randomUUID(),
      other = randomUUID();
    const cipher = slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } });
    const bot = { workspaceId: w.id, installationId, generation: 1, kind: 'bot' };
    const credential = encryptSlackToken(cipher, bot, 'xoxe.xoxb-old', {
      refresh_token: 'xoxe-bot-old',
      expires_in: 3600,
    });
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      other,
      randomUUID(),
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'ATEST','TONE','UBOT',1,'active',$2,$3,0)`,
      [installationId, config.scopeApproval.botScopes, credential],
    );
    for (const name of ['tf_slack_installation_managers', 'tf_slack_installation_grants'])
      await db.platform.query(`INSERT INTO ${table(name)} (installation_id,membership_id) VALUES ($1,$2)`, [
        installationId,
        w.membershipId,
      ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES ($1,$2,1,'original','original',1,$3,'held')`,
      [
        eventId,
        installationId,
        { type: 'message', channel: 'DONE', user: 'UPERSON', ts: '1.000001', text: 'original request' },
      ],
    );
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 40,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const route = { workspaceId: w.id, installationId, generation: 1 };
    const events = async () =>
      (
        await db.platform.query(
          `SELECT membership_ids,invalidate FROM ${table('tf_recommendation_events')} WHERE kind='integration' ORDER BY created_at,id`,
        )
      ).rows;
    return {
      db,
      w,
      table,
      other,
      installationId,
      eventId,
      bot,
      credential,
      cipher,
      runtime,
      route,
      events,
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

test('Slack grants and identity capability events exclude replay and scope user revocation to its owner', async () => {
  const f = await setup();
  try {
    const installs = createSlackInstallations({ pool: f.db.platform, runtime: f.runtime, config, cipher: f.cipher });
    const grant = await installs.grants(f.w.id, f.w.userId);
    await installs.grants(f.w.id, f.w.userId, {
      ...grant,
      use: { memberIds: [f.w.membershipId, f.other], teamIds: [] },
    });
    assert.deepEqual((await f.events()).at(-1), { membership_ids: [f.other], invalidate: false });
    const same = await installs.grants(f.w.id, f.w.userId);
    await installs.grants(f.w.id, f.w.userId, same);
    assert.equal((await f.events()).length, 1);
    const provider = await memberProviderFixture(config);
    const linker = createSlackMemberLinking({
      runtime: f.runtime,
      config,
      cipher: f.cipher,
      installations: { route: async () => f.route },
      fetcher: provider.fetcher,
    });
    const flow = await linker.begin(f.w.id, f.eventId, f.w.userId, 'session');
    const url = new URL(flow.url),
      state = url.searchParams.get('state');
    provider.set({ nonce: url.searchParams.get('nonce') });
    await linker.proveIdentity(state, flow.browser, 'identity');
    await linker.consent(state, flow.browser, f.w.userId, 'session');
    await linker.complete(state, flow.browser, 'operational', f.w.userId, 'session');
    assert.deepEqual((await f.events()).at(-1), { membership_ids: [f.w.membershipId], invalidate: false });
    const count = (await f.events()).length;
    await assert.rejects(linker.complete(state, flow.browser, 'operational', f.w.userId, 'session'));
    assert.equal((await f.events()).length, count);
    const inbox = createSlackInbox(f.runtime);
    const revoked = {
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TONE',
      event_id: 'revoked',
      event_time: 2,
      event: { type: 'tokens_revoked', tokens: { oauth: ['UPERSON'], bot: [] } },
    };
    await inbox.accept(f.route, revoked);
    assert.deepEqual((await f.events()).at(-1), { membership_ids: [f.w.membershipId], invalidate: true });
    await inbox.accept(f.route, revoked);
    await inbox.accept(f.route, { ...revoked, event_id: 'revoked-again' });
    assert.equal((await f.events()).length, count + 1);
    await inbox.accept(f.route, {
      ...revoked,
      event_id: 'bot-revoked',
      event: { type: 'tokens_revoked', tokens: { oauth: [], bot: ['UBOT'] } },
    });
    assert.deepEqual((await f.events()).at(-1), {
      membership_ids: [f.w.membershipId, f.other].sort(),
      invalidate: true,
    });
  } finally {
    await f.close();
  }
});

test('Slack ordinary bot rotation is silent, while committed refresh rejection invalidates workspace bot facts once', async () => {
  const f = await setup();
  try {
    const expire = () =>
      f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET bot_credential=$1`, [
        { ...f.credential, rotation: { ...f.credential.rotation, expiresAt: Date.now() - 1 } },
      ]);
    await expire();
    const success = createSlackRecovery({
      runtime: f.runtime,
      config,
      cipher: f.cipher,
      fetcher: async () =>
        Response.json({
          ok: true,
          access_token: 'xoxe.xoxb-renewed',
          refresh_token: 'xoxe-bot-renewed',
          expires_in: 43200,
          token_type: 'bot',
          team: { id: 'TONE' },
          app_id: 'ATEST',
          bot_user_id: 'UBOT',
          scope: 'chat:write',
        }),
    });
    await success.refresh(f.w.id);
    assert.deepEqual(await f.events(), []);
    await expire();
    const rejected = createSlackRecovery({
      runtime: f.runtime,
      config,
      cipher: f.cipher,
      fetcher: async () => Response.json({ ok: false, error: 'invalid_auth' }),
    });
    await rejected.refresh(f.w.id);
    assert.deepEqual(await f.events(), [{ membership_ids: [f.w.membershipId, f.other].sort(), invalidate: true }]);
    await rejected.refresh(f.w.id);
    assert.equal((await f.events()).length, 1);
  } finally {
    await f.close();
  }
});
