import assert from 'node:assert/strict';
import { test } from 'node:test';
import { respondToConversation } from '../src/conversation-responder.ts';
import {
  completionReply,
  isCompletionRequest,
  anthropicTools,
  anthropicText,
  isTitleRequest,
} from './native-chat-fixture.mjs';
import { withChatMeasurements } from '@tulipfarm/observability';

const tableId = '11111111-1111-4111-8111-111111111111';
const integrationId = '22222222-2222-4222-8222-222222222222';
const sourceId = '33333333-3333-4333-8333-333333333333';

test('planning evidence uses the runtime receipt ID while preserving tool data and source checks', async t => {
  const receiptId = '44444444-4444-4444-8444-444444444444';
  let step = 0;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return Response.json(
      isCompletionRequest(request)
        ? completionReply('anthropic')
        : step++ === 0
          ? anthropicTools([{ tool: 'agents.list' }])
          : anthropicText('The existing agents were checked.'),
    );
  });
  const result = await respondToConversation(
    { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
    [{ role: 'user', text: 'Check for an existing agent.' }],
    async () => ({
      receiptId,
      result: { agents: [], toolReceipt: { callId: 'untrusted-provider-value' } },
      sources: [{ kind: 'public-web', url: 'https://example.com/' }],
    }),
  );
  const serialized = JSON.stringify(requests[1]);
  assert.ok(serialized.includes(receiptId));
  assert.ok(!serialized.includes('untrusted-provider-value'));
  assert.deepEqual(result.sources, [{ kind: 'public-web', url: 'https://example.com/' }]);
});

test('the responder retains trusted tool envelopes and rejects missing provenance', async t => {
  const calls = [
    { tool: 'rows.page', tableId, revision: 'a'.repeat(40) },
    { tool: 'github.issue.read', integrationId, sourceId, issueNumber: 1 },
    { tool: 'web.fetch', url: 'https://example.com/' },
    { tool: 'skills.list' },
    { tool: 'agents.list' },
    { tool: 'google.read', operation: { kind: 'docs.documents.get', documentId: 'private-doc' } },
  ];
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) =>
    Response.json(
      isCompletionRequest(JSON.parse(init.body))
        ? completionReply('anthropic')
        : step < calls.length
          ? anthropicTools([calls[step++]])
          : anthropicText('The answer uses several sources.'),
    ),
  );
  const executed = [];
  const answer = await respondToConversation(
    { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
    [{ role: 'user', text: 'Read the sources' }],
    async call => {
      executed.push(call.tool);
      if (call.tool === 'rows.page')
        return {
          result: { text: 'Provider result', sources: [] },
          sources: [{ kind: 'table-rows', tableId, revision: call.revision }],
        };
      return { text: 'Missing trusted envelope', sources: [] };
    },
  );
  assert.deepEqual(executed, [
    'rows.page',
    'github.issue.read',
    'web.fetch',
    'skills.list',
    'agents.list',
    'google.read',
  ]);
  assert.deepEqual(answer, {
    text: 'The answer uses several sources.',
    sources: [{ kind: 'table-rows', tableId, revision: 'a'.repeat(40) }, { kind: 'unavailable' }],
  });
});

test('a first reply is answered without waiting for a title request', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(!isTitleRequest(body), 'no title request');
    return Response.json(isCompletionRequest(body) ? completionReply('anthropic') : anthropicText('Here is the plan.'));
  });
  const answer = await respondToConversation(
    { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
    [{ role: 'user', text: 'Plan customer follow-ups' }],
    () => assert.fail('No tool expected'),
    undefined,
    undefined,
    true,
  );
  assert.deepEqual(answer, { text: 'Here is the plan.', sources: [] });
});

test('the responder discloses actual news widening even when the model omits it', async t => {
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) =>
    Response.json(
      isCompletionRequest(JSON.parse(init.body))
        ? completionReply('anthropic')
        : step++ === 0
          ? anthropicTools([
              { call: { tool: 'web.search', query: 'AI news', window: 'day', limit: 5 }, text: 'Searching the web' },
            ])
          : anthropicText('A reported story.'),
    ),
  );
  const answer = await respondToConversation(
    { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
    [{ role: 'user', text: 'Latest news' }],
    async () => ({
      result: {
        kind: 'public-web',
        status: 'empty',
        sources: [],
        pages: [],
        window: 'week',
        widened: true,
        retrievedAt: '2026-10-03T04:00:00Z',
        untrusted: true,
      },
      sources: [],
    }),
  );
  assert.equal(answer.text, 'A reported story.\n\nSearch coverage was widened to the past seven days.');
});

test('source authorization is measured before credit admission and dispatch, including a denied gate', async t => {
  const records = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
      records.push(JSON.parse(chunk));
      return true;
    }
    return write(chunk, ...args);
  });
  for (const denied of [false, true]) {
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    let entered;
    const authorizing = new Promise(resolve => {
      entered = resolve;
    });
    let admitted = 0;
    let fetched = 0;
    const failure = new Error('PRIVATE SOURCE DENIAL');
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      fetched++;
      return Response.json(
        isCompletionRequest(JSON.parse(init.body)) ? completionReply('anthropic') : anthropicText('Ready.'),
      );
    });
    const start = records.length;
    const pending = withChatMeasurements(() =>
      respondToConversation(
        { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
        [{ role: 'user', text: 'PRIVATE REQUEST' }],
        () => assert.fail('No tool expected'),
        async () => {
          admitted++;
          return async () => {};
        },
        async () => {
          entered();
          await gate;
          if (denied) throw failure;
        },
      ),
    );
    await authorizing;
    assert.equal(admitted, 0);
    assert.equal(fetched, 0);
    assert.equal(records.slice(start).filter(record => record.operation === 'chat.detail.authorize').length, 0);
    release();
    if (denied) {
      await assert.rejects(pending, error => error === failure);
      assert.equal(admitted, 0);
      assert.equal(fetched, 0);
    } else {
      assert.deepEqual(await pending, { text: 'Ready.', sources: [] });
      // A tool-free answer skips the completion check, so one request is admitted and sent.
      assert.equal(admitted, 1);
      assert.equal(fetched, 1);
    }
    const authorization = records.slice(start).find(record => record.operation === 'chat.detail.authorize');
    assert.equal(authorization.outcome, denied ? 'error' : 'success');
    assert.equal(authorization['chat.purpose'], 'reply');
    assert.equal(authorization['chat.request.sequence'], 1);
  }
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|synthetic|https:/);
});

/** Reports the request's own size as its prompt tokens, so the reply's context estimate grows with each round. */
const reported = (body, init) => ({ ...body, usage: { ...body.usage, input_tokens: Math.ceil(init.body.length / 4) } });

test('the tool-result summariser runs only after the same source check as a model request', async t => {
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) =>
    Response.json(
      isCompletionRequest(JSON.parse(init.body))
        ? completionReply('anthropic')
        : step < 6
          ? reported(anthropicTools([{ tool: 'web.fetch', url: `https://example.com/${++step}` }]), init)
          : anthropicText('Read every page.'),
    ),
  );
  const events = [];
  const answer = await respondToConversation(
    { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
    [{ role: 'user', text: 'Read the pages.' }],
    async call => ({
      result: { text: `${call.url} ${'lorem ipsum '.repeat(3000)}` },
      sources: [{ kind: 'public-web', url: call.url }],
    }),
    undefined,
    async sources => {
      events.push(['authorize', sources.length]);
    },
    false,
    null,
    {
      sources: () => [],
      context: { window: 20_000, triggerPercent: 70, targetPercent: 30 },
      compactToolResults: async ({ text }) => {
        events.push(['summarise']);
        return JSON.stringify({
          notes: JSON.parse(text).results.map(({ callId }) => ({ callId, note: 'Read one page.' })),
        });
      },
    },
  );
  assert.equal(answer.text, 'Read every page.');
  const summarised = events.findIndex(([kind]) => kind === 'summarise');
  assert.ok(summarised > 0, 'the summariser ran');
  assert.equal(events[summarised - 1][0], 'authorize');
  assert.ok(events[summarised - 1][1] > 0, 'the check covers the sources the summarised results came from');
});

test('a failed source check before summarising leaves stubs and fails at the next model request', async t => {
  let step = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) =>
    Response.json(
      isCompletionRequest(JSON.parse(init.body))
        ? completionReply('anthropic')
        : reported(anthropicTools([{ tool: 'web.fetch', url: `https://example.com/${++step}` }]), init),
    ),
  );
  let summarised = 0;
  let revoked = false;
  await assert.rejects(
    respondToConversation(
      { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
      [{ role: 'user', text: 'Read the pages.' }],
      async call => {
        // The third round is the first to compact, so its summariser is the first request after revocation.
        if (step >= 2) revoked = true;
        return { result: { text: `${call.url} ${'lorem ipsum '.repeat(3000)}` }, sources: [] };
      },
      undefined,
      async () => {
        if (revoked) throw new Error('source-revoked');
      },
      false,
      null,
      {
        sources: () => [],
        context: { window: 20_000, triggerPercent: 70, targetPercent: 30 },
        compactToolResults: async () => {
          summarised++;
          return '{"notes":[]}';
        },
      },
    ),
    /source-revoked/,
  );
  assert.equal(summarised, 0);
});
