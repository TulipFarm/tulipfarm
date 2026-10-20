import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { nativeReply, selectReply, use } from './native-fixture.mjs';
import { containsToolEnvelope } from '../src/tool-text.ts';

const route = { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' };
const tableId = '11111111-1111-4111-8111-111111111111';
const call = { tool: 'rows.create', tableId, expectedAppliedRevision: 'a'.repeat(40), values: {} };

test('text tool detection covers native, wrapped, truncated and multi-call shapes without rejecting ordinary JSON', () => {
  for (const text of [
    JSON.stringify(call),
    JSON.stringify({ decision: JSON.stringify({ kind: 'tool', call }) }),
    JSON.stringify({ kind: 'parallel', calls: [call] }),
    JSON.stringify({ type: 'tool_use', name: 'rows_create', input: {} }),
    '{"kind":"tool","call":{',
    `I will do this:\n\`\`\`json\n${JSON.stringify({ kind: 'tool', call })}\n\`\`\``,
  ])
    assert.equal(containsToolEnvelope(text), true, text);
  for (const text of ['Created five tickets.', '{"tickets":5}', '{"kind":"tool","name":"hammer"}'])
    assert.equal(containsToolEnvelope(text), false, text);
});

test('tool-shaped text is corrected without executing it or repeating completed writes', async t => {
  const replies = [
    nativeReply('anthropic', {
      calls: [use('rows.create', { tableId, expectedAppliedRevision: 'a'.repeat(40), values: {} })],
    }),
    nativeReply('anthropic', { text: JSON.stringify({ kind: 'tool', call }) }),
    nativeReply('anthropic', { text: 'Created one ticket. Four remain.' }),
    selectReply('anthropic', { status: 'blocked', reason: 'The reply states the completed work and remaining work.' }),
  ];
  const executed = [],
    requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json(replies[requests.length - 1]);
  });
  const result = await inferWithTools(route, [{ role: 'user', text: 'Add five fake tickets.' }], async call => {
    executed.push(call);
    return { id: tableId };
  });
  assert.equal(result.text, 'Created one ticket. Four remain.');
  assert.equal(executed.length, 1);
  assert.match(JSON.stringify(requests[2]), /Do not repeat tools that already completed/);
});

test('repeated text tool envelopes fail closed while ordinary JSON answers still work', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(
      nativeReply('anthropic', { text: `\`\`\`json\n${JSON.stringify({ kind: 'tool', call })}\n\`\`\`` }),
    );
  });
  await assert.rejects(
    inferWithTools(route, [{ role: 'user', text: 'Create tickets' }], () => assert.fail('Text is never executed')),
    /model-invalid-decision/,
  );
  assert.equal(requests, 3);
  t.mock.restoreAll();
  let answered = false;
  t.mock.method(globalThis, 'fetch', async () => {
    const reply = answered
      ? selectReply('anthropic', { status: 'completed', reason: 'A direct JSON answer.' })
      : nativeReply('anthropic', { text: '{"tickets":5}' });
    answered = true;
    return Response.json(reply);
  });
  assert.deepEqual(await inferWithTools(route, [{ role: 'user', text: 'Answer as JSON.' }], () => assert.fail()), {
    text: '{"tickets":5}',
  });
});

test('discovery does not consume the work budget and the last call gets a no-tool answer round', async t => {
  const requests = [],
    executed = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const number = requests.length;
    if (number === 4)
      return Response.json(
        selectReply('anthropic', { status: 'blocked', reason: 'The completed reads exhausted the work budget.' }),
      );
    return Response.json(
      nativeReply(
        'anthropic',
        number === 1
          ? { calls: [use('tools_search', { query: 'web fetch' })] }
          : number === 2
            ? { calls: [use('web.fetch', { url: 'https://example.com/last' })] }
            : { text: 'Read the last page. The remaining work did not run.' },
      ),
    );
  });
  const result = await inferWithTools(
    route,
    [{ role: 'user', text: 'Read the pages.' }],
    async call => {
      executed.push(call);
      return { text: 'Page' };
    },
    undefined,
    false,
    null,
    { priorCalls: 999 },
  );
  assert.equal(result.text, 'Read the last page. The remaining work did not run.');
  assert.equal(executed.length, 1);
  assert.equal(requests.length, 4);
  assert.equal(requests[2].tools, undefined);
  assert.deepEqual(
    requests[3].tools.map(tool => tool.name),
    ['select_action'],
  );
});

test('the reserved answer round cannot execute an extra write', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).tools, undefined);
    return Response.json(
      nativeReply('anthropic', {
        calls: [use('rows.create', { tableId, expectedAppliedRevision: 'a'.repeat(40), values: {} })],
      }),
    );
  });
  const result = await inferWithTools(
    route,
    [{ role: 'user', text: 'Continue.' }],
    () => assert.fail('The mutation budget is exhausted'),
    undefined,
    false,
    null,
    { priorCalls: 1000 },
  );
  assert.match(result.text, /tool limit was reached/);
});

test('a text tool request after the budget ends the reply gracefully with one warning', async t => {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (String(line).includes('"call_failed"')) lines.push(JSON.parse(line));
    return write(line, ...rest);
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(nativeReply('anthropic', { text: JSON.stringify({ kind: 'tool', call }) })),
  );
  const result = await inferWithTools(
    route,
    [{ role: 'user', text: 'Import the remaining rows.' }],
    () => assert.fail('The budget is exhausted'),
    undefined,
    false,
    null,
    { priorCalls: 1000 },
  );
  t.mock.restoreAll();
  assert.match(result.text, /tool limit was reached/);
  assert.deepEqual(
    lines.filter(line => line.category === 'activity').map(line => [line.level, line.operation, line['error.type']]),
    [['warn', 'chat.tool-budget', 'tool-limit']],
  );
});
