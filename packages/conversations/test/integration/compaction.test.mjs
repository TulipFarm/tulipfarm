import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

const summaryJson = goal =>
  JSON.stringify({
    goal,
    state: 'Draft grouped by supplier',
    decisions: ['Formal tone'],
    openWork: ['Add penalty clauses'],
  });
const bytes = messages => messages.reduce((total, message) => total + Buffer.byteLength(message.text), 0);

function fakeCompactor({ window = 100_000, policy = {}, summarize } = {}) {
  const calls = [];
  return {
    calls,
    compactor: {
      policy: async () => ({
        automatic: true,
        triggerPercent: 70,
        targetPercent: 30,
        outputPrompt: null,
        revision: 0,
        families: ['claude-haiku', 'deepseek-flash'],
        ...policy,
      }),
      measure: async ({ messages }) => ({ tokens: bytes(messages), window }),
      window: async () => 200_000,
      summarize: async input => {
        calls.push(input);
        return summarize
          ? summarize(input)
          : {
              text: input.purpose === 'summary' ? summaryJson(`goal ${calls.length}`) : '## Handoff\n- Next: penalties',
              familyId: 'claude-haiku',
              fallbackFrom: null,
            };
      },
    },
  };
}

async function exchange(f, chatId, executor, parts, generation = 0) {
  const w = f.workspace;
  const sent = await f.store.send(w.id, w.userId, chatId, { commandId: randomUUID(), messageId: randomUUID(), parts });
  const outcome = await executor.process({
    workspaceId: w.id,
    conversationId: chatId,
    turnId: sent.turnId,
    generation,
  });
  return { sent, outcome };
}

test(
  '/compact summarizes earlier exchanges, keeps the latest completed exchange, writes a separate handoff, and preserves the transcript',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const seen = [];
      const { calls, compactor } = fakeCompactor();
      const offered = [];
      const executor = createConversationExecutor(
        f.runtime,
        async ({ messages, earlierMessages }) => {
          seen.push(messages);
          offered.push(earlierMessages);
          return `reply ${seen.length}`;
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        compactor,
      );
      await exchange(f, chatId, executor, [{ kind: 'text', text: 'First: use exactly "Net 30, 2% penalty".' }]);
      await exchange(f, chatId, executor, [{ kind: 'text', text: 'Second request' }]);
      await exchange(f, chatId, executor, [{ kind: 'text', text: 'Latest request' }]);
      const { outcome } = await exchange(f, chatId, executor, [{ kind: 'compact', prompt: 'For the finance team' }]);
      assert.equal(outcome, 'completed');
      assert.equal(seen.length, 3, 'a /compact turn never calls the chat responder');
      assert.deepEqual(
        calls.map(call => call.purpose),
        ['summary', 'handoff'],
      );
      assert.match(calls[0].messages[0].text, /Net 30, 2% penalty/u);
      assert.doesNotMatch(calls[0].messages[0].text, /Latest request/u, 'the latest completed exchange stays verbatim');
      assert.match(calls[1].system, /For the finance team/u);
      const history = await f.store.history(w.id, w.userId, chatId);
      assert.deepEqual(
        history.messages
          .filter(message => message.author === 'human')
          .map(message => (message.parts[0].kind === 'text' ? message.parts[0].text : '/compact')),
        ['First: use exactly "Net 30, 2% penalty".', 'Second request', 'Latest request', '/compact'],
        'the original transcript is preserved',
      );
      const status = history.messages.at(-1).parts[0];
      assert.equal(status.kind, 'compaction');
      assert.equal(status.state, 'compacted');
      assert.equal(status.trigger, 'manual');
      assert.equal(status.handoffStatus, 'completed');
      const detail = await f.store.compaction(w.id, w.userId, chatId, status.compactionId);
      assert.equal(detail.modelFamilyId, 'claude-haiku');
      assert.equal(detail.handoff.status, 'completed');
      assert.equal(detail.handoff.text, '## Handoff\n- Next: penalties');
      assert.equal(detail.handoff.prompt, 'For the finance team');

      await exchange(f, chatId, executor, [{ kind: 'text', text: 'Continue' }]);
      const context = seen
        .at(-1)
        .map(message => message.text)
        .join('\n');
      assert.match(
        context,
        /Working summary of earlier conversation/u,
        'the model reads the working summary, not the handoff',
      );
      assert.deepEqual(
        offered,
        [false, false, false, true],
        'earlier messages are rereadable only once a summary is in context',
      );
      assert.doesNotMatch(context, /## Handoff/u);
      assert.doesNotMatch(context, /Second request/u);
      assert.match(context, /Latest request/u);
      assert.match(context, /Continue/u);
      await assert.rejects(
        f.store.compaction(w.id, w.userId, chatId, randomUUID()),
        { message: 'Resource not found' },
        'an unknown compaction reads as not found',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'automatic compaction runs at the trigger, records a durable status entry, and the reply reads the summary',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const seen = [];
      const { calls, compactor } = fakeCompactor({ window: 16_000 });
      const executor = createConversationExecutor(
        f.runtime,
        async ({ messages }) => {
          seen.push(messages);
          return 'ok';
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        compactor,
      );
      for (const word of ['alpha', 'bravo', 'charlie'])
        await exchange(f, chatId, executor, [{ kind: 'text', text: `${word} ${'x'.repeat(3000)}` }]);
      assert.equal(calls.length, 0, 'no compaction below the trigger');
      const { outcome } = await exchange(f, chatId, executor, [{ kind: 'text', text: `delta ${'x'.repeat(3000)}` }]);
      assert.equal(outcome, 'completed');
      assert.deepEqual(
        calls.map(call => call.purpose),
        ['summary'],
      );
      const context = seen
        .at(-1)
        .map(message => message.text)
        .join('\n');
      assert.match(context, /Working summary of earlier conversation/u);
      assert.doesNotMatch(context, /alpha/u);
      assert.match(context, /charlie/u, 'the latest completed exchange stays');
      assert.ok(bytes(seen.at(-1)) < 16_000 * 0.7);
      const history = await f.store.history(w.id, w.userId, chatId);
      const status = history.messages.flatMap(message => message.parts).find(part => part.kind === 'compaction');
      assert.equal(status.trigger, 'automatic');
      assert.equal(status.state, 'compacted');
      assert.equal(status.handoffStatus, null, 'automatic compaction writes no handoff');
      assert.ok(status.beforeTokens > status.afterTokens);
      assert.equal(history.messages.at(-1).parts[0].text, 'ok');
    } finally {
      await f.close();
    }
  },
);

test(
  'repeated summary failures open the circuit breaker; an oversized chat then fails as paused and compact-and-retry recovers with a recorded budget fallback',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      let broken = true;
      const { calls, compactor } = fakeCompactor({
        window: 10_000,
        summarize: input => {
          if (broken) throw new Error('provider timeout');
          return {
            text: input.purpose === 'summary' ? summaryJson('recovered') : 'handoff',
            familyId: 'deepseek-flash',
            fallbackFrom: 'claude-haiku',
          };
        },
      });
      const executor = createConversationExecutor(
        f.runtime,
        async () => 'ok',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        compactor,
      );
      for (const word of ['one', 'two', 'three'])
        await exchange(f, chatId, executor, [{ kind: 'text', text: `${word} ${'x'.repeat(3000)}` }]);
      for (let index = 0; index < 2; index++)
        assert.equal(
          (await exchange(f, chatId, executor, [{ kind: 'text', text: `small ${index}` }])).outcome,
          'completed',
          'a failed compaction still replies when the context fits',
        );
      const statuses = (await f.store.history(w.id, w.userId, chatId)).messages
        .flatMap(message => message.parts)
        .filter(part => part.kind === 'compaction');
      assert.deepEqual(
        statuses.map(part => [part.trigger, part.state, part.errorCode]),
        Array(3).fill(['automatic', 'failed', 'compaction-model-failed']),
      );
      const attempts = calls.length;
      const { sent } = await exchange(f, chatId, executor, [{ kind: 'text', text: `four ${'x'.repeat(3000)}` }]);
      assert.equal(calls.length, attempts, 'the open breaker stops automatic attempts');
      const paused = (await f.store.history(w.id, w.userId, chatId)).messages.find(
        message => message.turn?.id === sent.turnId,
      );
      assert.deepEqual([paused.turn.status, paused.turn.errorCode], ['failed', 'compaction-paused']);
      broken = false;
      const retried = await f.store.retry(w.id, w.userId, chatId, sent.turnId, {
        commandId: randomUUID(),
        expectedGeneration: paused.turn.generation,
      });
      assert.equal(
        await executor.process({
          workspaceId: w.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: retried.generation,
        }),
        'completed',
        'compact and retry bypasses the open breaker once',
      );
      const history = await f.store.history(w.id, w.userId, chatId);
      const status = history.messages
        .flatMap(message => message.parts)
        .filter(part => part.kind === 'compaction')
        .at(-1);
      assert.deepEqual([status.trigger, status.state], ['manual', 'compacted']);
      assert.equal(history.messages.at(-1).parts[0].text, 'ok');
      const detail = await f.store.compaction(w.id, w.userId, chatId, status.compactionId);
      assert.deepEqual(
        [detail.modelFamilyId, detail.fallbackFromFamilyId],
        ['deepseek-flash', 'claude-haiku'],
        'a budget fallback is recorded, never hidden',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'without an approved summary model, compaction fails visibly instead of using the chat model',
  { timeout: 60_000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const { calls, compactor } = fakeCompactor({ policy: { families: [] } });
      const executor = createConversationExecutor(
        f.runtime,
        async () => 'ok',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        compactor,
      );
      await exchange(f, chatId, executor, [{ kind: 'text', text: 'one' }]);
      await exchange(f, chatId, executor, [{ kind: 'text', text: 'two' }]);
      await exchange(f, chatId, executor, [{ kind: 'compact' }]);
      assert.equal(calls.length, 0);
      const status = (await f.store.history(w.id, w.userId, chatId)).messages.at(-1).parts[0];
      assert.deepEqual(
        [status.state, status.errorCode, status.handoffStatus],
        ['failed', 'compaction-model-unavailable', 'failed'],
      );
    } finally {
      await f.close();
    }
  },
);
