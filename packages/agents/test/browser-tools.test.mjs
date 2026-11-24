import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserHostError } from '@tulipfarm/browser';
import { invokeBrowser } from '../src/browser-tools.ts';
import { outboundRefusal } from '../src/mcp-catalog-egress.ts';
import { discoverToolNames } from '../src/tools.ts';

const origin = {
  workspaceId: '6f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  conversationId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
};
const state = { sessionId: 's', url: 'https://example.com/', title: 'Example', controller: 'agent', needsPerson: null };

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    open: async id => (calls.push(['open', id]), state),
    state: async id => (calls.push(['state', id]), null),
    act: async (id, action) => (
      calls.push(['act', id, action]),
      { state, snapshot: '- button "Sign up" [ref=e3]', truncated: false, screenshot: 'AAAA' }
    ),
    needsPerson: async (id, reason) => (calls.push(['needsPerson', id, reason]), state),
    ...overrides,
  };
  return { client, calls };
}

test('Chat lists the browser tools only when the reply offers a browser', () => {
  const chat = discoverToolNames({ kind: 'chat' });
  assert.equal(chat.includes('browser.act'), false);
  const offered = discoverToolNames({ kind: 'chat', browser: true });
  assert.ok(offered.includes('browser.act') && offered.includes('browser.handoff'));
  assert.equal(discoverToolNames({ kind: 'agent', tools: ['browser.act'] }).includes('browser.act'), false);
});

test('A step opens the chat session, returns the page as untrusted data and shows the screenshot', async () => {
  const { client, calls } = fakeClient();
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'navigate', url: 'https://example.com' },
  });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['open', 'act'],
  );
  assert.equal(calls[0][1], calls[1][1]);
  assert.deepEqual(output.result, {
    url: 'https://example.com/',
    title: 'Example',
    snapshot: '- button "Sign up" [ref=e3]',
    untrusted: true,
  });
  assert.deepEqual(output.sources, [{ kind: 'private-conversation', conversationId: origin.conversationId }]);
  assert.equal(output.images.images[0].data, 'AAAA');
  const text = await invokeBrowser({ client, imageInput: false }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(text.images, undefined);
  assert.equal(JSON.stringify(text.result).includes('AAAA'), false);
});

test('A handoff flags the session and tells the model to stop', async () => {
  const { client, calls } = fakeClient();
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Tick the terms box',
  });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['state', 'open', 'needsPerson'],
  );
  assert.deepEqual(calls[2][2], { reason: 'Tick the terms box' });
  assert.equal(output.result.status, 'waiting-for-person');
});

test('A sign-in handoff names the site, and a URL in its place is refused', async () => {
  const { client, calls } = fakeClient();
  await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Sign in to Amazon',
    signIn: 'WWW.Amazon.com',
  });
  assert.deepEqual(calls.at(-1)[2], { reason: 'Sign in to Amazon', signIn: 'amazon.com' });
  const refused = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Sign in',
    signIn: 'https://amazon.com/login',
  });
  assert.equal(refused.result.error, 'invalid-site');
});

test('A host refusal becomes an instruction, not a failed turn', async () => {
  const { client } = fakeClient({
    act: async () => {
      throw new BrowserHostError('person-in-control', 'A member controls this browser', 409);
    },
  });
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'click', ref: 'e3' },
  });
  assert.equal(output.result.error, 'person-in-control');
  assert.match(output.result.instruction, /hand it back/);
  const broken = fakeClient({
    act: async () => {
      throw new Error('bug');
    },
  });
  await assert.rejects(
    invokeBrowser({ client: broken.client, imageInput: true }, origin, {
      tool: 'browser.act',
      action: { action: 'back' },
    }),
    /bug/,
  );
});

test('With MCP tools offered, the browser opens only sites the person named', () => {
  const call = { tool: 'browser.act', action: { action: 'navigate', url: 'https://evil.example/steal' } };
  assert.ok(outboundRefusal(call, { person: 'sign me up on example.com', web: '' }));
  assert.equal(
    outboundRefusal(
      { ...call, action: { action: 'navigate', url: 'https://example.com/signup' } },
      {
        person: 'sign me up on example.com',
        web: '',
      },
    ),
    undefined,
  );
  assert.equal(
    outboundRefusal({ tool: 'browser.act', action: { action: 'click', ref: 'e1' } }, { person: '', web: '' }),
    undefined,
  );
});
