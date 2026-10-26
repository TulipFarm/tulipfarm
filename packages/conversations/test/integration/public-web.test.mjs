import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { createConversations } from '../../src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createChatTools } from '../../../agents/src/tools.ts';
import { respondToConversation } from '../../../../apps/worker/src/conversation-responder.ts';
import {
  anthropicChat,
  completionReply,
  isCompletionRequest,
} from '../../../../apps/worker/test/native-chat-fixture.mjs';

test(
  'a parallel model decision persists concurrent page receipts and retains successes alongside a failed read',
  { timeout: 30000 },
  async t => {
    const f = await conversationFixture();
    const chatId = randomUUID();
    const urls = ['one', 'two', 'three', 'four'].map(path => `https://example.com/${path}`);
    const bothStarted = Promise.withResolvers(),
      release = Promise.withResolvers();
    let started = 0,
      active = 0,
      peak = 0,
      step = 0,
      pending;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      if (isCompletionRequest(JSON.parse(init.body))) return Response.json(completionReply('anthropic'));
      return Response.json(
        anthropicChat(
          step++ === 0
            ? {
                kind: 'parallel',
                calls: urls.map(url => ({ call: { tool: 'web.fetch', url }, text: 'Reading the requested pages' })),
              }
            : { kind: 'answer', text: 'Three pages read; one was unavailable.' },
        ),
      );
    });
    try {
      await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
      const executor = createConversationExecutor(f.runtime, input =>
        respondToConversation(
          { provider: 'anthropic', endpoint: 'https://api.anthropic.com/', model: 'fixture', apiKey: 'synthetic' },
          input.messages,
          (call, sources, activity) =>
            input.executeTool(
              call.tool,
              true,
              async () => {
                peak = Math.max(peak, ++active);
                if (++started === 2) bothStarted.resolve();
                await release.promise;
                active--;
                const failed = call.url === urls[1];
                const source = { url: call.url, title: 'Article', description: '', publishedAt: null };
                return {
                  result: {
                    kind: 'public-web',
                    status: failed ? 'failed' : 'success',
                    sources: failed ? [] : [source],
                    pages: failed
                      ? [{ status: 'failed', url: call.url, error: 'Page unavailable.' }]
                      : [{ status: 'read', ...source, text: 'Article content' }],
                    window: 'any',
                    widened: false,
                    retrievedAt: new Date().toISOString(),
                    untrusted: true,
                  },
                  sources: failed ? [] : [{ kind: 'public-web', url: call.url }],
                };
              },
              sources,
              call,
              activity,
            ),
        ),
      );
      const sent = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: `Summarize ${urls.join(' ')}` }],
      });
      pending = executor.process({
        workspaceId: f.workspace.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation: 0,
      });
      await Promise.race([
        bothStarted.promise,
        pending.then(() => assert.fail('Turn ended before concurrent reads started')),
      ]);
      const running = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
      assert.deepEqual(
        running.messages[0].tools.map(tool => tool.web.status),
        ['running', 'running'],
      );
      release.resolve();
      assert.equal(await pending, 'completed');
      assert.equal(peak, 2);
      assert.equal(step, 2);
      const history = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
      assert.deepEqual(
        history.messages[0].tools.map(tool => [tool.web.urls[0], tool.web.status]),
        urls.map((url, index) => [url, index === 1 ? 'failed' : 'success']),
      );
      const stored = await f.db.databaseAdmin.query(
        `SELECT sources FROM ${f.table('tf_conversation_results')} WHERE turn_id=$1`,
        [sent.turnId],
      );
      assert.deepEqual(stored.rows[0].sources, [
        { kind: 'private-conversation', conversationId: chatId },
        ...[urls[0], urls[2], urls[3]].map(url => ({ kind: 'public-web', url })),
      ]);
    } finally {
      release.resolve();
      await pending;
      await f.close();
    }
  },
);

test('public web receipts persist pending URLs, results and failures without MCP configuration', async () => {
  const f = await conversationFixture();
  const chatId = randomUUID();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let pending;
  try {
    await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
    const url = 'https://example.com/original';
    const result = {
      kind: 'public-web',
      status: 'success',
      sources: [{ url, title: 'Original source', description: '', publishedAt: null }],
      pages: [],
      window: 'any',
      widened: false,
      retrievedAt: new Date().toISOString(),
      untrusted: true,
    };
    const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
      await executeTool(
        'web.fetch',
        true,
        async () => {
          entered.resolve();
          await release.promise;
          return { result, sources: [{ kind: 'public-web', url }] };
        },
        [],
        { tool: 'web.fetch', url },
        'Reading a web page',
      );
      await executeTool(
        'web.fetch',
        true,
        async () => {
          throw new Error('private diagnostic');
        },
        [],
        { tool: 'web.fetch', url: 'https://example.com/failed' },
      );
      return { text: 'Read the original source; the second page failed.', sources: [{ kind: 'public-web', url }] };
    });
    const sent = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Read this page' }],
    });
    pending = executor.process({
      workspaceId: f.workspace.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    await entered.promise;
    const running = await f.store.history(f.workspace.id, f.workspace.userId, chatId);
    assert.deepEqual(running.messages[0].tools[0].web, {
      status: 'running',
      urls: [url],
      failedUrls: [],
      widened: false,
    });
    release.resolve();
    assert.equal(await pending, 'completed');
    const restarted = f.createRuntime();
    try {
      const history = await createConversations(restarted).history(f.workspace.id, f.workspace.userId, chatId);
      assert.deepEqual(
        history.messages[0].tools.map(tool => [tool.web.status, tool.web.urls]),
        [
          ['success', [url]],
          ['failed', ['https://example.com/failed']],
        ],
      );
      assert.deepEqual(history.messages[0].tools[0].web.sources, [{ url, title: 'Original source' }]);
      assert.doesNotMatch(JSON.stringify(history), /private diagnostic/);
      assert.equal(history.messages[1].parts[0].text, 'Read the original source; the second page failed.');
    } finally {
      await restarted.close();
    }
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});

test(
  'live blog read passes through the conversation executor and reloads its original source receipt',
  { skip: !process.env.FIRECRAWL_ENDPOINT },
  async () => {
    const f = await conversationFixture();
    const chatId = randomUUID();
    const url = 'https://simonwillison.net/2025/Mar/11/using-llms-for-code/';
    try {
      await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
      const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        const call = { tool: 'web.fetch', url };
        const output = await executeTool(
          call.tool,
          true,
          context => createChatTools(context.runtime).invokeWithSources(context, call),
          [],
          call,
        );
        assert.equal(output.result.status, 'success');
        assert.match(output.result.pages[0].text, /difficult.*unintuitive/s);
        return { text: 'The author describes coding with LLMs as difficult and unintuitive.', sources: output.sources };
      });
      const sent = await f.store.send(f.workspace.id, f.workspace.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: `summary this blog - ${url}` }],
      });
      assert.equal(
        await executor.process({
          workspaceId: f.workspace.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        }),
        'completed',
      );
      const restarted = f.createRuntime();
      try {
        const history = await createConversations(restarted).history(f.workspace.id, f.workspace.userId, chatId);
        assert.deepEqual(history.messages[0].tools[0].web.urls, [url]);
        assert.equal(history.messages[0].tools[0].web.status, 'success');
        assert.doesNotMatch(JSON.stringify(history.messages[0].tools), /firecrawl|web-api|3003/i);
      } finally {
        await restarted.close();
      }
    } finally {
      await f.close();
    }
  },
);
