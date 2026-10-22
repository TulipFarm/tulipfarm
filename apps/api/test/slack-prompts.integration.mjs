import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerSlack } from '../src/slack.ts';
import { createSlackInbox } from '@tulipfarm/slack';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';

test('signed HTTP intake survives API restart and produces one account-link DM', async () => {
  const f = await promptFixture();
  let app;
  const secret = 'local-test-signing-secret';
  const config = {
    appId: 'ATEST',
    clientId: 'client',
    clientSecret: 'synthetic',
    signingSecret: secret,
    redirectUri: 'https://api.example.test/callback',
    scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
  };
  const start = async () => {
    app = Fastify();
    app.register(
      async routes =>
        registerSlack(
          routes,
          { api: { getSession: async () => null } },
          {
            config,
            inbox: createSlackInbox(f.runtime),
            installations: {
              route: async () => ({ workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 }),
            },
          },
        ),
      { prefix: '/v1' },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    return app.server.address().port;
  };
  try {
    let port = await start();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TONE',
      event_id: 'signed-first-request',
      event_time: Number(timestamp),
      event: { type: 'message', user: 'UHTTP', channel: 'DHTTP', ts: '123.000001', text: 'PRIVATE HTTP REQUEST' },
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${payload}`).digest('hex')}`,
    };
    const send = () => fetch(`http://127.0.0.1:${port}/v1/slack/events`, { method: 'POST', headers, body: payload });
    assert.deepEqual(await (await send()).json(), { accepted: true, duplicate: false, execution: 'disabled' });
    await app.close();
    port = await start();
    assert.deepEqual(await (await send()).json(), { accepted: true, duplicate: true, execution: 'disabled' });
    const [work] = await f.prompts.discover(f.workspace.id);
    assert.equal(await f.prompts.process(work), 'sent');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.channel, 'DHTTP');
    assert.equal(JSON.stringify(f.requests[0]).includes('PRIVATE HTTP REQUEST'), false);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_slack_events')}`)).rows[0].n,
      1,
    );
  } finally {
    await app?.close();
    await f.close();
  }
});

test('signed channel mention gets a private in-channel link with channel execution disabled', async () => {
  const f = await promptFixture();
  const app = Fastify();
  const secret = 'local-test-signing-secret';
  const config = {
    appId: 'ATEST',
    clientId: 'client',
    clientSecret: 'synthetic',
    signingSecret: secret,
    redirectUri: 'https://api.example.test/callback',
    scopeApproval: { reference: 'test', botScopes: ['chat:write'] },
  };
  app.register(
    async routes =>
      registerSlack(
        routes,
        { api: { getSession: async () => null } },
        {
          config,
          inbox: createSlackInbox(f.runtime),
          installations: {
            route: async () => ({ workspaceId: f.workspace.id, installationId: f.installationId, generation: 1 }),
          },
        },
      ),
    { prefix: '/v1' },
  );
  try {
    await app.ready();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: 'event_callback',
      api_app_id: 'ATEST',
      team_id: 'TONE',
      event_id: 'signed-channel-mention',
      event_time: Number(timestamp),
      event: {
        type: 'app_mention',
        user: 'UHTTP',
        channel: 'CHTTP',
        ts: '123.000001',
        text: '<@UBOT> PRIVATE HTTP REQUEST',
      },
    });
    const headers = {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${payload}`).digest('hex')}`,
    };
    const send = () => app.inject({ method: 'POST', url: '/v1/slack/events', headers, payload });
    assert.deepEqual((await send()).json(), { accepted: true, duplicate: false, execution: 'disabled' });
    assert.deepEqual((await send()).json(), { accepted: true, duplicate: true, execution: 'disabled' });
    const work = await f.prompts.discover(f.workspace.id);
    assert.equal(work.length, 1, 'an unlinked channel mention must produce an account-link prompt');
    assert.equal(await f.prompts.process(work[0]), 'sent');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'chat.postEphemeral');
    assert.equal(f.requests[0].body.channel, 'CHTTP');
    assert.equal(f.requests[0].body.user, 'UHTTP');
    assert.equal(f.requests[0].body.thread_ts, undefined);
    assert.match(f.requests[0].body.text, /Link your TulipFarm account/);
    assert.equal(JSON.stringify(f.requests[0]).includes('PRIVATE HTTP REQUEST'), false);
    assert.deepEqual(await f.prompts.discover(f.workspace.id), []);
  } finally {
    await app.close();
    await f.close();
  }
});
