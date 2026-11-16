import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createWorkspaceSchema } from '@tulipfarm/workspaces/contracts';
import { registerOnboarding } from '../src/onboarding.ts';
import { registerAbuseHooks } from '../src/abuse.ts';

test('anonymous URL checks reveal only availability and use creation slug validation', async t => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [{ taken: values[0] !== 'free-studio' }] };
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  registerOnboarding(app, { auth: { api: {} }, pool }, undefined, async () => {});
  const check = slug => app.inject({ method: 'POST', url: '/onboarding/availability', payload: { slug } });
  for (const slug of ['taken-studio', 'another-studio', 'free-studio']) {
    const response = await check(slug);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { available: slug === 'free-studio' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(queries.at(-1).values, [slug]);
  }
  for (const slug of ['Taken-Studio', ' taken-studio ', 'login', 'LOGIN', 'a', 'two--hyphens', 'a'.repeat(49)]) {
    assert.equal(createWorkspaceSchema.shape.slug.safeParse(slug).success, false);
    const count = queries.length;
    assert.equal((await check(slug)).statusCode, 400, slug);
    assert.equal(queries.length, count, 'Invalid slugs must not reach storage');
  }
});

test('URL checks use a separate per-IP budget and can be retried after throttling', async t => {
  const hits = new Map();
  const policies = [];
  let queries = 0;
  const app = Fastify();
  t.after(() => app.close());
  const auth = { api: { getSession: async () => null } };
  registerAbuseHooks(
    app,
    async (policy, identity) => {
      policies.push(policy);
      const current = (hits.get(identity) ?? 0) + 1;
      hits.set(identity, current);
      return current > policy.max ? 60 : null;
    },
    auth,
  );
  app.register(
    async routes =>
      registerOnboarding(
        routes,
        {
          auth,
          pool: {
            async query() {
              queries++;
              return { rows: [{ taken: false }] };
            },
          },
        },
        undefined,
        async () => {},
      ),
    { prefix: '/v1' },
  );
  const check = remoteAddress =>
    app.inject({
      method: 'POST',
      url: '/v1/onboarding/availability',
      remoteAddress,
      payload: { slug: 'free-studio' },
    });
  assert.equal((await check('192.0.2.1')).statusCode, 200);
  const policy = policies[0];
  assert.equal(policy.name, 'onboarding-availability');
  assert.equal(policy.windowMs, 60_000);
  for (let index = 1; index < policy.max; index++) assert.equal((await check('192.0.2.1')).statusCode, 200);
  const blocked = await check('192.0.2.1');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(queries, policy.max, 'Throttled checks must not reach storage');
  assert.equal((await check('192.0.2.2')).statusCode, 200);
  hits.clear();
  assert.equal((await check('192.0.2.1')).statusCode, 200);
});
