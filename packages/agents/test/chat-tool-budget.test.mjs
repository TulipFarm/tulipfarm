import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { createChatToolGuard } from '../src/chat-tool-guard.ts';
import { chatToolCallLimit } from '../../conversations/src/contracts.ts';
import {
  formats,
  nativeRoutes,
  nativeReply,
  completionReply,
  isCompletionRequest,
  toolResults,
  use,
  useCall,
} from './native-fixture.mjs';

const write = {
  tool: 'rows.create',
  tableId: '11111111-1111-4111-8111-111111111111',
  expectedAppliedRevision: 'a'.repeat(40),
  values: {},
};

test('a productive turn executes exactly 1000 calls, not eight, then gets a tool-free summary', async t => {
  assert.equal(chatToolCallLimit, 1000);
  let calls = 0,
    rounds = 0,
    summaries = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    rounds++;
    if (calls === 1000) {
      summaries++;
      assert.equal(body.tools, undefined);
      return Response.json(nativeReply('anthropic', { text: 'Read 1000 pages.' }));
    }
    assert.ok(calls < 1000);
    return Response.json(
      nativeReply('anthropic', {
        calls: Array.from({ length: 25 }, (_, i) => use('web.fetch', { url: `https://example.com/${calls + i}` })),
      }),
    );
  });
  const result = await inferWithTools(nativeRoutes.anthropic, [], async () => {
    calls++;
    return { text: 'Page' };
  });
  assert.equal(result.text, 'Read 1000 pages.');
  assert.equal(calls, 1000);
  assert.equal(rounds, 41);
  assert.equal(summaries, 1);
});

for (const format of formats)
  test(`${format} shrinks an oversized batch and executes the 1000th call only`, async t => {
    let calls = 0,
      rounds = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(format));
      rounds++;
      if (rounds === 1)
        return Response.json(
          nativeReply(format, {
            calls: [
              use('web.fetch', { url: 'https://example.com/a' }),
              use('web.fetch', { url: 'https://example.com/b' }),
            ],
          }),
        );
      if (rounds === 2) {
        assert.equal(calls, 0);
        assert.ok(toolResults(format, body).every(result => result.output.includes('Only 1 tool calls remain')));
        return Response.json(nativeReply(format, { calls: [use('web.fetch', { url: 'https://example.com/a' })] }));
      }
      assert.equal(rounds, 3);
      assert.equal(body.tools, undefined);
      return Response.json(nativeReply(format, { text: 'One page read; the other remains.' }));
    });
    await inferWithTools(
      nativeRoutes[format],
      [],
      async () => {
        calls++;
        return {};
      },
      undefined,
      false,
      null,
      { priorCalls: 999 },
    );
    assert.equal(calls, 1);
  });

for (const format of formats)
  test(`${format} blocks duplicate writes despite changed activity, call ID, and object key order`, async t => {
    let rounds = 0,
      effects = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply(format));
      rounds++;
      if (rounds <= 2)
        return Response.json(
          nativeReply(format, {
            calls: [
              useCall(
                rounds === 1
                  ? write
                  : {
                      values: write.values,
                      expectedAppliedRevision: write.expectedAppliedRevision,
                      tableId: write.tableId,
                      tool: write.tool,
                    },
                `Activity ${rounds}`,
                { id: `call_${rounds}` },
              ),
            ],
          }),
        );
      assert.equal(rounds, 3);
      assert.match(toolResults(format, body)[0].output, /Not run.*already has a receipt/);
      return Response.json(nativeReply(format, { text: 'Created one record, not two.' }));
    });
    await inferWithTools(nativeRoutes[format], [], async () => {
      effects++;
      return { id: 'saved' };
    });
    assert.equal(effects, 1);
  });

test('resumed turns block previously receipted writes without replaying their result as fresh success', async t => {
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    if (++rounds === 1) return Response.json(nativeReply('anthropic', { calls: [useCall(write)] }));
    assert.match(toolResults('anthropic', body)[0].output, /receipt is not proof of success/);
    return Response.json(nativeReply('anthropic', { text: 'The earlier action was not repeated.' }));
  });
  await inferWithTools(
    nativeRoutes.anthropic,
    [],
    () => assert.fail('Repeated a persisted write'),
    undefined,
    false,
    null,
    { priorCalls: 1, priorToolCalls: [write] },
  );
});

for (const mode of ['discovery', 'reads', 'writes'])
  test(`${mode} loops stop after three rounds without progress`, async t => {
    let rounds = 0,
      calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic', 'blocked'));
      rounds++;
      assert.ok(rounds <= 5, 'loop is bounded');
      if (!body.tools)
        return Response.json(nativeReply('anthropic', { text: 'Stopped because repeated requests made no progress.' }));
      return Response.json(
        nativeReply('anthropic', {
          calls: [
            mode === 'discovery'
              ? use('tools.search', { query: 'zzzzzzzzzz' })
              : mode === 'reads'
                ? use('web.fetch', { url: 'https://example.com/same' })
                : useCall(write),
          ],
        }),
      );
    });
    const result = await inferWithTools(nativeRoutes.anthropic, [], async () => {
      calls++;
      return {};
    });
    assert.match(result.text, /no progress/);
    assert.equal(rounds, mode === 'discovery' ? 4 : 5);
    assert.equal(calls, mode === 'discovery' ? 0 : mode === 'writes' ? 1 : 4);
  });

test('fresh read results and different writes make progress; completed writes remain blocked after reads', () => {
  const guard = createChatToolGuard();
  const read = { tool: 'agents.context' };
  for (let i = 0; i < 20; i++) {
    guard.round();
    assert.equal(guard.duplicate(read), false);
    guard.record(read, JSON.stringify({ revision: i }));
    assert.equal(guard.stalled, false);
  }
  guard.record(write, '{"status":"outcome-unknown"}');
  guard.record(read, '{}');
  assert.equal(guard.duplicate(write), true);
  assert.equal(guard.duplicate({ ...write, values: { title: 'A different record' } }), false);
  guard.record({ ...write, values: { title: 'A different record' } }, '{}');
  guard.round();
  guard.record(read, '{}');
  assert.equal(guard.stalled, false, 'a write allows a fresh read of the same result');
});

for (const priorCalls of [-1, 0.5, 1001, Infinity])
  test(`invalid prior count ${priorCalls} cannot open a new budget`, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Invalid count dispatched a provider request'));
    await assert.rejects(
      inferWithTools(nativeRoutes.anthropic, [], () => assert.fail(), undefined, false, null, { priorCalls }),
    );
  });

test('credit or cancellation admission still stops a long productive turn before another tool', async t => {
  let calls = 0,
    requests = 0,
    admissions = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(
      nativeReply('anthropic', { calls: [use('web.fetch', { url: `https://example.com/${requests}` })] }),
    );
  });
  await assert.rejects(
    inferWithTools(
      nativeRoutes.anthropic,
      [],
      async () => {
        calls++;
        return {};
      },
      async () => {
        if (++admissions === 13) throw new Error('credits-exhausted');
        return async () => {};
      },
    ),
    /credits-exhausted/,
  );
  assert.equal(calls, 12);
  assert.equal(requests, 12);
});
