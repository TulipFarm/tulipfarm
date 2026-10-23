import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { nativeChatTools } from '../src/native-tools.ts';
import { invokeSocialTool, socialPostSources, socialToolNames } from '../src/social-tools.ts';
import { discoverToolNames, isExternalTool, parseToolCall, readOnlyTools } from '../src/tools.ts';

const socialNames = ['social_list_channels', 'social_prepare_post', 'social_read_post', 'social_revise_post'];
const workspaceId = randomUUID();
const channelId = randomUUID();
const conversationId = randomUUID();
const messageId = randomUUID();
const variant = {
  channelId,
  expectedChannelVersion: 1,
  content: { platform: 'linkedin', text: 'Launching today', media: [], visibility: 'public' },
  publishAt: null,
};
const human = { kind: 'human', userId: 'user-1', membershipId: randomUUID() };
const agent = { kind: 'agent', agentId: randomUUID(), sponsor: human };
const knowledge = { kind: 'knowledge-source', sourceId: randomUUID() };
const conversation = { kind: 'conversation', conversationId, messageId, sources: [knowledge] };

function service() {
  const calls = [];
  const postId = randomUUID();
  const prepared = {
    post: { id: postId, currentRevision: 1 },
    variants: [{ channelId, valid: true, errors: [] }],
  };
  return {
    calls,
    postId,
    tools: {
      async listChannels(...args) {
        calls.push(['listChannels', ...args]);
        return [];
      },
      async prepare(...args) {
        calls.push(['prepare', ...args]);
        return prepared;
      },
      async get(...args) {
        calls.push(['get', ...args]);
        return { id: args[2] };
      },
      async revise(...args) {
        calls.push(['revise', ...args]);
        return prepared;
      },
    },
  };
}

test('PRODUCT 36: chat offers the social tools only where social publishing is on', () => {
  const off = nativeChatTools(undefined, false).tools.map(tool => tool.name);
  assert.deepEqual(
    off.filter(name => name.startsWith('social_')),
    [],
  );
  const on = nativeChatTools(undefined, false, undefined, true).tools.map(tool => tool.name);
  assert.deepEqual(on.filter(name => name.startsWith('social_')).sort(), socialNames);
  assert.deepEqual(
    discoverToolNames({ kind: 'chat' }).filter(name => name.startsWith('social.')),
    [],
  );
  assert.deepEqual(
    discoverToolNames({ kind: 'chat', social: true })
      .filter(name => name.startsWith('social.'))
      .sort(),
    [...socialToolNames].sort(),
  );
  // A saved agent's tool list cannot admit them in this slice, even when named.
  assert.deepEqual(
    discoverToolNames({ kind: 'agent', tools: socialToolNames, task: true }).filter(name => name.startsWith('social.')),
    [],
  );
  for (const tool of socialToolNames) assert.equal(isExternalTool(tool), true);
  assert.equal(readOnlyTools.has('social.list.channels'), true);
  assert.equal(readOnlyTools.has('social.read.post'), true);
  assert.equal(readOnlyTools.has('social.prepare.post'), false);
  assert.equal(readOnlyTools.has('social.revise.post'), false);
});

test('PRODUCT 36: no social tool publishes, decides or sets review choices; the runtime supplies the command and origin', () => {
  const catalog = nativeChatTools(undefined, false, undefined, true);
  const social = catalog.tools.filter(tool => tool.name.startsWith('social_'));
  for (const tool of social) {
    assert.doesNotMatch(tool.name, /publish|approve|decide|decision|reject|choice|resume|cancel|settle/);
    const properties = Object.keys(tool.parameters.properties ?? {});
    for (const forbidden of ['commandId', 'origin', 'reviewChoices', 'decision', 'contentDigest', 'sources'])
      assert.equal(properties.includes(forbidden), false, `${tool.name} exposes ${forbidden}`);
  }
  const activity = 'Preparing a post';
  const prepare = catalog.resolve({ name: 'social_prepare_post', input: { activity, variants: [variant] } });
  assert.equal(prepare.ok, true);
  assert.deepEqual(prepare.call, { tool: 'social.prepare.post', variants: [variant] });
  for (const extra of [
    { commandId: randomUUID() },
    { origin: { kind: 'conversation', conversationId, messageId } },
    { reviewChoices: { privacy: 'public' } },
    { decision: 'approved' },
  ])
    assert.equal(
      catalog.resolve({ name: 'social_prepare_post', input: { activity, variants: [variant], ...extra } }).ok,
      false,
      JSON.stringify(extra),
    );
  const revise = catalog.resolve({
    name: 'social_revise_post',
    input: { activity, postId: randomUUID(), expectedRevision: 1, variants: [variant] },
  });
  assert.equal(revise.ok, true);
  assert.equal(
    catalog.resolve({
      name: 'social_revise_post',
      input: { activity, postId: randomUUID(), expectedRevision: 1, variants: [variant], reviewChoices: {} },
    }).ok,
    false,
  );
  assert.equal(catalog.resolve({ name: 'social_decide_post', input: { activity } }).ok, false);
});

test('PRODUCT 36: a social call is refused outside a chat with social publishing on', () => {
  const call = { tool: 'social.prepare.post', variants: [variant] };
  assert.throws(() => parseToolCall(call, { kind: 'chat' }), AccessDenied);
  assert.throws(() => parseToolCall(call, { kind: 'agent', tools: ['social.prepare.post'], task: true }), AccessDenied);
  assert.deepEqual(parseToolCall(call, { kind: 'chat', social: true }), call);
  assert.throws(() => parseToolCall({ ...call, commandId: randomUUID() }, { kind: 'chat', social: true }));
});

test('PRODUCT 36: prepare uses the call as its command, the chat as its origin, and the chat’s sources', async () => {
  const { calls, tools, postId } = service();
  const callId = randomUUID();
  const result = await invokeSocialTool(
    tools,
    { workspaceId, principal: human, callId, origin: { ...conversation, sources: [knowledge, knowledge] } },
    { tool: 'social.prepare.post', variants: [variant] },
  );
  assert.deepEqual(result, {
    postId,
    approvalId: postId,
    variants: [{ channelId, valid: true, errors: [] }],
  });
  assert.deepEqual(calls, [
    [
      'prepare',
      workspaceId,
      human,
      { commandId: callId, origin: { kind: 'conversation', conversationId, messageId }, variants: [variant] },
      { dependencies: [{ kind: 'private-conversation', conversationId }, knowledge] },
    ],
  ]);
});

test('PRODUCT 36: revise and read act as the principal, and an agent acts with its sponsor’s grants', async () => {
  const { calls, tools } = service();
  const postId = randomUUID();
  const callId = randomUUID();
  await invokeSocialTool(
    tools,
    { workspaceId, principal: agent, callId, origin: conversation },
    { tool: 'social.revise.post', postId, expectedRevision: 2, variants: [variant] },
  );
  await invokeSocialTool(tools, { workspaceId, principal: agent, callId }, { tool: 'social.read.post', postId });
  await invokeSocialTool(
    tools,
    { workspaceId, principal: agent, callId },
    { tool: 'social.list.channels', platform: 'linkedin' },
  );
  assert.deepEqual(calls, [
    [
      'revise',
      workspaceId,
      agent,
      postId,
      { expectedRevision: 2, variants: [variant] },
      { dependencies: [{ kind: 'private-conversation', conversationId }, knowledge] },
    ],
    ['get', workspaceId, agent, postId],
    ['listChannels', workspaceId, agent, { platform: 'linkedin' }],
  ]);
});

test('PRODUCT 36: without the service or an origin, a social tool changes nothing', async () => {
  const { calls, tools } = service();
  const callId = randomUUID();
  assert.equal(
    (
      await invokeSocialTool(
        undefined,
        { workspaceId, principal: human, callId, origin: conversation },
        { tool: 'social.prepare.post', variants: [variant] },
      )
    ).error,
    'social-unavailable',
  );
  assert.deepEqual(
    await invokeSocialTool(
      tools,
      { workspaceId, principal: human, callId },
      { tool: 'social.prepare.post', variants: [variant] },
    ),
    { error: 'social-origin-required' },
  );
  assert.deepEqual(
    await invokeSocialTool(
      tools,
      { workspaceId, principal: human, callId },
      { tool: 'social.revise.post', postId: randomUUID(), expectedRevision: 1, variants: [variant] },
    ),
    { error: 'social-origin-required' },
  );
  assert.deepEqual(calls, []);
});

test('PRODUCT 36: a task’s post depends on the private task, which keeps it from being approved', () => {
  const taskId = randomUUID();
  assert.deepEqual(socialPostSources({ kind: 'task', taskId, generation: 3, sources: [knowledge] }), {
    dependencies: [{ kind: 'private-task', taskId }, knowledge],
  });
});
