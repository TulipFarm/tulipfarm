import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { nonWorkToolNames } from '../src/non-work-tools.ts';
import { completionReply, isCompletionRequest, nativeReply, nativeRoutes, use } from './native-fixture.mjs';

const format = 'anthropic';

function run(t, replies, { execute = () => assert.fail('No tool expected'), title = false, ...context } = {}) {
  const events = [];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    events.push(isCompletionRequest(body) ? 'completion-request' : `request-${++requests}`);
    return Response.json(replies.shift());
  });
  const result = inferWithTools(
    nativeRoutes[format],
    [{ role: 'user', text: 'hey' }],
    execute,
    undefined,
    title,
    null,
    { ...context, progress: update => events.push(update) },
  );
  return { result, events };
}
const statuses = events => events.filter(event => typeof event === 'object');

test('a greeting without tools reports thinking, then done, with no tool or step', async t => {
  const { result, events } = run(t, [nativeReply(format, { text: 'Hi! How can I help?' })], { title: true });
  assert.deepEqual(await result, { text: 'Hi! How can I help?' });
  assert.deepEqual(statuses(events), [
    { step: 0, round: 1, status: 'thinking', toolRounds: 0 },
    { step: 0, round: 1, status: 'done', toolRounds: 0 },
  ]);
  assert.ok(!events.includes('completion-request'), 'a tool-free reply skips the completion check');
  assert.equal(events.at(-1).status, 'done', 'the reply ends done, with no title request after it');
  assert.ok(!events.includes('request-2'));
});

test('bud_state alone is not tool work: no tool status and no step', async t => {
  assert.ok(nonWorkToolNames.has('bud_state'));
  const { result, events } = run(
    t,
    [
      nativeReply(format, { calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Waving' } }] }),
      nativeReply(format, { calls: [{ name: 'bud_state', input: { name: 'Bud', state: 'Idle' } }] }),
      nativeReply(format, { text: 'Hello!' }),
    ],
    { avatar: { update: () => {} } },
  );
  assert.equal((await result).text, 'Hello!');
  const reported = statuses(events);
  assert.deepEqual(
    reported.map(({ status, round }) => `${status}:${round}`),
    ['thinking:1', 'thinking:2', 'thinking:3', 'done:3'],
  );
  assert.ok(reported.every(update => update.toolRounds === 0 && !('tool' in update)));
});

test('two work tools report their display names, and steps count only finished tool rounds', async t => {
  const executed = [];
  const { result, events } = run(
    t,
    [
      nativeReply(format, { calls: [use('tables.definitions', {}, 'Listing your tables')] }),
      nativeReply(format, { calls: [use('web.search', { query: 'tulip prices' }, 'Searching the web')] }),
      nativeReply(format, { text: 'Here is what I found.' }),
      completionReply(format),
    ],
    {
      execute: async call => {
        executed.push(call.tool);
        return call.tool === 'web.search' ? { results: [] } : { tables: [] };
      },
    },
  );
  assert.equal((await result).text, 'Here is what I found.');
  assert.deepEqual(executed, ['tables.definitions', 'web.search']);
  assert.deepEqual(statuses(events), [
    { step: 0, round: 1, status: 'thinking', toolRounds: 0 },
    { step: 0, round: 1, status: 'tool', tool: 'Tables', toolRounds: 0 },
    { step: 1, round: 2, status: 'thinking', toolRounds: 1 },
    { step: 1, round: 2, status: 'tool', tool: 'Web search', toolRounds: 1 },
    { step: 2, round: 3, status: 'thinking', toolRounds: 2 },
    { step: 2, round: 3, status: 'finishing', toolRounds: 2 },
    { step: 2, round: 3, status: 'done', toolRounds: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(statuses(events)), /tulip prices|Searching the web/, 'no tool arguments');
});

test('a format correction is not a step', async t => {
  const { result, events } = run(t, [
    nativeReply(format, { text: '' }),
    nativeReply(format, { text: 'Hello!' }),
    completionReply(format),
  ]);
  assert.equal((await result).text, 'Hello!');
  assert.deepEqual(
    statuses(events).map(({ status, toolRounds }) => `${status}:${toolRounds}`),
    ['thinking:0', 'thinking:0', 'finishing:0', 'done:0'],
  );
});

test('a failing progress consumer does not affect the reply', async t => {
  t.mock.method(globalThis, 'fetch', async options => {
    void options;
    return Response.json(replies.shift());
  });
  const replies = [nativeReply(format, { text: 'Hi.' }), completionReply(format)];
  const result = await inferWithTools(
    nativeRoutes[format],
    [{ role: 'user', text: 'hey' }],
    () => {},
    undefined,
    false,
    null,
    {
      progress: () => {
        throw new Error('consumer failed');
      },
    },
  );
  assert.equal(result.text, 'Hi.');
});
