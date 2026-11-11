import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type * as ConversationApi from '../src/features/chat/conversation-api.ts';
import type * as ReplyFooterModule from '../src/features/chat/reply-footer.tsx';
import type * as ToolLabels from '../src/features/chat/tool-labels.tsx';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { chatHistorySchema } = (await server.ssrLoadModule(
  '/src/features/chat/conversation-api.ts',
)) as typeof ConversationApi;
const { ReplyFooter } = (await server.ssrLoadModule('/src/features/chat/reply-footer.tsx')) as typeof ReplyFooterModule;
const { toolActivityItems } = (await server.ssrLoadModule('/src/features/chat/tool-labels.tsx')) as typeof ToolLabels;

const proposalId = randomUUID();
// History for a reply whose model call failed after `tables.propose` saved a proposal, in the shape the server sends.
const history = (turn: { status: string; errorCode: string | null }, tool: Record<string, unknown>) =>
  chatHistorySchema.shape.messages.element.parse({
    id: randomUUID(),
    sequence: 1,
    author: 'human',
    createdAt: '2026-11-08T00:00:00Z',
    parts: [{ kind: 'text', text: 'Create a customers table' }],
    turn: { id: randomUUID(), generation: 0, ...turn },
    tools: [{ id: proposalId, tool: 'tables.propose', status: 'completed', ...tool }],
  });
const failed = { status: 'failed', errorCode: 'model-incomplete-response' };
const footer = (message: ReturnType<typeof history>) =>
  renderToStaticMarkup(
    createElement(ReplyFooter, { turn: message.turn!, tools: message.tools, disabled: false, control: () => {} }),
  );
const kept = 'Reply text missing. The table change proposal from this reply is still valid.';

test('a reply that fails after saving a table proposal says only its text is missing', () => {
  const message = history(failed, { tableProposal: true, activityStatus: 'waiting' });
  const html = footer(message);
  assert.ok(html.includes(kept));
  assert.ok(!html.includes('Reply failed'));
  assert.ok(html.includes('The agent stopped without finishing your request.'), 'the provider reason stays');
  assert.ok(html.includes('>Continue</button>'), 'the reply text can still be written');
  assert.ok(html.includes('>Cancel reply</button>'));
  assert.deepEqual(
    toolActivityItems(message.tools).map(item => item.status),
    ['waiting'],
  );
  // Once approved, history reports the proposal's own status; the reply still doesn't read as failed.
  for (const activityStatus of ['running', 'completed'] as const) {
    const approved = history(failed, { tableProposal: true, activityStatus });
    assert.deepEqual(
      toolActivityItems(approved.tools).map(item => item.status),
      [activityStatus],
    );
    assert.ok(footer(approved).includes(kept), activityStatus);
    assert.ok(!footer(approved).includes('Reply failed'), activityStatus);
  }
});

test('a failed reply that saved no proposal still reads as failed', () => {
  const html = footer(history(failed, { activityStatus: 'completed', activityDetail: 'Corrected and resubmitted.' }));
  assert.ok(html.includes('Reply failed'));
  assert.ok(!html.includes(kept));
});

test('a reply waiting to retry its model call after saving a proposal shows the retry, not a failure', () => {
  const html = footer(
    history({ status: 'queued', errorCode: 'model-rate-limit' }, { tableProposal: true, activityStatus: 'waiting' }),
  );
  assert.ok(html.includes('The model provider returned an error. Retrying automatically…'));
  assert.ok(!html.includes('Reply failed'));
  assert.ok(!html.includes(kept));
});

test('a reply whose model retries ran out says so in an alert instead of ending silently', () => {
  const html = footer(history({ status: 'failed', errorCode: 'model-unavailable' }, { status: 'failed' }));
  assert.ok(html.includes('Reply failed'));
  assert.match(html, /role="alert"[^>]*>[^<]*The model provider is unavailable, so no answer was written\./);
});
