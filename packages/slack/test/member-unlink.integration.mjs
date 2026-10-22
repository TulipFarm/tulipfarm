import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createSlackMemberLinking, slackCredentialCipher } from '../src/index.ts';
import { memberProviderFixture } from './member-provider-fixture.mjs';

const config = {
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
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const stage of ['before-proof', 'after-proof', 'identity-exchange', 'operational-exchange', 'consent-race'])
  test(`unlink fences ${stage} without requiring an identity row`, async () => {
    const db = await fixture();
    let runtime;
    try {
      await loadPlatformBaseline(db.platform);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name),
        installationId = randomUUID(),
        eventId = randomUUID();
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member'`);
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_installations')}(id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES($1,'ATEST','TONE','UBOT',1,'active','{}','{}',0)`,
        [installationId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_installation_grants')}(installation_id,membership_id) SELECT $1,id FROM ${table('tf_memberships')}`,
        [installationId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_events')}(id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES($1,$2,1,'original','message:CONE:1.000001',1,$3,'held')`,
        [
          eventId,
          installationId,
          { type: 'message', channel: 'CONE', user: 'UPERSON', ts: '1.000001', text: 'original request' },
        ],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        connectionsPerPool: 4,
        reservedConnections: 2,
        databaseConnectionBudget: 40,
        resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
      });
      const provider = await memberProviderFixture(config);
      const linker = createSlackMemberLinking({
        runtime,
        config,
        cipher: slackCredentialCipher({ activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } }),
        installations: { route: async () => ({ workspaceId: w.id, installationId, generation: 1 }) },
        fetcher: provider.fetcher,
      });
      const flow = await linker.begin(w.id, eventId, w.userId, 'session');
      const otherAttempt = await linker.begin(w.id, eventId, w.userId, 'another-session');
      const url = new URL(flow.url),
        state = url.searchParams.get('state'),
        nonce = url.searchParams.get('nonce');
      provider.set({ nonce });
      const prove = () => linker.proveIdentity(state, flow.browser, 'identity');
      const consent = () => linker.consent(state, flow.browser, w.userId, 'session');
      const complete = () => linker.complete(state, flow.browser, 'operational', w.userId, 'session');
      const unlink = () => linker.unlink(w.id, w.userId);
      if (['after-proof', 'operational-exchange', 'consent-race'].includes(stage)) await prove();
      if (stage === 'operational-exchange') await consent();
      if (stage.endsWith('exchange')) {
        const entered = deferred(),
          release = deferred();
        provider.set({
          nonce,
          during: async () => {
            entered.resolve();
            await release.promise;
          },
        });
        const inFlight = (stage === 'identity-exchange' ? prove() : complete()).then(
          value => ({ value }),
          error => ({ error }),
        );
        await entered.promise;
        assert.equal((await unlink()).state, 'revoked');
        release.resolve();
        assert.ok((await inFlight).error, 'the in-flight exchange must reject after unlink');
      } else if (stage === 'consent-race') {
        const outcomes = await Promise.allSettled([consent(), unlink()]);
        assert.equal(outcomes[1].status, 'fulfilled');
      } else assert.equal((await unlink()).state, 'revoked');
      provider.set({ nonce });
      await assert.rejects(prove());
      await assert.rejects(consent());
      await assert.rejects(complete());
      await assert.rejects(
        linker.proveIdentity(new URL(otherAttempt.url).searchParams.get('state'), otherAttempt.browser, 'identity'),
      );
      assert.deepEqual((await db.platform.query(`SELECT stage FROM ${table('tf_slack_link_challenges')}`)).rows, [
        { stage: 'used' },
        { stage: 'used' },
      ]);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_slack_identities')} WHERE state='authorized' OR credential IS NOT NULL`,
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_slack_continuations')} WHERE state='dispatch-held'`,
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await db.platform.query(`SELECT payload->>'text' AS text FROM ${table('tf_slack_events')}`)).rows[0].text,
        'original request',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  });
