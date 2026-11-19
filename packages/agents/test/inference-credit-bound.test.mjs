import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferWithTools } from '../src/inference.ts';
import { completionReply, isCompletionRequest, nativeReply, nativeRoutes, use } from './native-fixture.mjs';

const route = nativeRoutes.anthropic;
const fetchCall = use('web.fetch', { url: 'https://example.com/a' });
// The fixture's Anthropic usage: 10 input and 3 cache-read tokens.
const reportedPrompt = 13;

/**
 * Runs a reply whose model calls web.fetch `fetches` times, then answers. Returns each reply round's request with what
 * the meter was told about it, and the reply rounds' bodies.
 */
async function reply(t, { fetches, output = () => '{"status":200}', tools = {} }) {
  const rounds = [];
  const bodies = [];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    requests++;
    bodies.push(body);
    return Response.json(
      requests <= fetches
        ? nativeReply('anthropic', { calls: [fetchCall] })
        : nativeReply('anthropic', { text: 'Done.' }),
    );
  });
  let calls = 0;
  const meter = async attempt => {
    rounds.push(attempt);
    return async () => {};
  };
  const answer = await inferWithTools(
    route,
    [{ role: 'user', text: 'Read the page.' }],
    async () => output(++calls),
    meter,
    false,
    null,
    tools,
  );
  return { answer, rounds, bodies };
}

test('a reply round that only appends to the previous round is bounded by its reported tokens', async t => {
  const { answer, rounds } = await reply(t, { fetches: 1 });
  assert.equal(answer.text, 'Done.');
  const [first, second, check] = rounds;
  assert.equal(first.previous, undefined, 'the first round has nothing to extend');
  assert.deepEqual(second.previous, {
    inputBytes: first.inputBytes,
    imageInputTokens: first.imageInputTokens,
    inputTokens: reportedPrompt,
  });
  assert.ok(second.inputBytes > first.inputBytes);
  assert.equal(check.previous, undefined, 'the completion check is its own request');
});

test('a finalizing round that drops the tools while appending dense results keeps the byte bound', async t => {
  // Repeated identical reads stall the loop, so the last round is sent without tools after a large, dense result.
  const dense = '0123456789abcdef'.repeat(5000);
  const { answer, rounds, bodies } = await reply(t, {
    fetches: 4,
    output: () => `{"status":200,"body":"${dense}"}`,
  });
  assert.equal(answer.text, 'Done.');
  assert.ok(bodies.at(-2).tools?.length && !bodies.at(-1).tools, 'the last round is sent without tools');
  const replyRounds = rounds.slice(0, -1);
  const final = replyRounds.at(-1);
  assert.ok(replyRounds.length >= 3);
  assert.equal(final.previous, undefined);
  assert.ok(
    replyRounds.slice(1, -1).every(round => round.previous),
    'rounds that keep the tools still extend the round before',
  );
});

test('a rebuilt runtime reminder keeps the byte bound', async t => {
  let reads = 0;
  const { rounds, bodies } = await reply(t, {
    fetches: 1,
    tools: {
      readWorkspaceInventory: async () => ({
        tables: [],
        agents: [],
        workflows: [],
        skills: [],
        note: `read ${++reads}`,
      }),
    },
  });
  const reminder = body => JSON.stringify(body.messages[0]);
  assert.notEqual(reminder(bodies[0]), reminder(bodies[1]), 'the second round has a new reminder');
  assert.equal(rounds[1].previous, undefined);
});

test('a changed tool list or prompt block keeps the byte bound', async t => {
  let withheld = false;
  const { rounds, bodies } = await reply(t, {
    fetches: 1,
    tools: {
      webWithheld: async () => {
        const now = withheld;
        withheld = true;
        return now;
      },
    },
  });
  assert.notEqual(bodies[0].tools.length, bodies[1].tools.length, 'the web tools are withheld in the second round');
  assert.equal(rounds[1].previous, undefined);
});
