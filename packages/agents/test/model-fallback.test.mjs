import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../dist/inference.js';
import { completionReply, isCompletionRequest, nativeReply, nativeRoutes } from './native-fixture.mjs';

const messages = [{ role: 'user', text: 'PRIVATE PROMPT hey' }];
const primary = nativeRoutes.azure;
const fallbackRoute = nativeRoutes.anthropic;
const fallback = { route: fallbackRoute, label: 'claude-fallback' };
const noTools = () => assert.fail('No tool expected');
const encoder = new TextEncoder();

const azureError = (status, error) => new Response(JSON.stringify({ error }), { status });
const deploymentMissing = () =>
  azureError(404, {
    code: 'DeploymentNotFound',
    message: 'The API deployment for this resource does not exist. PRIVATE PROMPT hey',
  });

function logs(t) {
  const records = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      records.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  return records;
}

/** Answers each provider with its handler and records which providers were called, plus what the meter priced and settled. */
function harness(t, handlers) {
  const calls = [];
  const metered = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const provider = String(url).includes('anthropic') ? 'anthropic' : 'azure';
    calls.push(provider);
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply(provider));
    return handlers[provider]();
  });
  const meter = async attempt => {
    const record = { provider: attempt.provider, model: attempt.model, step: attempt.step };
    metered.push(record);
    return async (usage, outcome) => {
      record.usage = usage.kind;
      record.rejected = outcome?.rejected ?? false;
    };
  };
  return { calls, metered, meter };
}

const fallbackLogs = records => records.filter(record => record.operation === 'chat.model-fallback');

test('an eligible failure before any output answers once on the fallback, which is reported and billed', async t => {
  const records = logs(t);
  const { calls, metered, meter } = harness(t, {
    azure: deploymentMissing,
    anthropic: () => Response.json(nativeReply('anthropic', { text: 'Hello from the fallback' })),
  });
  const answer = await inferWithTools(primary, messages, noTools, meter, false, null, { fallback });
  assert.deepEqual(answer, { text: 'Hello from the fallback', fallback: 'claude-fallback' });
  assert.equal(calls[0], 'azure');
  assert.equal(calls.filter(call => call === 'azure').length, 1, 'the failed model is not called again');
  assert.equal(metered[0].provider, 'azure');
  assert.equal(metered[0].rejected, true, 'the refused request releases its hold');
  const billed = metered.filter(record => record.provider === 'anthropic');
  assert.ok(billed.length >= 1, 'the fallback model is priced');
  assert.ok(billed.every(record => record.model === fallbackRoute.model && record.usage === 'known'));
  assert.notEqual(billed[0].step, metered[0].step, 'the retry holds credits under its own step');
  const [decision] = fallbackLogs(records);
  assert.equal(decision.model_fallback, 'used');
  assert.equal(decision['error.type'], 'not_found');
  assert.equal(decision['fallback.model'], fallbackRoute.model);
  const failed = records.find(record => record.event === 'call_failed' && record['gen_ai.provider.name'] === 'azure');
  assert.equal(failed['error.code'], 'not_found');
  assert.equal(failed['http.response.status_code'], 404);
  assert.equal(failed['provider.error_code'], 'DeploymentNotFound');
  assert.equal(failed.output_started, false);
  assert.ok(!JSON.stringify(records).includes('PRIVATE PROMPT'), 'no prompt content is logged');
});

test('without a configured fallback the classified failure is rethrown and counted as not_configured', async t => {
  const records = logs(t);
  const { calls, metered, meter } = harness(t, { azure: deploymentMissing, anthropic: () => assert.fail() });
  await assert.rejects(
    inferWithTools(primary, messages, noTools, meter),
    error => error.message === 'model-configuration' && error.code === 'not_found',
  );
  assert.deepEqual(calls, ['azure']);
  assert.equal(metered.length, 1);
  assert.equal(fallbackLogs(records)[0].model_fallback, 'not_configured');
});

for (const [name, response, reason] of [
  [
    'a content filter',
    () => azureError(400, { code: 'content_filter', message: 'The response was filtered.' }),
    'model-refusal',
  ],
  [
    'a context length error',
    () => azureError(400, { code: 'context_length_exceeded', message: 'This model maximum context length is 8192.' }),
    'model-context-overflow',
  ],
  [
    'an invalid request',
    () => azureError(400, { code: 'invalid_value', message: 'Unsupported value for temperature.' }),
    'model-invalid-request',
  ],
])
  test(`${name} is not retried on the fallback`, async t => {
    const records = logs(t);
    const { calls, meter } = harness(t, { azure: response, anthropic: () => assert.fail() });
    await assert.rejects(
      inferWithTools(primary, messages, noTools, meter, false, null, { fallback }),
      error => error.message === reason,
    );
    assert.deepEqual(calls, ['azure']);
    assert.equal(fallbackLogs(records)[0].model_fallback, 'not_eligible');
  });

test('a failure after part of the reply streamed is not retried on the fallback', async t => {
  const records = logs(t);
  const route = nativeRoutes.responses;
  const streamed = [];
  let sent = false;
  const { calls, meter } = harness(t, {
    azure: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return controller.error(new Error('connection reset'));
            sent = true;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hel' })}\n\n`),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    anthropic: () => assert.fail('no fallback after output'),
  });
  await assert.rejects(
    inferWithTools(route, messages, noTools, meter, false, null, {
      fallback,
      answerText: update => streamed.push(update.text),
    }),
    error => error.message.startsWith('model-') && error.modelDiagnostics?.outputStarted === true,
  );
  assert.ok(streamed.includes('Hel'));
  assert.ok(!calls.includes('anthropic'), 'the fallback is never called after output');
  assert.ok(fallbackLogs(records).every(record => record.model_fallback === 'not_eligible'));
  const failed = records.find(record => record.event === 'call_failed');
  assert.equal(failed.output_started, true);
});

test('a fallback that also fails surfaces the chat model failure and is counted as failed', async t => {
  const records = logs(t);
  const { calls, meter } = harness(t, {
    azure: () => azureError(429, { code: 'insufficient_quota', message: 'You exceeded your current quota.' }),
    anthropic: () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal error' } }), {
        status: 500,
      }),
  });
  await assert.rejects(
    inferWithTools(primary, messages, noTools, meter, false, null, { fallback }),
    error => error.message === 'model-quota' && error.code === 'quota_exceeded',
  );
  assert.deepEqual(calls, ['azure', 'anthropic']);
  assert.equal(fallbackLogs(records)[0].model_fallback, 'failed');
  const failures = records.filter(
    record => record.event === 'call_failed' && record.operation !== 'chat.model-fallback',
  );
  assert.deepEqual(failures.map(record => record['error.code']).sort(), ['quota_exceeded', 'server_error']);
});
