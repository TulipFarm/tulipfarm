import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createConversationActivities } from '../dist/conversation-activities.js';
import { useModelCatalog } from './model-catalog-fixture.mjs';
import { completionReply, isCompletionRequest } from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const encoder = new TextEncoder();
/** DeepSeek-V4-Flash on Azure AI Foundry: usage rides on the last content chunk, with DeepSeek's cache fields. */
const deepseekUsage = {
  prompt_tokens: 281,
  completion_tokens: 75,
  total_tokens: 356,
  prompt_tokens_details: { cached_tokens: 256 },
  prompt_cache_hit_tokens: 256,
  prompt_cache_miss_tokens: 25,
  completion_tokens_details: { reasoning_tokens: 60 },
};
// $0.19 input, $0.51 output and $0.028 cache read per million tokens, in picodollars.
const deepseekPicoUsd = 25n * 190_000n + 75n * 510_000n + 256n * 28_000n;
const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'DeepSeek-V4-Flash' };
const chunk = (content, finishReason = null, usage = null) => ({
  ...base,
  choices: [{ index: 0, delta: { content, reasoning_content: null }, logprobs: null, finish_reason: finishReason }],
  usage,
});
const stream = (text, usage) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of [chunk(text), chunk('', 'stop', usage)])
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const isTitle = body => String(body.messages?.[0]?.content ?? '').startsWith('Write a title for a new chat.');

test('streamed DeepSeek replies and titles settle credits on reported usage', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  const previous = {
    AZURE_FOUNDRY_API_KEY: process.env.AZURE_FOUNDRY_API_KEY,
    AZURE_FOUNDRY_ENDPOINT: process.env.AZURE_FOUNDRY_ENDPOINT,
  };
  process.env.AZURE_FOUNDRY_API_KEY = 'synthetic-only';
  process.env.AZURE_FOUNDRY_ENDPOINT = 'https://synthetic.services.ai.azure.com/';
  t.after(useModelCatalog(['deepseek-flash']));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  });
  let reportUsage = true;
  const calls = { chat: 0, title: 0, completion: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'synthetic.services.ai.azure.com');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'DeepSeek-V4-Flash');
    if (isCompletionRequest(body)) {
      calls.completion++;
      return Response.json(completionReply('azure'));
    }
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    if (isTitle(body)) {
      calls.title++;
      return stream('Greeting', deepseekUsage);
    }
    calls.chat++;
    return stream('Hello there.', reportUsage ? deepseekUsage : null);
  });
  const logs = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (line, ...args) => {
    if (typeof line === 'string' && line.startsWith('{"level":')) logs.push(JSON.parse(line));
    return write(line, ...args);
  });
  const w = f.workspace;
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const send = async () => {
    const turn = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'deepseek-flash',
      parts: [{ kind: 'text', text: 'Hello' }],
    });
    return { workspaceId: w.id, conversationId: chatId, turnId: turn.turnId, generation: 0 };
  };
  const rows = async turnId =>
    (
      await f.db.platform.query(
        `SELECT id, reserved::text, charged::text, provider_pico_usd::text AS cost FROM ${f.table('tf_credit_usage')} WHERE id LIKE $1 ORDER BY id`,
        [`%${turnId}%`],
      )
    ).rows;
  const activities = createConversationActivities(f.runtime);

  const work = await send();
  const delivered = await activities.deliverConversationReply(work);
  assert.equal(delivered.outcome, 'completed');
  assert.equal(
    await activities.generateConversationTitle({ ...work, ...delivered.title, attempt: 1, final: true }),
    'generated',
  );
  assert.deepEqual({ chat: calls.chat, title: calls.title }, { chat: 1, title: 1 });
  const known = await rows(work.turnId);
  const replyCall = known.find(row => row.id.startsWith('chat:'));
  const titleCall = known.find(row => row.id.startsWith('chat-title:'));
  for (const row of [replyCall, titleCall]) {
    assert.equal(row.cost, deepseekPicoUsd.toString(), `${row.id} is charged its reported usage`);
    assert.ok(BigInt(row.charged) < BigInt(row.reserved), `${row.id} settles below its reservation`);
  }
  assert.equal(logs.filter(line => line['error.type'] === 'usage-unknown').length, 0);

  // Truly unknown usage keeps today's policy: the call settles at its reservation, and the gap is counted and logged.
  reportUsage = false;
  const unknownWork = await send();
  assert.equal((await activities.deliverConversationReply(unknownWork)).outcome, 'completed');
  const [unknownCall] = await rows(unknownWork.turnId);
  assert.ok(unknownCall.id.startsWith('chat:'));
  assert.ok(
    BigInt(unknownCall.cost) > 100n * deepseekPicoUsd,
    'an unknown call is charged its worst case, not its tokens',
  );
  assert.ok(BigInt(unknownCall.charged) <= BigInt(unknownCall.reserved));
  const warnings = logs.filter(line => line['error.type'] === 'usage-unknown');
  assert.deepEqual(warnings.map(line => [line.level, line.operation]).sort(), [
    ['warn', 'chat.credit-usage'],
    ['warn', 'chat.model-usage'],
  ]);
});
