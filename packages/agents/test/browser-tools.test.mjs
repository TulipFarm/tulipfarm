import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserHostError } from '@tulipfarm/browser';
import { SecretError } from '@tulipfarm/secrets';
import { invokeBrowser } from '../src/browser-tools.ts';
import { outboundRefusal } from '../src/mcp-catalog-egress.ts';
import { discoverToolNames, isExternalTool } from '../src/tools.ts';

const origin = {
  workspaceId: '6f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  conversationId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
  actor: { kind: 'human', userId: 'u1', membershipId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' },
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
  // A browser step can take a minute and signing in opens its own secrets transaction, so none holds the reply's.
  for (const tool of ['browser.act', 'browser.handoff', 'browser.signIn'])
    assert.equal(isExternalTool(tool), true, tool);
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
  const withheld = fakeClient({
    act: async () => ({ state, snapshot: '', truncated: false, notice: 'No screenshot' }),
  });
  const shown = await invokeBrowser({ client: withheld.client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(shown.images, undefined);
  assert.equal(shown.result.notice, 'No screenshot');
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

const login = { username: 'ada@example.com', password: 'correct horse battery' };

function fakeSecrets(secret, uses = []) {
  return {
    uses,
    secrets: holder => ({
      resolve: async ({ reference }, url) => {
        assert.equal(holder.conversationId, origin.conversationId);
        if (reference !== 'ref-1') throw new SecretError('not-found');
        if (new URL(url).hostname !== 'example.com') throw new SecretError('destination-denied');
        return {
          secretId: 'sec-1',
          kind: 'username-password',
          placement: { kind: 'browser' },
          destinations: [{ kind: 'host', value: 'example.com' }],
          value: login,
          ...secret,
        };
      },
      recordUse: async (id, url) => void uses.push([id, url]),
    }),
  };
}

const signedIn = { state, snapshot: '- heading "Welcome" [ref=e9]', truncated: false, screenshot: 'BBBB' };

test('Sign-in types the secret through the host and never returns it', async () => {
  const { client, calls } = fakeClient({
    state: async id => (calls.push(['state', id]), state),
    typeSecret: async (id, input) => (calls.push(['typeSecret', id, input]), signedIn),
  });
  const { secrets, uses } = fakeSecrets();
  const output = await invokeBrowser({ client, imageInput: true, secrets }, origin, {
    tool: 'browser.signIn',
    secret: 'ref-1',
    username: 'e1',
    password: 'e2',
    submit: 'e3',
  });
  assert.deepEqual(calls.at(-1)[2], {
    hosts: ['example.com'],
    fields: [
      { ref: 'e1', kind: 'username', value: login.username },
      { ref: 'e2', kind: 'password', value: login.password },
    ],
    submit: 'e3',
  });
  assert.deepEqual(uses, [['sec-1', 'https://example.com/']]);
  const text = JSON.stringify(output);
  assert.equal(text.includes(login.username) || text.includes(login.password), false);
  assert.equal(output.result.snapshot, signedIn.snapshot);
  // The page may show what was just typed, so sign-in never passes a screenshot on.
  assert.equal(output.images, undefined);
});

test('Sign-in refuses unusable secrets and mismatched fields without typing', async () => {
  const { client, calls } = fakeClient({
    state: async id => (calls.push(['state', id]), state),
    typeSecret: async () => assert.fail('typed'),
  });
  const call = { tool: 'browser.signIn', secret: 'ref-1', username: 'e1', password: 'e2' };
  const run = (secret, overrides = {}) =>
    invokeBrowser({ client, imageInput: false, secrets: fakeSecrets(secret).secrets }, origin, {
      ...call,
      ...overrides,
    });
  assert.equal((await run({ placement: { kind: 'basic' } })).result.error, 'placement-unsupported');
  assert.equal((await run({}, { secret: 'other' })).result.error, 'secret-not-found');
  assert.equal((await run({ kind: 'password', value: { value: 'hunter2' } })).result.error, 'invalid-fields');
  assert.equal((await run({}, { username: undefined })).result.error, 'invalid-fields');
  assert.equal(
    (await run({ destinations: [{ kind: 'endpoint', value: 'https://example.com/api' }] })).result.error,
    'secret-destination-denied',
  );
  const elsewhere = fakeClient({ state: async () => ({ ...state, url: 'https://evil.example/' }) });
  const denied = await invokeBrowser(
    { client: elsewhere.client, imageInput: false, secrets: fakeSecrets().secrets },
    origin,
    call,
  );
  assert.equal(denied.result.error, 'secret-destination-denied');
  const none = await invokeBrowser({ client, imageInput: false }, origin, call);
  assert.equal(none.result.error, 'secrets-unavailable');
});

test('A host refusal to type becomes an instruction', async () => {
  const { client } = fakeClient({
    state: async () => state,
    typeSecret: async () => {
      throw new BrowserHostError('field-refused', 'That field is not a password box', 422);
    },
  });
  const { secrets, uses } = fakeSecrets();
  const output = await invokeBrowser({ client, imageInput: false, secrets }, origin, {
    tool: 'browser.signIn',
    secret: 'ref-1',
    username: 'e1',
    password: 'e2',
  });
  assert.equal(output.result.error, 'field-refused');
  assert.match(output.result.instruction, /password box/);
  assert.deepEqual(uses, []);
});
