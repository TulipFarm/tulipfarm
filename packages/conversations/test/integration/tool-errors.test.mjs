import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { observeTool } from '@tulipfarm/observability';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test('generic tool failures do not instruct the model to infer missing permissions', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Prepare a resource proposal' }],
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      const generic = await executeTool('tables.propose', false, async () => {
        throw new Error('private diagnostic');
      });
      assert.equal(generic.result.error, 'tool-failed');
      assert.match(generic.result.instruction, /not evidence of a permission denial/);
      assert.doesNotMatch(JSON.stringify(generic), /private diagnostic/);
      const denied = await executeTool('tables.propose', false, async () => {
        throw new AccessDenied();
      });
      assert.equal(denied.result.error, 'access-denied');
      assert.match(denied.result.instruction, /request was denied/);
      return 'The first failure has an unconfirmed cause. The second request was denied.';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(tool => tool.status),
      ['failed', 'blocked'],
    );
  } finally {
    await f.close();
  }
});

test('a tool denial that also denies its receipt guard returns to the model instead of failing the reply', async t => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read my GitHub issues' }],
    });
    // Stands in for a retained source that fails its recheck during the tool and stays denied for the receipt guard.
    let denied = false;
    const runtime = {
      transaction: (id, range, action) =>
        f.runtime.transaction(id, range, tx =>
          action({
            ...tx,
            client: {
              query: async (sql, values) => {
                if (denied && sql.includes('AND sequence = $2 AND id <> $3')) throw new AccessDenied();
                return tx.client.query(sql, values);
              },
            },
          }),
        ),
    };
    const lines = [];
    t.mock.method(process.stdout, 'write', line => {
      lines.push(String(line));
      return true;
    });
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      const output = await executeTool('github.personal.read', false, async () => {
        denied = true;
        throw new AccessDenied();
      });
      denied = false;
      assert.equal(output.result.error, 'access-denied');
      return 'GitHub denied that read.';
    });
    const outcome = await executor.process({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    t.mock.restoreAll();
    assert.equal(outcome, 'completed');
    assert.equal(
      lines.some(line => line.includes('"conversation.reply"')),
      false,
    );
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(tool => tool.status),
      ['blocked'],
    );
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('a denied reply fails without retrying and logs the stage where the denial escaped', async t => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Private request text' }],
    });
    const lines = [];
    t.mock.method(process.stdout, 'write', line => {
      lines.push(String(line));
      return true;
    });
    const executor = createConversationExecutor(f.runtime, async () => {
      throw new AccessDenied();
    });
    const outcome = await executor.process({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    t.mock.restoreAll();
    assert.equal(outcome, 'failed');
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(history.messages[0].turn, {
      id: sent.turnId,
      status: 'failed',
      generation: 1,
      errorCode: 'access-denied',
    });
    const failure = lines.map(line => JSON.parse(line)).find(record => record.operation === 'conversation.reply');
    assert.equal(failure['error.type'], 'AccessDenied');
    assert.equal(failure['error.stage'], 'model');
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(`Private request text|${chatId}|${sent.turnId}`));
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test('each failed chat tool emits one call_failed record', async t => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Send a Slack message' }],
    });
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, 'write', (line, ...rest) => {
      if (String(line).includes('"call_failed"')) lines.push(JSON.parse(line));
      return write(line, ...rest);
    });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool('slack.message.send', false, () =>
        observeTool('slack.message.send', 'chat', async () => {
          throw new AccessDenied();
        }),
      );
      await executeTool('tables.propose', false, async () => {
        throw new Error('private diagnostic');
      });
      return 'Both tools failed.';
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    t.mock.restoreAll();
    const tools = lines.filter(line => line.category === 'tool');
    assert.deepEqual(
      tools.map(line => [line.tool, line.outcome, line['error.type'], typeof line.duration_ms]),
      [
        ['slack.message.send', 'error', 'AccessDenied', 'number'],
        ['tables.propose', 'error', 'Error', 'undefined'],
      ],
    );
  } finally {
    await f.close();
  }
});

test('an unverifiable source retries the reply and logs its classification', async t => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Private request text' }],
    });
    const lines = [];
    t.mock.method(process.stdout, 'write', line => {
      lines.push(String(line));
      return true;
    });
    const unavailable = Object.assign(new SourceAuthorizationUnavailable(), { code: 'github-rate-limited' });
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      const refused = await executeTool('tables.propose', false, async () => {
        throw unavailable;
      });
      assert.equal(refused.result.error, 'source-unavailable');
      assert.match(refused.result.instruction, /not a permission denial/);
      throw unavailable;
    });
    const outcome = await executor.process({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    t.mock.restoreAll();
    assert.equal(outcome, 'retry');
    const history = await f.store.history(w.id, w.userId, chatId);
    assert.deepEqual(
      history.messages[0].tools.map(tool => tool.status),
      ['blocked'],
    );
    assert.equal(history.messages[0].turn.errorCode, 'transient-failure');
    const failure = lines.map(line => JSON.parse(line)).find(record => record.operation === 'conversation.reply');
    assert.equal(failure['error.code'], 'github-rate-limited');
    assert.equal(failure['error.stage'], 'model');
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});
