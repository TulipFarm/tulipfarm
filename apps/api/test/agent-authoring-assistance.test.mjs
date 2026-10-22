import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAgentAuthoringAssistance } from '../src/agent-authoring-assistance.ts';
import { authConfig } from '../src/auth.ts';
import { agentAuthoringLimits } from '@tulipfarm/agents/authoring-assistance-contracts';
import {
  authoringFixture,
  improveInput,
  previewInput,
  workspaceId,
  userId,
} from '../../../packages/agents/test/authoring-assistance-fixture.mjs';

function fixture(t) {
  const domain = authoringFixture(),
    app = Fastify();
  let signedIn = true;
  registerAgentAuthoringAssistance(app, {
    runtime: domain.runtime,
    environment: domain.environment,
    defaultFamilyId: 'gpt-luna',
    fetcher: domain.fetcher,
    modelFamilyEligibility: domain.eligible,
    auth: {
      api: { getSession: async () => (signedIn ? { user: { id: userId }, session: { id: 'fixture-session' } } : null) },
    },
  });
  t.after(() => app.close());
  const headers = { origin: authConfig().webOrigin };
  const post = (operation, payload, requestHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents/authoring/${operation}`,
      headers: requestHeaders,
      payload,
    });
  return {
    ...domain,
    app,
    post,
    signOut: () => {
      signedIn = false;
    },
  };
}

test('authoring HTTP routes require login, trusted origin, workspace membership, and explicit POST', async t => {
  const f = fixture(t);
  assert.equal((await f.app.inject(`/workspaces/${workspaceId}/agents/authoring/test-chat`)).statusCode, 404);
  assert.equal(
    (await f.post('improve-instructions', improveInput(), { origin: 'https://untrusted.example' })).statusCode,
    403,
  );
  f.state.allowed = false;
  assert.equal((await f.post('improve-instructions', improveInput())).statusCode, 404);
  f.state.allowed = true;
  f.signOut();
  assert.equal((await f.post('improve-instructions', improveInput())).statusCode, 401);
  assert.equal(f.state.requests.length, 0);
});

test('HTTP emits typed suggestions, preserves source identity, and rejects paid retries', async t => {
  const f = fixture(t),
    input = { ...improveInput(), agentName: 'People helper' };
  const response = await f.post('improve-instructions', input);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json().source, input.source);
  assert.equal(response.json().model.familyId, 'gpt-luna');
  assert.ok(response.json().usage.credits > 0);
  const retry = await f.post('improve-instructions', input);
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(retry.json().error, 'request-already-dispatched');
  assert.equal(f.state.requests.length, 1);
  const preview = await f.post('test-chat', previewInput());
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().model.familyId, 'gpt-sol');
  assert.match(preview.json().snapshotId, /^[a-f0-9]{64}$/);
});

test('unexpected HTTP failures log only safe structured context without draft or error bodies', async t => {
  const f = fixture(t),
    logs = [];
  f.app.addHook('onRequest', async request => {
    t.mock.method(request.log, 'error', (...arguments_) => {
      logs.push(arguments_);
    });
  });
  const error = new Error('PRIVATE DRAFT INSTRUCTIONS');
  Object.assign(error, {
    name: 'PRIVATE ERROR NAME',
    stack: 'PRIVATE ERROR STACK',
    cause: new Error('PRIVATE ERROR CAUSE'),
  });
  t.mock.method(f.runtime, 'transaction', async () => {
    throw error;
  });
  const response = await f.post('improve-instructions', {
    ...improveInput(),
    agentName: 'PRIVATE AGENT NAME',
    instructions: 'PRIVATE DRAFT INSTRUCTIONS',
  });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error, 'authoring-unavailable');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], [
    {
      operation: 'improveAgentInstructionsV1',
      workspaceId,
      'error.type': 'Error',
    },
    'Agent authoring request failed',
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
  assert.doesNotMatch(response.body, /PRIVATE/);
  assert.equal(f.state.requests.length, 0);
});

test('HTTP validates UTF-16 input, malformed bodies, byte bounds, and credit errors before calling a provider', async t => {
  const f = fixture(t);
  for (const instructions of ['', ' \n', null, 'a'.repeat(32001), '🙂'.repeat(16001)]) {
    const response = await f.post('improve-instructions', { ...improveInput(), instructions });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid-request');
  }
  const oversized = await f.post('improve-instructions', {
    ...improveInput(),
    instructions: 'a'.repeat(agentAuthoringLimits.requestBytes),
  });
  assert.equal(oversized.statusCode, 413);
  f.state.available = 0n;
  const noCredits = await f.post('improve-instructions', improveInput());
  assert.equal(noCredits.statusCode, 402, noCredits.body);
  assert.equal(noCredits.json().error, 'credits-exhausted');
  assert.equal(f.state.requests.length, 0);
});
