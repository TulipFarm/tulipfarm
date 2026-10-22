import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { outboundFixture } from '../../../packages/agents/test/slack-actions.integration.mjs';
import { registerSlackActions } from '../dist/slack-actions.js';
import { protectBusinessRequests } from '../dist/business.js';

test('real HTTP destinations reject approval settings, actions send directly, and legacy web and signed Slack decisions share one immutable protected winner', async () => {
  const f = await outboundFixture(),
    app = Fastify(),
    env = { ...process.env },
    native = globalThis.fetch;
  let user = f.alice.userId;
  const config = {
    appId: 'ATEST',
    clientId: 'fixture',
    clientSecret: 'fixture',
    signingSecret: 'synthetic-signing-secret',
    redirectUri: 'https://api.example.test/oauth',
    scopeApproval: { reference: 'fixture', botScopes: ['chat:write', 'im:write'] },
    memberLinking: {
      identityRedirectUri: 'https://api.example.test/identity',
      operationalRedirectUri: 'https://api.example.test/operational',
      distribution: 'internal',
      scopeApproval: {
        reference: 'fixture',
        userScopes: [
          'channels:history',
          'groups:history',
          'im:history',
          'mpim:history',
          'chat:write',
          'reactions:write',
        ],
      },
    },
  };
  Object.assign(process.env, {
    SLACK_OUTBOUND_ENABLED: 'true',
    SLACK_CONFIGURATION: JSON.stringify(config),
    SLACK_CREDENTIAL_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } }),
    WEB_ORIGIN: 'https://app.example.test',
    BETTER_AUTH_URL: 'https://api.example.test',
  });
  globalThis.fetch = (url, init) =>
    String(url).startsWith('https://slack.com/') ? f.settings.fetcher(url, init) : native(url, init);
  app.register(
    async routes => {
      protectBusinessRequests(routes);
      registerSlackActions(routes, {
        auth: { api: { getSession: async () => (user ? { user: { id: user }, session: { id: 'fixture' } } : null) } },
        runtime: f.runtime,
        resolveConfirmationCredential: async () => f.db.login(f.workspace, 'confirmation'),
      });
    },
    { prefix: '/v1' },
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = id => `${address}/v1/workspaces/${f.workspace.id}/slack/actions/${id}`;
  async function signed(proposal, slackUser = 'UALICE', decision = 'approve', tamper = false) {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        api_app_id: 'ATEST',
        team: { id: 'TTEST' },
        user: { id: slackUser },
        actions: [
          {
            action_id: `slack_action_${decision}`,
            value: JSON.stringify({ workspaceId: f.workspace.id, actionId: proposal.id, digest: proposal.digest }),
          },
        ],
      }),
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000)),
      signature = `v0=${createHmac('sha256', config.signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    return native(`${address}/v1/slack/actions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body: tamper ? `${body}&bad=1` : body,
    });
  }
  try {
    // Destination configuration needs an explicit installation manager who belongs to the granted team.
    const denied = await native(`${address}/v1/workspaces/${f.workspace.id}/slack/destinations`, {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: f.destinationId,
        channel: 'CHR',
        name: 'HR',
        teamId: f.teamId,
        expectedVersion: 1,
        enabled: true,
      }),
    });
    assert.equal(denied.status, 404);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_slack_installation_managers')} (installation_id,membership_id) VALUES ($1,$2)`,
      [f.installationId, f.alice.membershipId],
    );
    const legacySetting = await native(`${address}/v1/workspaces/${f.workspace.id}/slack/destinations`, {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: f.destinationId,
        channel: 'CHR',
        name: 'HR',
        teamId: f.teamId,
        expectedVersion: 1,
        approvalRequired: true,
        enabled: true,
      }),
    });
    assert.equal(legacySetting.status, 400);
    const configured = await native(`${address}/v1/workspaces/${f.workspace.id}/slack/destinations`, {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: f.destinationId,
        channel: 'CHR',
        name: 'HR',
        teamId: f.teamId,
        expectedVersion: 1,
        enabled: true,
      }),
    });
    assert.equal(configured.status, 200);
    assert.deepEqual(await configured.json(), { id: f.destinationId, version: 2 });
    const listed = await (await native(`${address}/v1/workspaces/${f.workspace.id}/slack/destinations`)).json();
    assert.deepEqual(
      listed.destinations.map(item => Object.keys(item).sort()),
      [['channel', 'id', 'name', 'permissions', 'version']],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_destinations')} SET approval_required=true`);
    const direct = await f.queue();
    assert.equal(await f.executor.execute(direct.ids), 'completed');
    const sent = await (await native(path(direct.ids.callId))).json();
    assert.equal(sent.status, 'sent');
    assert.equal(sent.approvalRequired, false);
    assert.equal((await signed(sent)).status, 409);
    assert.equal(f.effects.length, 1);
    await f.legacyApproval();
    const queued = await f.queue();
    assert.equal(await f.executor.execute(queued.ids), 'waiting');
    const proposal = await (await native(path(queued.ids.callId))).json();
    assert.equal(proposal.status, 'pending');
    assert.equal((await signed(proposal, 'UALICE', 'approve', true)).status, 401);
    assert.equal((await signed(proposal, 'UBOB')).status, 404);
    assert.equal((await signed(proposal)).status, 200);
    assert.equal((await signed(proposal)).status, 200);
    const conflict = await native(path(proposal.id), {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ digest: proposal.digest, decision: 'reject' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(await f.executor.execute(queued.ids), 'completed');
    assert.equal(f.effects.length, 2);
    const b = await f.queue();
    await f.executor.execute(b.ids);
    const reject = await (await native(path(b.ids.callId))).json();
    assert.equal(
      (
        await native(path(reject.id), {
          method: 'PUT',
          headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
          body: JSON.stringify({ digest: reject.digest, decision: 'reject' }),
        })
      ).status,
      403,
    );
    user = f.bob.userId;
    assert.equal((await native(path(reject.id))).status, 404);
    user = f.alice.userId;
    const response = await native(path(reject.id), {
      method: 'PUT',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ digest: reject.digest, decision: 'reject' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'rejected');
    assert.equal(await f.executor.execute(b.ids), 'failed');
    assert.equal(f.effects.length, 2);
    assert.equal((await native(path(randomUUID()))).status, 404);
  } finally {
    globalThis.fetch = native;
    process.env = env;
    await app.close();
    await f.close();
  }
});
