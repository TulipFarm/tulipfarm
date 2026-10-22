import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { heartbeatFixture } from '../../../packages/google-workspace/test/heartbeat-fixture.mjs';
import { registerGoogleHeartbeat } from '../dist/google-heartbeat.js';
import { createGmailHeartbeat } from '@tulipfarm/google-workspace/heartbeat';

test('heartbeat HTTP contract validates commands, conceals owner data, and enforces origins and session', async () => {
  const f = await heartbeatFixture();
  const app = Fastify();
  app.register(
    async routes =>
      registerGoogleHeartbeat(routes, {
        service: createGmailHeartbeat({
          runtime: f.runtime,
          integrations: f.googleCredentials,
          providerFetch: f.providerFetch,
        }),
        auth: {
          api: {
            getSession: async ({ headers }) =>
              headers.get('cookie')
                ? { user: { id: headers.get('cookie') === 'admin' ? f.admin.userId : f.member.userId } }
                : null,
          },
        },
      }),
    { prefix: '/v1' },
  );
  try {
    const url = `/v1/workspaces/${f.workspace.id}/google-workspace/heartbeat`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const headers = { cookie: 'member', origin: 'http://localhost:5173' };
    const initial = await app.inject({ url, headers });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().cadenceMinutes, 15);
    assert.equal(initial.json().enabled, false);
    const command = {
      commandId: randomUUID(),
      revision: 0,
      enabled: true,
      query: 'from:billing@example.test',
      instructions: 'Summarize.',
    };
    assert.equal(
      (
        await app.inject({
          url,
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.test' },
          payload: command,
        })
      ).statusCode,
      403,
    );
    for (const extra of [
      { cadenceMinutes: 0 },
      { cadenceMinutes: 1441 },
      { query: 'x'.repeat(1025) },
      { instructions: 'x'.repeat(8001) },
      { userId: f.admin.userId },
    ])
      assert.equal(
        (await app.inject({ url, method: 'POST', headers, payload: { ...command, ...extra } })).statusCode,
        400,
      );
    const saved = await app.inject({ url, method: 'POST', headers, payload: command });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().revision, 1);
    assert.deepEqual((await app.inject({ url, method: 'POST', headers, payload: command })).json(), saved.json());
    assert.equal(
      (await app.inject({ url, method: 'POST', headers, payload: { ...command, instructions: 'Changed' } })).statusCode,
      409,
    );
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    await f.service.process(work, async () => 'Private summary');
    const results = await app.inject({ url: `${url}/results?limit=1`, headers });
    assert.equal(results.statusCode, 200);
    assert.equal(results.json().results[0].answer, 'Private summary');
    assert.equal(results.headers['cache-control'], 'no-store');
    assert.equal(
      (await app.inject({ url: `${url}/results`, headers: { ...headers, cookie: 'admin' } })).statusCode,
      409,
    );
    assert.equal((await app.inject({ url: `${url}/results?limit=101`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: url.replace(f.workspace.id, randomUUID()), headers })).statusCode, 503);
  } finally {
    await app.close();
    await f.close();
  }
});

test('owner retry HTTP command is idempotent, origin-bound, and preserves immutable intake', async () => {
  const f = await heartbeatFixture();
  const app = Fastify();
  app.register(
    async routes =>
      registerGoogleHeartbeat(routes, {
        service: createGmailHeartbeat({
          runtime: f.runtime,
          integrations: f.googleCredentials,
          providerFetch: f.providerFetch,
        }),
        auth: {
          api: {
            getSession: async ({ headers }) =>
              headers.get('cookie')
                ? { user: { id: headers.get('cookie') === 'admin' ? f.admin.userId : f.member.userId } }
                : null,
          },
        },
      }),
    { prefix: '/v1' },
  );
  try {
    await f.configure();
    const work = await f.work();
    await f.service.poll(work);
    await f.service.poll(work);
    await f.service.process(work, async () => {
      throw new Error('provider failure');
    });
    const failed = (await f.results()).results[0];
    assert.equal(failed.status, 'failed');
    const url = `/v1/workspaces/${f.workspace.id}/google-workspace/heartbeat/retry`;
    const headers = { cookie: 'member', origin: 'http://localhost:5173' };
    const payload = { commandId: randomUUID(), itemId: failed.id, revision: 1 };
    const request = { url, headers, method: 'POST', payload };
    assert.equal((await app.inject({ ...request, headers: { origin: headers.origin } })).statusCode, 401);
    assert.equal(
      (await app.inject({ ...request, headers: { ...headers, origin: 'https://evil.test' } })).statusCode,
      403,
    );
    assert.equal((await app.inject({ ...request, headers: { ...headers, cookie: 'admin' } })).statusCode, 404);
    assert.equal((await app.inject({ ...request, payload: { ...payload, userId: f.admin.userId } })).statusCode, 400);
    assert.equal((await app.inject({ ...request, payload: { ...payload, revision: 2 } })).statusCode, 409);
    const accepted = await app.inject(request);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { accepted: true });
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.deepEqual((await app.inject(request)).json(), { accepted: true });
    assert.equal((await app.inject({ ...request, payload: { ...payload, commandId: randomUUID() } })).statusCode, 409);
    await f.service.process(work, async () => 'Recovered answer');
    assert.deepEqual((await app.inject(request)).json(), { accepted: true });
    const recovered = (await f.results()).results[0];
    assert.equal(recovered.id, failed.id);
    assert.equal(recovered.instructions, failed.instructions);
    assert.equal(recovered.answer, 'Recovered answer');
    await f.configure({ instructions: 'New configuration' }, 1);
    assert.equal((await app.inject(request)).statusCode, 409);
  } finally {
    await app.close();
    await f.close();
  }
});
