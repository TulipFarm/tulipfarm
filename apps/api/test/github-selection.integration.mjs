import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerGitHubAccounts } from '../src/github-accounts.ts';
import { authConfig } from '../src/auth.ts';
import { githubChatFixture } from '../../worker/test/github-read-fixture.mjs';

test('HTTP selection is owner-only, versioned, origin checked and never inferred', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const app = Fastify();
  t.after(() => app.close());
  const origin = authConfig().webOrigin;
  const auth = {
    api: {
      getSession: async ({ headers }) =>
        headers.get('cookie')
          ? {
              user: { id: headers.get('cookie') === 'owner' ? f.member.userId : f.one.userId },
              session: { id: 'session' },
            }
          : null,
    },
  };
  await app.register(async routes => registerGitHubAccounts(routes, auth, f.service, f.reads), { prefix: '/v1' });
  const chatId = await f.chat(),
    accountId = await f.connect();
  const url = `/v1/workspaces/${f.one.id}/github/chats/${chatId}/selection`;
  const request = options => app.inject({ url, headers: { origin, cookie: 'owner' }, ...options });
  assert.deepEqual((await request({})).json(), { accountId: null, generation: null, version: 0 });
  assert.equal((await request({ headers: { origin } })).statusCode, 401);
  assert.equal((await request({ headers: { origin, cookie: 'admin' } })).statusCode, 404);
  assert.equal(
    (
      await request({
        method: 'PUT',
        headers: { origin: 'https://evil.test', cookie: 'owner' },
        payload: { accountId, expectedVersion: 0 },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await request({ method: 'PUT', payload: { accountId, expectedVersion: 0, modelSelected: true } })).statusCode,
    400,
  );
  const selected = await request({ method: 'PUT', payload: { accountId, expectedVersion: 0 } });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.deepEqual(selected.json(), { accountId, generation: 1, version: 1 });
  assert.equal(selected.headers['cache-control'], 'no-store');
  assert.equal((await request({ method: 'PUT', payload: { accountId: null, expectedVersion: 0 } })).statusCode, 409);
  assert.deepEqual((await request({})).json(), { accountId, generation: 1, version: 1 });
});
