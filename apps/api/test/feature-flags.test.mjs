import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerExtension, resetExtensions } from '@tulipfarm/extensions';
import { featureFlagNames } from '@tulipfarm/config/feature-flags';
import { registerFeatureFlags } from '../src/feature-flags.ts';

function fixture(t, getSession, workspaceFor) {
  const app = Fastify();
  app.register(
    async routes => {
      registerFeatureFlags(routes, { api: { getSession } }, workspaceFor);
    },
    { prefix: '/v1' },
  );
  t.after(() => app.close());
  return app;
}

test('feature flags require a session and never read a workspace for guests', async t => {
  const app = fixture(
    t,
    async () => null,
    async () => assert.fail('Guests must not resolve a workspace'),
  );
  const response = await app.inject('/v1/feature-flags?workspace=acme');
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'sign-in-required' });
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('feature flags return every registered flag as a boolean snapshot', async t => {
  const app = fixture(t, async () => ({ user: { id: 'user-1', email: 'ada@example.test' } }));
  const response = await app.inject('/v1/feature-flags');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), [...featureFlagNames].sort());
  for (const value of Object.values(body)) assert.equal(typeof value, 'boolean');
});

test('feature flags evaluate the provider with the user and only a workspace the user belongs to', async t => {
  t.after(resetExtensions);
  const subjects = [];
  await registerExtension(
    {
      name: 'flags-fixture',
      register(slots) {
        slots.flagProvider({
          isEnabled: async (flag, subject) => {
            subjects.push(subject);
            return flag === 'slack-app-sender' && subject.workspace?.id === 'w1';
          },
        });
      },
    },
    { app: 'api', env: {} },
  );
  const lookups = [];
  const app = fixture(
    t,
    async ({ headers }) => {
      assert.equal(headers.get('cookie'), 'session=fixture');
      return { user: { id: 'user-1', email: 'ada@example.test' } };
    },
    async (userId, slug) => {
      lookups.push([userId, slug]);
      return slug === 'acme' ? { id: 'w1', name: 'Acme', slug: 'acme' } : null;
    },
  );
  const read = async workspace => {
    const response = await app.inject({
      url: `/v1/feature-flags${workspace ? `?workspace=${workspace}` : ''}`,
      headers: { cookie: 'session=fixture' },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  assert.equal((await read('acme'))['slack-app-sender'], true);
  assert.deepEqual(subjects.at(-1), {
    user: { id: 'user-1', email: 'ada@example.test' },
    workspace: { id: 'w1', name: 'Acme' },
  });
  assert.equal((await read('other'))['slack-app-sender'], false, 'a workspace the user cannot read is ignored');
  assert.deepEqual(subjects.at(-1), { user: { id: 'user-1', email: 'ada@example.test' } });
  assert.equal((await read())['slack-app-sender'], false);
  assert.deepEqual(lookups, [
    ['user-1', 'acme'],
    ['user-1', 'other'],
  ]);
});

test('feature flags reject an invalid workspace parameter', async t => {
  const app = fixture(
    t,
    async () => ({ user: { id: 'user-1' } }),
    async () => assert.fail('Invalid input must not resolve a workspace'),
  );
  const response = await app.inject(`/v1/feature-flags?workspace=${'a'.repeat(256)}`);
  assert.equal(response.statusCode, 400);
});
