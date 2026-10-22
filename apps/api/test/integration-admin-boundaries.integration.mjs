import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/integrations/test/fixture.mjs';
import { registerIntegrations } from '../src/integrations.ts';
import { authConfig } from '../src/auth.ts';

test('integration HTTP uses ordinary creator capabilities and denies unrelated admin self-grants', async () => {
  const f = await fixture();
  const app = Fastify();
  try {
    const auth = {
      api: {
        getSession: async ({ headers }) => ({
          user: { id: headers.get('cookie') === 'creator' ? f.member.userId : f.actor.userId },
        }),
      },
    };
    await app.register(async routes => registerIntegrations(routes, { auth, service: f.service }), { prefix: '/v1' });
    const base = `/v1/workspaces/${f.workspaceId}/integrations`;
    const request = (cookie, method, path, payload) =>
      app.inject({ method, url: `${base}${path}`, headers: { cookie, origin: authConfig().webOrigin }, payload });
    const created = await request('creator', 'POST', '', f.input);
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().capabilities.administer, true);
    assert.equal(created.body.includes(f.input.token), false);
    assert.deepEqual((await request('admin', 'GET', '')).json(), { integrations: [] });
    assert.equal((await request('admin', 'GET', `/${f.input.id}`)).statusCode, 404);
    assert.equal(
      (
        await request('admin', 'PUT', `/${f.input.id}/grants`, {
          expectedGrantsVersion: 1,
          grants: [],
          sourceGrants: [],
          personGrants: [{ memberId: f.actor.membershipId, permissions: ['read', 'use', 'manage'] }],
        })
      ).statusCode,
      404,
    );
    const recipients = await request('creator', 'GET', '/collaborators');
    assert.equal(recipients.statusCode, 200);
    assert.deepEqual(recipients.json().teams, [{ id: f.teamId, name: 'Engineering' }]);
    const shared = await request('creator', 'PUT', `/${f.input.id}/grants`, {
      expectedGrantsVersion: 1,
      grants: [],
      sourceGrants: [],
      personGrants: [
        { memberId: f.member.membershipId, permissions: ['read', 'use', 'manage'] },
        { memberId: f.actor.membershipId, permissions: ['read', 'use'] },
      ],
    });
    assert.equal(shared.statusCode, 200, shared.body);
    const visible = await request('admin', 'GET', `/${f.input.id}`);
    assert.equal(visible.statusCode, 200);
    assert.equal(visible.json().capabilities.manage, false);
    assert.equal(visible.json().repositories[0].canReadIssues, false);
    assert.equal((await request('admin', 'POST', '/read-issue', f.request())).statusCode, 404);
  } finally {
    await app.close();
    await f.close();
  }
});
