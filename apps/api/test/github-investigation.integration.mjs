import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { registerGitHubInvestigation } from '../src/github-investigation.ts';
import { authConfig } from '../src/auth.ts';
import { githubChatFixture } from '../../worker/test/github-read-fixture.mjs';

test('investigation selection is explicit, private, versioned, and preserves legacy response shape', async t => {
  const f = await githubChatFixture();
  t.after(() => f.close());
  const service = createGitHubInvestigation({ runtime: f.runtime, accounts: f.service, keyring: f.keyring });
  const app = Fastify();
  t.after(() => app.close());
  const origin = authConfig().webOrigin;
  const auth = {
    api: {
      getSession: async ({ headers }) =>
        headers.get('cookie')
          ? { user: { id: headers.get('cookie') === 'owner' ? f.member.userId : f.one.userId } }
          : null,
    },
  };
  await app.register(async routes => registerGitHubInvestigation(routes, auth, service), { prefix: '/v1' });
  const chatId = await f.chat(),
    accountId = await f.connect();
  const url = `/v1/workspaces/${f.one.id}/github/chats/${chatId}/investigation`;
  const request = options => app.inject({ url, headers: { origin, cookie: 'owner' }, ...options });
  const initial = await request({});
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().selected, null);
  assert.equal(initial.json().investigation, false);
  assert.equal(initial.json().choices[0].id, accountId);
  assert.equal((await request({ headers: { origin } })).statusCode, 401);
  assert.equal((await request({ headers: { origin, cookie: 'admin' } })).statusCode, 404);
  const input = { choice: { kind: 'personal', id: accountId, generation: 1 }, expectedVersion: 0 };
  assert.equal(
    (await request({ method: 'PUT', headers: { origin: 'https://untrusted.test', cookie: 'owner' }, payload: input }))
      .statusCode,
    403,
  );
  assert.equal((await request({ method: 'PUT', payload: { ...input, token: 'not-accepted' } })).statusCode, 400);
  const selected = await request({ method: 'PUT', payload: input });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().selected.id, accountId);
  assert.equal(selected.json().investigation, true);
  assert.equal(selected.headers['cache-control'], 'no-store');
  assert.deepEqual(await f.reads.selection(f.one.id, f.member.userId, chatId), {
    accountId,
    generation: 1,
    version: 1,
  });
  assert.equal((await request({ method: 'PUT', payload: input })).statusCode, 409);
  const cleared = await request({ method: 'PUT', payload: { choice: null, expectedVersion: 1 } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().selected, null);
  assert.equal(
    await f.reads.current(f.one.id, { kind: 'human', ...f.member }, chatId),
    null,
    'explicit empty investigation prevents single-account auto-selection',
  );
  const ended = await request({ method: 'PUT', payload: { investigation: false, choice: null, expectedVersion: 2 } });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().investigation, false);
});
