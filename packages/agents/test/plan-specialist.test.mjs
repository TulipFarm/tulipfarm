import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferSpecialist } from '../src/inference.ts';
import { formats, nativeReply, nativeRoutes, offeredTools, toolResults, use } from './native-fixture.mjs';

function serve(t, replies) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected model request');
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

const meter = steps => async attempt => {
  steps.push(attempt.step);
  return async () => {};
};

test('specialists refuse tools that can change anything', async () => {
  await assert.rejects(
    inferSpecialist(nativeRoutes.anthropic, 'system', 'brief', ['rows.create'], async () => ({}), meter([]), 4),
    /specialist-tools-not-read-only/,
  );
  await assert.rejects(
    inferSpecialist(nativeRoutes.anthropic, 'system', 'brief', [], async () => ({}), meter([]), 4),
    /specialist-tools-not-read-only/,
  );
});

for (const format of formats)
  test(`${format} specialist runs parallel reads, meters every step and returns its text`, async t => {
    const route = nativeRoutes[format];
    const requests = serve(t, [
      nativeReply(format, {
        calls: [use('web.search', { query: 'waitlist tools' }), use('knowledge.search', { query: 'waitlist' })],
      }),
      nativeReply(format, { text: 'Two options found.' }),
    ]);
    const steps = [];
    const executed = [];
    const result = await inferSpecialist(
      route,
      'system',
      'Find waitlist tools.',
      ['web.search', 'knowledge.search'],
      async call => {
        executed.push(call.tool);
        return { ok: call.tool };
      },
      meter(steps),
      4,
    );
    assert.deepEqual(result, { text: 'Two options found.', calls: 2 });
    assert.deepEqual(executed.sort(), ['knowledge.search', 'web.search']);
    assert.deepEqual(steps, [0, 1]);
    assert.deepEqual(
      offeredTools(format, requests[0])
        .map(tool => tool.name)
        .sort(),
      ['knowledge_search', 'web_search'],
    );
    assert.equal(toolResults(format, requests[1]).length, 2);
  });

test('a specialist over its tool limit is told to finish, then runs nothing more', async t => {
  serve(t, [
    nativeReply('anthropic', { calls: [use('web.search', { query: 'a' }), use('web.search', { query: 'b' })] }),
    nativeReply('anthropic', { text: 'Finished without tools.' }),
  ]);
  let executed = 0;
  const result = await inferSpecialist(
    nativeRoutes.anthropic,
    'system',
    'brief',
    ['web.search'],
    async () => {
      executed++;
      return {};
    },
    meter([]),
    1,
  );
  assert.equal(executed, 0);
  assert.deepEqual(result, { text: 'Finished without tools.', calls: 0 });
});

test('a specialist calling a tool it was not given is corrected, and repeated misuse fails', async t => {
  serve(
    t,
    Array.from({ length: 3 }, () =>
      nativeReply('anthropic', { calls: [use('rows.create', { tableId: '00000000-0000-4000-8000-000000000000' })] }),
    ),
  );
  await assert.rejects(
    inferSpecialist(
      nativeRoutes.anthropic,
      'system',
      'brief',
      ['web.search'],
      async () => {
        throw new Error('must not run');
      },
      meter([]),
      4,
    ),
    /model-invalid-decision/,
  );
});

test('a refused meter stops the specialist before the model is called', async t => {
  const requests = serve(t, []);
  await assert.rejects(
    inferSpecialist(
      nativeRoutes.anthropic,
      'system',
      'brief',
      ['web.search'],
      async () => ({}),
      async () => {
        throw new Error('step-not-admitted');
      },
      4,
    ),
    /step-not-admitted/,
  );
  assert.equal(requests.length, 0);
});
