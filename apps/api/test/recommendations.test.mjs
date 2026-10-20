import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  recommend,
  combineRecommendations,
  recommendationContextFingerprint,
  fallbackRecommendations,
} from '@tulipfarm/recommendations';
import { registerRecommendations } from '../src/recommendations.ts';
import { registerRecommendationEvents } from '../src/recommendation-events.ts';

const none = {
  slack: false,
  google: false,
  github: false,
  table: null,
  workflow: false,
  knowledge: false,
  teammates: false,
};
const brands = result => result.items.flatMap(item => item.brands);

test('a new workspace shows five onboarding steps with no brand icons', () => {
  const result = recommend(none);
  assert.equal(result.onboarding, true);
  assert.deepEqual(
    result.items.map(item => item.id),
    ['connect-apps', 'create-table', 'create-workflow', 'add-knowledge', 'invite-teammate'],
  );
  assert.ok(result.items.every(item => item.kind === 'onboarding'));
  assert.deepEqual(brands(result), []);
});

test('a completed step is replaced by a prompt for what is now connected', () => {
  const result = recommend({ ...none, slack: true });
  assert.equal(result.items.length, 5);
  assert.equal(
    result.items.some(item => item.id === 'connect-apps'),
    false,
  );
  assert.equal(result.items.at(-1).id, 'slack-update');
  assert.deepEqual(brands(result), ['slack']);
});

test('after onboarding, prompts reference only connected apps and readable data', () => {
  const result = recommend({
    ...none,
    google: true,
    table: { label: 'Customers' },
    workflow: true,
    knowledge: true,
    teammates: true,
  });
  assert.equal(result.onboarding, false);
  assert.deepEqual(
    result.items.map(item => item.id),
    ['meetings', 'inbox', 'table-review', 'knowledge', 'workflows'],
  );
  assert.equal(result.items[2].label, 'Review rows in Customers');
  assert.deepEqual(brands(result), ['google-calendar', 'gmail']);
});

test('generic prompts fill the list when little is connected', () => {
  const result = recommend({
    ...none,
    github: true,
    table: { label: 'Orders' },
    workflow: true,
    knowledge: true,
    teammates: true,
  });
  assert.deepEqual(
    result.items.map(item => item.id),
    ['table-review', 'github', 'knowledge', 'workflows', fallbackRecommendations[0].id],
  );
  assert.ok(fallbackRecommendations.every(item => item.brands.length === 0 && item.action.kind === 'prompt'));
});

test('generated prompts retain onboarding and are invalidated when visible inputs change', () => {
  const generated = [
    {
      id: 'generated',
      kind: 'prompt',
      label: 'Review current customers',
      brands: [],
      action: { kind: 'prompt', prompt: 'Review my current customers without changing records.' },
    },
  ];
  const result = combineRecommendations(
    none,
    generated.map(item => ({ ...item, sources: [] })),
  );
  assert.deepEqual(
    result.items.map(item => item.id),
    ['connect-apps', 'create-table', 'create-workflow', 'add-knowledge', 'invite-teammate'],
  );
  assert.notEqual(
    recommendationContextFingerprint({
      policy: 'event-driven-v1',
      signals: { ...none, table: { label: 'Customers' } },
      entries: [],
    }),
    recommendationContextFingerprint({ policy: 'event-driven-v1', signals: none, entries: [] }),
  );
});

test('all HTTP reads perform only authorization and saved-state SELECTs, including failures', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const workspaceId = '10000000-0000-4000-8000-000000000001';
  const membershipId = '10000000-0000-4000-8000-000000000002';
  const userId = '10000000-0000-4000-8000-000000000003';
  let snapshot,
    authorized = true,
    commonVersion = 30;
  const queries = [];
  const runtime = {
    transaction: async (_workspaceId, _compatibility, operation) =>
      operation({
        schema: 'fixture',
        workspaceId,
        commonVersion,
        client: {
          query: async (sql, values) => {
            queries.push(sql);
            assert.match(sql, /^SELECT /, 'a GET may never write or enqueue');
            if (sql.includes('tf_authorization_lock')) return { rowCount: 1, rows: [{ id: 1 }] };
            if (sql.includes('tf_memberships')) {
              assert.deepEqual(values, [userId]);
              return { rows: authorized ? [{ id: membershipId, user_id: userId, role: 'member' }] : [] };
            }
            assert.match(sql, /tf_recommendation_refresh/);
            assert.doesNotMatch(sql, /tf_(?:personal_memory|projects|files|table_generations|recommendation_events)/);
            assert.deepEqual(values, [membershipId]);
            return { rows: snapshot ? [snapshot] : [] };
          },
        },
      }),
  };
  const auth = { api: { getSession: async () => ({ user: { id: userId } }) } };
  registerRecommendations(app, { runtime, auth });
  registerRecommendationEvents(app, { runtime, auth, eligible: async () => true, events: { healthy: () => false } });
  for (let index = 0; index < 10; index++) {
    const response = await app.inject(`/workspaces/${workspaceId}/recommendations`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items.length, 5);
    assert.equal(response.json().status, 'unavailable');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(queries.length, 30, 'each read performs exactly two authorization reads and one saved-state read');
  snapshot = {
    refresh_generation: '3',
    snapshot_generation: '2',
    status: 'budget-paused',
    policy: 'event-driven-v1',
    onboarding: false,
    items: fallbackRecommendations,
    sources: [],
  };
  assert.equal((await app.inject(`/workspaces/${workspaceId}/recommendations`)).json().status, 'budget-paused');
  const logged = t.mock.method(app.log, 'error', () => {});
  snapshot.items = [{ private: 'corrupt fixture' }];
  const corrupt = await app.inject(`/workspaces/${workspaceId}/recommendations`);
  assert.equal(corrupt.statusCode, 500);
  assert.equal(logged.mock.callCount(), 1);
  assert.doesNotMatch(corrupt.body, /private|corrupt fixture/);
  commonVersion = 0;
  const before = queries.length;
  assert.equal((await app.inject(`/workspaces/${workspaceId}/recommendations`)).json().status, 'unavailable');
  assert.equal(queries.length - before, 2, 'old schemas never scan business context');
  authorized = false;
  assert.equal((await app.inject(`/workspaces/${workspaceId}/recommendations`)).statusCode, 404);
  assert.equal((await app.inject(`/workspaces/${workspaceId}/recommendations/events`)).statusCode, 404);
  authorized = true;
  assert.equal((await app.inject(`/workspaces/${workspaceId}/recommendations/events`)).statusCode, 503);
});
