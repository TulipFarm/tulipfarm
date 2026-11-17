import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copilotPremiumRequests, createPlanUsage } from '../src/plan-usage.ts';

const quota = premium => async () => Response.json({ quota_snapshots: { premium_interactions: premium } });

test("Copilot's premium requests come from the plan's quota snapshot, and only as a count", async () => {
  assert.deepEqual(await copilotPremiumRequests('t', quota({ entitlement: 300, remaining: 212.6 })), {
    remaining: 212,
    entitlement: 300,
  });
  // Overdrawn plans and stray values stay inside 0..entitlement.
  assert.deepEqual(await copilotPremiumRequests('t', quota({ entitlement: 300, remaining: -4 })), {
    remaining: 0,
    entitlement: 300,
  });
  assert.deepEqual(await copilotPremiumRequests('t', quota({ entitlement: 300, remaining: 900 })), {
    remaining: 300,
    entitlement: 300,
  });
  for (const premium of [
    { entitlement: 0, remaining: 0, unlimited: true },
    { entitlement: 300, remaining: 10, token_based_billing: true },
    { entitlement: 0, remaining: 0 },
    null,
  ])
    assert.equal(await copilotPremiumRequests('t', quota(premium)), null, JSON.stringify(premium));
  assert.equal(await copilotPremiumRequests('t', async () => new Response('no', { status: 401 })), null);
  assert.equal(await copilotPremiumRequests('t', async () => Response.json({ login: 'octocat' })), null);
});

test('plan usage reads one Copilot count per plan with its owner token and keeps it for later requests', async () => {
  const tokens = [];
  const sent = [];
  const usage = createPlanUsage({
    copilotToken: async (workspaceId, owner) => {
      tokens.push([workspaceId, owner]);
      return `token-${owner}`;
    },
    fetcher: async (url, init) => {
      sent.push([url, init.headers.authorization]);
      return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 212 } } });
    },
  });
  const own = { connectionId: 'c1', ownerMembershipId: 'me', own: true, limitedAt: null };
  const shared = {
    connectionId: 'c2',
    ownerMembershipId: 'teammate',
    own: false,
    limitedAt: new Date('2026-01-02T03:04:05Z'),
  };
  const models = [
    { slug: 'gpt-6-luna', label: 'GPT-6 Luna', plan: own },
    { slug: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', plan: own },
    { slug: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', plan: shared },
  ];
  const first = await usage('w', 'copilot', models);
  assert.deepEqual(
    first.map(model => model.usage),
    [
      {
        plan: 'own',
        status: 'available',
        limitedAt: null,
        premiumRequests: { remaining: 212, entitlement: 300 },
      },
      {
        plan: 'own',
        status: 'available',
        limitedAt: null,
        premiumRequests: { remaining: 212, entitlement: 300 },
      },
      {
        plan: 'shared',
        status: 'limit-reached',
        limitedAt: '2026-01-02T03:04:05.000Z',
        premiumRequests: { remaining: 212, entitlement: 300 },
      },
    ],
  );
  await usage('w', 'copilot', models);
  assert.deepEqual(tokens, [
    ['w', 'me'],
    ['w', 'teammate'],
  ]);
  assert.deepEqual(sent, [
    ['https://api.github.com/copilot_internal/user', 'token token-me'],
    ['https://api.github.com/copilot_internal/user', 'token token-teammate'],
  ]);

  // Other plans have no count to read.
  const [chatgpt] = await usage('w', 'chatgpt', [{ slug: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', plan: shared }]);
  assert.equal(chatgpt.usage.premiumRequests, null);
  assert.equal(tokens.length, 2);
});

test('a Copilot count that fails or is slow leaves the learned status without holding the model list', async () => {
  const plan = { connectionId: 'c1', ownerMembershipId: 'me', own: true, limitedAt: null };
  const model = [{ slug: 'gpt-6-luna', label: 'GPT-6 Luna', plan }];
  const failing = createPlanUsage({
    copilotToken: async () => {
      throw new Error('sign in again');
    },
  });
  assert.deepEqual((await failing('w', 'copilot', model))[0].usage, {
    plan: 'own',
    status: 'available',
    limitedAt: null,
    premiumRequests: null,
  });

  let release;
  const slow = createPlanUsage({
    copilotToken: async () => 'token',
    fetcher: () =>
      new Promise(resolve => {
        release = () =>
          resolve(Response.json({ quota_snapshots: { premium_interactions: { entitlement: 50, remaining: 7 } } }));
      }),
  });
  const started = Date.now();
  assert.equal((await slow('w', 'copilot', model))[0].usage.premiumRequests, null);
  assert.ok(Date.now() - started < 5_000);
  release();
  // The count that arrives late shows on the next request.
  assert.deepEqual((await slow('w', 'copilot', model))[0].usage.premiumRequests, { remaining: 7, entitlement: 50 });
});
