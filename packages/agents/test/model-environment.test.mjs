import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelEnvironment } from '../src/model-environment.ts';
import { reasoningRequestFields } from '@tulipfarm/config';
import { routeCapabilities } from '../src/inference.ts';

const grok = (id, reasoningEffort, overrides = {}) => ({
  id,
  name: id,
  vendor: 'xai',
  routes: [{ provider: 'azure', model: 'grok-4.3' }],
  limits: { maxInputTokens: 200000, maxOutputTokens: 8192 },
  capabilities: { reasoningTokensInOutput: true, reasoningEffort },
  pricing: [{ usdPerMillionTokens: { input: 1.25, output: 2.5 } }],
  ...overrides,
});
const env = {
  AZURE_FOUNDRY_API_KEY: 'test-azure',
  AZURE_FOUNDRY_ENDPOINT: 'https://example.services.ai.azure.com/',
  MODEL_CATALOG: JSON.stringify({
    version: 1,
    models: [
      grok('grok-fast', 'low', { default: true }),
      grok('grok-fast-quick', 'none', { selectable: false, roles: ['title'] }),
    ],
  }),
};

test('catalog models sharing a deployment each send their own reasoning effort', t => {
  const previous = process.env.MODEL_CATALOG;
  process.env.MODEL_CATALOG = env.MODEL_CATALOG;
  t.after(() => {
    if (previous === undefined) delete process.env.MODEL_CATALOG;
    else process.env.MODEL_CATALOG = previous;
  });
  const environment = modelEnvironment(env);
  const effort = id => {
    const capabilities = routeCapabilities(environment.inference(environment.resolve(id)));
    return [capabilities.reasoningEffort, reasoningRequestFields(capabilities)];
  };
  assert.deepEqual(effort('grok-fast'), ['low', { reasoning_effort: 'low' }]);
  assert.deepEqual(effort('grok-fast-quick'), ['none', { reasoning_effort: 'none' }]);
});

const planEnv = {
  ...env,
  MODEL_CATALOG: JSON.stringify({
    version: 1,
    models: [
      grok('grok-fast', 'low', { default: true }),
      grok('chatgpt-luna', 'low', {
        vendor: 'openai',
        routes: [{ provider: 'chatgpt', model: 'gpt-6-luna' }],
        pricing: 'unmetered',
        fallback: 'grok-fast',
      }),
    ],
  }),
};
const planInput = {
  prompt: 'Synthetic prompt only.',
  definition: { name: 'Synthetic agent', instructions: 'Answer.', tools: [] },
  scope: [],
};
const planHealth = () => ({ claim: async () => true, finish: async () => {} });
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

test("a plan model answers on the member's plans in turn and never falls back", async t => {
  const previous = process.env.MODEL_CATALOG;
  process.env.MODEL_CATALOG = planEnv.MODEL_CATALOG;
  t.after(() => {
    if (previous === undefined) delete process.env.MODEL_CATALOG;
    else process.env.MODEL_CATALOG = previous;
  });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(options.headers.authorization ?? options.headers.Authorization);
    if (sent.length === 1)
      return Response.json(
        { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached' } },
        { status: 429 },
      );
    const response = {
      model: 'gpt-6-luna',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Plan answer.' }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    return new Response(sse([{ type: 'response.completed', response }]), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const tokens = { 'connection-own': 'synthetic-own', 'connection-team': 'synthetic-team' };
  let connection = 'connection-own';
  const asked = [],
    moved = [];
  let answered = 0;
  const environment = modelEnvironment(planEnv);
  const continuity = environment.continuity(planHealth, undefined, async request => {
    asked.push(request);
    return {
      token: tokens[connection],
      next: async failure => {
        moved.push(failure);
        connection = 'connection-team';
        return { token: tokens[connection] };
      },
      source: () => ({ connectionId: connection, switched: null }),
      answered: async () => void answered++,
    };
  });
  assert.deepEqual(continuity.fallbacks('chatgpt-luna'), []);
  const resolution = environment.resolve('chatgpt-luna');
  const signal = new AbortController().signal;
  const member = { workspaceId: '11111111-1111-4111-8111-111111111111', membershipId: 'member-1' };

  const result = await continuity.infer(resolution, planInput, 60000, signal, member);
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.decision, { kind: 'answer', text: 'Plan answer.' });
  assert.equal(result.planConnectionId, 'connection-team');
  assert.deepEqual(asked, [
    {
      provider: 'chatgpt',
      workspaceId: member.workspaceId,
      membershipId: 'member-1',
      model: 'gpt-6-luna',
      familyId: 'chatgpt-luna',
    },
  ]);
  assert.deepEqual(moved, ['usage-limit']);
  assert.deepEqual(sent, ['Bearer synthetic-own', 'Bearer synthetic-team']);
  assert.equal(answered, 1);

  const memberless = await continuity.infer(resolution, planInput, 60000, signal, { ...member, membershipId: null });
  assert.equal(memberless.kind, 'failure');
  assert.equal(memberless.reason, 'chatgpt-member-required');
  assert.equal(sent.length, 2);
});
