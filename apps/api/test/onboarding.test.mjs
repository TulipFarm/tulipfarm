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

test('website lookup accepts only a homepage whose domain matches the business name', async () => {
  const { matchesName } = await import('../src/onboarding-website.ts');
  assert.equal(matchesName('www.haldiram.com', 'Haldiram'), true);
  assert.equal(matchesName('basecamp.com', 'Basecamp'), true);
  assert.equal(matchesName('shop.acme.co.uk', 'Acme Ltd'), true);
  assert.equal(matchesName('www.chaipoint.com', 'Chai Point'), true);
  assert.equal(matchesName('www.linkedin.com', 'LinkedIn'), false, 'Directories are never a business website');
  assert.equal(matchesName('example.com', 'Basecamp'), false);
  assert.equal(matchesName('ab.com', 'AB'), false, 'Too short to match safely');
});

test('model turns move one stage at a time, except that follow-ups are optional', async () => {
  const { applyModelTurn } = await import('../src/onboarding-interviewer.ts');
  const { emptyOnboardingProfile } = await import('@tulipfarm/workspaces/onboarding-interview');
  const turn = next_stage => ({
    reply: 'Okay.',
    site_summary: null,
    goal_id: null,
    goal_text: null,
    about: null,
    persona: null,
    answer: null,
    next_stage,
    suggestions: [],
    agents: [],
  });
  const request = (stage, kind = 'message') => ({
    message: 'Hello',
    kind,
    stage,
    profile: emptyOnboardingProfile,
    workspaceName: 'Basecamp',
    visitorName: null,
  });
  assert.equal(applyModelTurn(request('about', 'open'), turn('agents')).stage, 'about');
  assert.equal(applyModelTurn(request('about'), turn('agents')).stage, 'goal');
  assert.equal(applyModelTurn(request('goal'), turn('agents')).stage, 'agents');
  assert.equal(applyModelTurn(request('goal'), turn('signup')).stage, 'agents');
  assert.ok(applyModelTurn(request('goal'), turn('agents')).agents.length > 0, 'Agents fall back to the goal');
});

test('Bud continues the chat with the picked agents and remembers the business', async () => {
  const { onboardingSeed } = await import('../src/onboarding-continuation.ts');
  const { emptyOnboardingProfile } = await import('@tulipfarm/workspaces/onboarding-interview');
  const seed = onboardingSeed({
    workspaceName: 'Basecamp',
    messages: [
      { role: 'assistant', content: 'Hi Asha.' },
      { role: 'user', content: 'We make project software.' },
    ],
    profile: {
      ...emptyOnboardingProfile,
      about: 'We make project software.',
      website: 'https://basecamp.com/',
      goal: { id: 'customer-messages', text: 'Answer support emails' },
      selectedAgents: ['email-replies', 'customer-list'],
    },
  });
  assert.equal(seed.messages.length, 2);
  assert.match(seed.welcome, /Let’s build Email replies and Customer list, starting with Email replies\./);
  assert.match(
    seed.request,
    /^Build the Email replies agent for Basecamp\. .* After that, I also want Customer list\.$/,
  );
  assert.match(seed.memory, /About Basecamp: We make project software\./);
  assert.match(seed.memory, /What I want agents to help with first: Answer support emails/);

  const none = onboardingSeed({ workspaceName: 'Basecamp', messages: [], profile: emptyOnboardingProfile });
  assert.equal(none.request, null, 'Nothing is built for them without a pick');
  assert.equal(none.memory, '');
});
