import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentReply, useCurrentReply, type OutgoingMessage } from '../src/features/chat/current-reply.ts';
import type { ConversationCommand, ConversationMessage } from '../src/features/chat/conversation-api.ts';
import type { CommandState } from '../src/features/chat/conversation-state.ts';
import type { ConversationStreamSnapshot } from '../src/features/chat/conversation-stream.ts';
import type { StreamProgress } from '@tulipfarm/conversations/events';

type Input = Parameters<typeof useCurrentReply>[0];
const message = (fields: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'message',
  sequence: 1,
  author: 'human',
  createdAt: '2026-10-10T00:00:00Z',
  parts: [{ kind: 'text', text: 'Help me' }],
  tools: [],
  calendarResults: [],
  turn: { id: 'turn', generation: 2, status: 'processing' },
  ...fields,
});
const outgoing: OutgoingMessage = {
  id: 'outgoing',
  content: { version: 1, doc: { type: 'doc', content: [] } },
  references: [{ source: 'tulipfarm', id: 'file', name: 'File', mediaType: 'text/plain', size: 1 }],
  skill: { skillId: 'skill', revision: 'revision', name: 'Skill' },
  at: 123,
};
const tool = (fields: Partial<ConversationMessage['tools'][number]> = {}): ConversationMessage['tools'][number] => ({
  id: 'tool',
  tool: 'tables.list',
  status: 'completed',
  ...fields,
});
const stream = (fields: Partial<ConversationStreamSnapshot> = {}): ConversationStreamSnapshot => ({
  status: 'open',
  previews: new Map(),
  progress: new Map(),
  ...fields,
});
const input = (fields: Partial<Input> = {}): Input => ({
  messages: [message()],
  outgoing: null,
  command: { kind: 'idle' },
  stream: stream(),
  ...fields,
});
const preview = (generation = 2, step = 0, text = 'Reply text') => ({
  identity: { turnId: 'turn', generation, epoch: 1, step },
  seq: 0,
  text,
  complete: true,
});
const progress = (generation = 2, step = 0, round = 1) => ({ turnId: 'turn', generation, epoch: 1, step, round });
const status = (fields: Partial<StreamProgress> & Pick<StreamProgress, 'status'>, step = 0) => ({
  ...progress(2, step, 1),
  toolRounds: 0,
  seq: 0,
  ...fields,
});

function reply(fields: Partial<Input> = {}) {
  let result: ReturnType<typeof useCurrentReply> | undefined;
  function ReadReply() {
    result = useCurrentReply(input(fields));
    return null;
  }
  renderToStaticMarkup(createElement(ReadReply));
  assert.ok(result);
  return result;
}

const send: ConversationCommand = {
  kind: 'send',
  chatId: 'chat',
  commandId: 'command',
  messageId: outgoing.id,
  model: 'model',
  parts: [],
};
const retry: ConversationCommand = {
  kind: 'retry',
  chatId: 'chat',
  commandId: 'retry-command',
  turnId: 'turn',
  expectedGeneration: 2,
};
const sending: CommandState = { kind: 'sending', command: send };
const accepted: CommandState = { kind: 'accepted', operation: 'send' };

test('the screen interface keeps the outgoing message until acceptance appears in saved history', () => {
  for (const command of [sending, accepted]) {
    const result = reply({ messages: [], outgoing, command });
    assert.equal(result.pending, outgoing);
    assert.equal(result.thinking, true);
    assert.equal(result.since, outgoing.at);
  }
  const saved = message({ id: outgoing.id });
  for (const command of [sending, accepted]) {
    const result = reply({ messages: [saved], outgoing, command });
    assert.equal(result.pending, null);
    assert.equal(result.turn, saved.turn);
    assert.equal(result.since, saved.createdAt);
  }
  const failed: CommandState[] = [
    { kind: 'idle' },
    { kind: 'uncertain', command: send },
    { kind: 'rejected', message: 'No', status: 400 },
  ];
  for (const command of failed) assert.equal(reply({ messages: [], outgoing, command }).pending, null);
  assert.equal(reply({ messages: undefined, outgoing, command: accepted }).pending, outgoing);
});

test('the composer keeps a sent draft hidden when saved history arrives before the send settles', () => {
  const saved = message({ id: outgoing.id });
  // History refreshes first while list and credit refreshes still hold the command in sending.
  const persisted = reply({ messages: [saved], outgoing, command: sending });
  assert.equal(persisted.pending, null, 'the saved message replaces the optimistic bubble');
  assert.equal(persisted.draftSent, true, 'the composer does not show the sent text or attachments again');
  assert.equal(reply({ messages: [saved], outgoing: null, command: sending }).draftSent, true);
  assert.equal(reply({ messages: [], outgoing, command: sending }).draftSent, true);
  assert.equal(reply({ messages: [], outgoing, command: accepted }).draftSent, true);
  assert.equal(reply({ messages: [saved], outgoing, command: accepted }).draftSent, false);
  const failed: CommandState[] = [
    { kind: 'uncertain', command: send },
    { kind: 'rejected', message: 'No', status: 400 },
    { kind: 'idle' },
  ];
  for (const command of failed)
    assert.equal(reply({ messages: [], outgoing, command }).draftSent, false, 'a failed send restores the draft');
  for (const command of [
    { kind: 'sending', command: retry },
    { kind: 'accepted', operation: 'retry' },
  ] satisfies CommandState[])
    assert.equal(reply({ messages: [saved], outgoing, command }).draftSent, false);
});

test('sending the same text again shows its own pending bubble', () => {
  const earlier = message({ id: 'earlier-send', turn: { id: 'turn', generation: 2, status: 'completed' } });
  const repeat = { ...outgoing, id: 'repeat-send' };
  const command: CommandState = { kind: 'sending', command: { ...send, messageId: repeat.id } };
  assert.deepEqual(earlier.parts, message({ id: repeat.id }).parts);
  const result = reply({ messages: [earlier], outgoing: repeat, command });
  assert.equal(result.pending, repeat);
  assert.equal(result.thinking, true);
  assert.equal(reply({ messages: [earlier], outgoing: repeat, command: accepted }).pending, repeat);
  assert.equal(
    reply({ messages: [earlier, message({ id: repeat.id })], outgoing: repeat, command: accepted }).pending,
    null,
  );
});

test('continuing a failed turn does not show the last sent message again', () => {
  const saved = message({ id: outgoing.id, turn: { id: 'turn', generation: 2, status: 'failed' } });
  for (const command of [
    { kind: 'sending', command: retry },
    { kind: 'accepted', operation: 'retry' },
  ] satisfies CommandState[]) {
    assert.equal(reply({ messages: [saved], outgoing, command }).pending, null);
    assert.equal(reply({ messages: [], outgoing, command }).pending, null);
  }
  const other = { ...send, messageId: 'other' };
  assert.equal(reply({ messages: [], outgoing, command: { kind: 'sending', command: other } }).pending, null);
});

test('saved history selects the last queued or processing turn and removes streamed text on completion', () => {
  const first = message({ turn: { id: 'earlier', generation: 0, status: 'queued' } });
  const active = message();
  const completed = message({ turn: { id: 'done', generation: 0, status: 'completed' } });
  assert.equal(reply({ messages: [first, active, completed] }).turn, active.turn);
  const streamed = stream({ previews: new Map([['turn', preview()]]) });
  assert.equal(reply({ stream: streamed }).answerText, 'Reply text');
  for (const status of ['completed', 'failed', 'blocked', 'cancelled', 'waiting', 'reconciling'] as const) {
    const result = reply({ messages: [message({ turn: { id: 'turn', generation: 2, status } })], stream: streamed });
    assert.equal(result.answerText, '');
    assert.equal(result.narration, '');
    assert.equal(result.thinking, false);
    assert.equal(result.turn, undefined);
  }
});

test('streamed text and progress must each match the saved generation', () => {
  for (const generation of [1, 3]) {
    const mismatched = reply({
      stream: stream({
        previews: new Map([['turn', preview(generation)]]),
        progress: new Map([['turn', progress(generation, 3, 4)]]),
      }),
    });
    assert.equal(mismatched.answerText, '');
    assert.equal(mismatched.narration, '');
    assert.equal(mismatched.activity.label, 'Thinking');
    const oldProgress = reply({
      stream: stream({
        previews: new Map([['turn', preview()]]),
        progress: new Map([['turn', progress(generation, 3, 4)]]),
      }),
    });
    assert.equal(oldProgress.answerText, 'Reply text');
    assert.equal(oldProgress.activity.label, 'Thinking');
    const oldText = reply({
      stream: stream({
        previews: new Map([['turn', preview(generation)]]),
        progress: new Map([['turn', progress(2, 3, 4)]]),
      }),
    });
    assert.equal(oldText.answerText, '');
    assert.equal(oldText.activity.label, 'Planning next step · Step 4');
  }
});

test('running tools and later decisions turn streamed text into narration, not an answer', () => {
  const streamed = stream({
    previews: new Map([['turn', preview()]]),
    progress: new Map([['turn', progress(2, 0, 1)]]),
  });
  const running = reply({ messages: [message({ tools: [tool({ status: 'running' })] })], stream: streamed });
  assert.equal(running.narration, 'Reply text');
  assert.equal(running.answerText, '');
  assert.equal(running.activity.label, 'Searching');
  const between = reply({ stream: stream({ ...streamed, progress: new Map([['turn', progress(2, 1, 2)]]) }) });
  assert.equal(between.narration, 'Reply text');
  assert.equal(between.answerText, '');
  const final = reply({
    stream: stream({
      ...streamed,
      previews: new Map([['turn', preview(2, 1, 'Final answer')]]),
      progress: new Map([['turn', progress(2, 1, 2)]]),
    }),
  });
  assert.equal(final.narration, '');
  assert.equal(final.answerText, 'Final answer');
});

test('one running-tool interpretation controls both narration and all existing activity labels', () => {
  const streamed = stream({ previews: new Map([['turn', preview()]]) });
  for (const [name, activity, label] of [
    ['tables.propose', 'shaping', 'Drafting'],
    ['skills.draft', 'shaping', 'Drafting'],
    ['rows.create', 'connecting', 'Working'],
    ['slack.send', 'connecting', 'Working'],
    ['web.search', 'searching', 'Searching'],
  ] as const) {
    const result = reply({
      messages: [message({ tools: [tool({ tool: name, status: 'completed', activityStatus: 'running' })] })],
      stream: streamed,
    });
    assert.deepEqual(result.activity, { activity, label });
    assert.equal(result.narration, 'Reply text');
  }
  const overridden = reply({
    messages: [message({ tools: [tool({ status: 'running', activityStatus: 'completed' })] })],
    stream: streamed,
  });
  assert.equal(overridden.narration, '');
  assert.equal(overridden.answerText, 'Reply text');
  assert.equal(overridden.activity.label, 'Planning next step');
});

test('thinking names planning between tools and counts decisions only after the first', () => {
  assert.deepEqual(reply().activity, { activity: 'working', label: 'Thinking' });
  assert.equal(reply({ stream: stream({ progress: new Map([['turn', progress()]]) }) }).activity.label, 'Thinking');
  assert.equal(reply({ messages: [message({ tools: [tool()] })] }).activity.label, 'Planning next step');
  assert.equal(
    reply({
      messages: [message({ tools: [tool()] })],
      stream: stream({ progress: new Map([['turn', progress(2, 2, 3)]]) }),
    }).activity.label,
    'Planning next step · Step 3',
  );
  assert.equal(
    reply({
      messages: [message({ tools: [tool({ tool: 'web.search', status: 'running' })] })],
      stream: stream({ progress: new Map([['turn', progress(2, 1, 2)]]) }),
    }).activity.label,
    'Searching · Step 2',
  );
});

test('a reported status names what the reply does and numbers steps only after work tools finish', () => {
  const label = (update: ReturnType<typeof status>, fields: Partial<Input> = {}) =>
    reply({ stream: stream({ progress: new Map([['turn', update]]) }), ...fields }).activity.label;
  assert.equal(label(status({ status: 'thinking' })), 'Thinking');
  assert.equal(label(status({ status: 'thinking', round: 3 })), 'Thinking', 'rounds without work tools are not steps');
  assert.equal(label(status({ status: 'tool', tool: 'Knowledge' })), 'Using Knowledge…');
  assert.equal(label(status({ status: 'thinking', toolRounds: 1, round: 2 })), 'Planning next step · Step 2');
  assert.equal(label(status({ status: 'tool', tool: 'Slack', toolRounds: 1 })), 'Using Slack… · Step 2');
  assert.equal(label(status({ status: 'tool', toolRounds: 2 })), 'Using a tool… · Step 3');
  assert.equal(label(status({ status: 'finishing', toolRounds: 2, round: 4 })), 'Finishing up');
  assert.equal(
    label(status({ status: 'thinking' }), { messages: [message({ tools: [tool()] })] }),
    'Thinking',
    'a saved tool row does not override the reported status',
  );
  const running = reply({
    messages: [message({ tools: [tool({ tool: 'web.search', status: 'running' })] })],
    stream: stream({ progress: new Map([['turn', status({ status: 'tool', tool: 'Web search', toolRounds: 1 })]]) }),
  });
  assert.deepEqual(running.activity, { activity: 'searching', label: 'Using Web search… · Step 2' });
  assert.equal(running.status, 'tool');
});

test('done ends the spinner and label once the answer is on screen, even while the turn still saves', () => {
  const answered = stream({
    previews: new Map([['turn', preview(2, 1, 'Hello!')]]),
    progress: new Map([['turn', status({ status: 'done', round: 2 }, 1)]]),
  });
  const done = reply({ stream: answered });
  assert.equal(done.answerText, 'Hello!');
  assert.equal(done.thinking, false);
  assert.equal(done.status, 'done');
  assert.equal(done.turn?.status, 'processing');
  const finishing = reply({
    stream: stream({ ...answered, progress: new Map([['turn', status({ status: 'finishing', round: 2 }, 1)]]) }),
  });
  assert.equal(finishing.thinking, true);
  assert.equal(finishing.answerText, 'Hello!', 'a status of the answer step keeps streamed text an answer');
  const unseen = reply({ stream: stream({ progress: new Map([['turn', status({ status: 'done' })]]) }) });
  assert.equal(unseen.thinking, true, 'without a visible answer, as in project chats, progress stays until saved');
  assert.equal(unseen.activity.label, 'Finishing up');
});

test('progress without a status keeps the round-based labels of older workers', () => {
  const legacy = reply({ stream: stream({ progress: new Map([['turn', progress(2, 2, 3)]]) }) });
  assert.equal(legacy.status, undefined);
  assert.equal(legacy.activity.label, 'Planning next step · Step 3');
  assert.equal(legacy.thinking, true);
});

test('stream unavailability does not hide saved work or retained text during polling fallback', () => {
  const fields = {
    messages: [message({ tools: [tool({ status: 'running' })] })],
    stream: stream({ previews: new Map([['turn', preview()]]) }),
  };
  const live = reply(fields);
  for (const status of ['connecting', 'unavailable'] as const)
    assert.deepEqual(reply({ ...fields, stream: stream({ ...fields.stream, status }) }), live);
  assert.equal(reply({ stream: stream({ status: 'unavailable' }) }).thinking, true);
  assert.equal(reply({ messages: [], stream: stream({ status: 'unavailable' }) }).thinking, false);
});

test('slow-reply identity changes only with the existing progress signals', () => {
  const base = input();
  const identity = currentReply(base).processingKey;
  assert.equal(
    currentReply({ ...base, messages: [message({ parts: [{ kind: 'text', text: 'Other text' }] })] }).processingKey,
    identity,
  );
  assert.equal(currentReply({ ...base, stream: stream({ status: 'unavailable' }) }).processingKey, identity);
  assert.notEqual(
    currentReply({ ...base, stream: stream({ previews: new Map([['turn', preview()]]) }) }).processingKey,
    identity,
  );
  assert.notEqual(
    currentReply({ ...base, stream: stream({ progress: new Map([['turn', progress(2, 1)]]) }) }).processingKey,
    identity,
  );
  assert.notEqual(
    currentReply({ ...base, messages: [message({ tools: [tool({ status: 'running' })] })] }).processingKey,
    identity,
  );
  const queued = currentReply(
    input({ messages: [message({ turn: { id: 'turn', generation: 2, status: 'queued' } })] }),
  );
  assert.equal(queued.queuedKey, 'turn:2');
  assert.equal(queued.processingKey, null);
  assert.equal(
    currentReply(input({ messages: [message({ turn: { id: 'turn', generation: 3, status: 'queued' } })] })).queuedKey,
    'turn:3',
  );
});
