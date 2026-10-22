import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConversationEventHub } from '../src/conversation-events.ts';

const channel = 'tf_conversation_events';

function fakeDatabase({ echoProbe = true } = {}) {
  const clients = [];
  return {
    clients,
    connect: async () => {
      const client = new EventEmitter();
      client.queries = [];
      client.released = false;
      client.query = async (text, values) => {
        client.queries.push(values ? [text, ...values] : [text]);
        if (echoProbe && text.startsWith('SELECT pg_notify'))
          setImmediate(() => client.emit('notification', { channel: values[0], payload: values[1] }));
        return { rows: [] };
      };
      client.release = () => {
        client.released = true;
        client.emit('end');
      };
      client.notify = payload =>
        client.emit('notification', {
          channel,
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        });
      clients.push(client);
      return client;
    },
  };
}

async function until(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function healthyHub(t, options = {}) {
  const database = fakeDatabase();
  const hub = createConversationEventHub({
    connect: database.connect,
    backoffMs: { initial: 5, maximum: 20 },
    ...options,
  });
  t.after(() => hub.close());
  await until(() => hub.healthy(), 'hub became healthy');
  return { hub, database, client: database.clients.at(-1) };
}

const workspaceId = randomUUID();
const conversationId = randomUUID();
const turnId = randomUUID();
const text = fields => ({
  kind: 'text',
  workspaceId,
  conversationId,
  turnId,
  generation: 1,
  epoch: 0,
  step: 0,
  seq: 0,
  offset: 0,
  text: '',
  reset: true,
  ...fields,
});

test('the hub reports healthy only after its own probe notification returns', async t => {
  const silent = fakeDatabase({ echoProbe: false });
  const stuck = createConversationEventHub({
    connect: silent.connect,
    probeTimeoutMs: 20,
    backoffMs: { initial: 5, maximum: 5 },
  });
  t.after(() => stuck.close());
  await until(() => silent.clients.length >= 2, 'a missing probe causes a reconnect');
  assert.equal(stuck.healthy(), false);
  assert.equal(silent.clients[0].released, true);

  const { client } = await healthyHub(t);
  assert.deepEqual(client.queries[0], ['LISTEN tf_conversation_events']);
  assert.deepEqual(client.queries[1], ['LISTEN tulipfarm_recommendations_v1']);
  assert.equal(client.queries[2][0], 'SELECT pg_notify($1, $2)');
  assert.equal(client.queries[2][1], channel);
});

test('notifications reach only subscribers of the same conversation', async t => {
  const { hub, client } = await healthyHub(t);
  const mine = [];
  const other = [];
  const otherWorkspace = [];
  hub.subscribe(workspaceId, conversationId, event => mine.push(event));
  hub.subscribe(workspaceId, randomUUID(), event => other.push(event));
  hub.subscribe(randomUUID(), conversationId, event => otherWorkspace.push(event));
  client.notify(text({ text: 'Hel' }));
  client.notify({ kind: 'changed', workspaceId, conversationId, turnId, settled: true });
  assert.deepEqual(mine, [
    { event: 'text', data: { turnId, generation: 1, epoch: 0, step: 0, seq: 0, offset: 0, text: 'Hel', reset: true } },
    { event: 'changed', data: { turnId, settled: true } },
  ]);
  assert.deepEqual(other, []);
  assert.deepEqual(otherWorkspace, []);
});

test('successive quick call transitions reach SSE in order without becoming generic change hints', async t => {
  const { hub, client } = await healthyHub(t);
  const received = [];
  const other = [];
  hub.subscribe(workspaceId, conversationId, event => received.push(event));
  hub.subscribe(workspaceId, randomUUID(), event => other.push(event));
  const call = {
    kind: 'tool',
    workspaceId,
    conversationId,
    turnId,
    generation: 1,
    epoch: 1,
    id: randomUUID(),
    tool: 'rows.get',
    sequence: 1,
    presentation: { label: 'Reading a row', brand: null },
  };
  for (const status of ['running', 'completed']) client.notify({ ...call, status });
  client.notify({ ...call, id: randomUUID(), sequence: 2, status: 'running' });
  assert.deepEqual(
    received.map(event => [event.event, event.data.sequence, event.data.status]),
    [
      ['tool', 1, 'running'],
      ['tool', 1, 'completed'],
      ['tool', 2, 'running'],
    ],
  );
  assert.deepEqual(other, []);
});

test('avatar snapshots stay scoped and ordered and clear when the turn settles', async t => {
  const { hub, client } = await healthyHub(t);
  const avatar = {
    kind: 'avatar',
    workspaceId,
    conversationId,
    turnId,
    generation: 1,
    epoch: 1,
    step: 0,
    seq: 2,
    avatar: { name: 'Bud', state: 'Solving' },
  };
  client.notify(avatar);
  client.notify({ ...avatar, seq: 1, avatar: { name: 'Bud', state: 'Thinking' } });
  assert.equal(hub.snapshot(workspaceId, conversationId)[0].data.avatar.state, 'Solving');
  assert.deepEqual(hub.snapshot(randomUUID(), conversationId), []);
  client.notify({ ...avatar, seq: 3, avatar: { name: 'Other', state: 'Invented' } });
  assert.equal(hub.snapshot(workspaceId, conversationId)[0].data.avatar.state, 'Solving');
  client.notify({ kind: 'changed', workspaceId, conversationId, turnId, settled: true });
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), []);
});

test('recommendation signals share the listener but remain member-scoped and resync on loss', async t => {
  const { hub, client, database } = await healthyHub(t);
  const membershipId = randomUUID();
  const mine = [],
    other = [],
    conversations = [];
  const unsubscribe = hub.subscribeRecommendations(workspaceId, membershipId, event => mine.push(event));
  hub.subscribeRecommendations(workspaceId, randomUUID(), event => other.push(event));
  hub.subscribeRecommendations(randomUUID(), membershipId, event => other.push(event));
  hub.subscribe(workspaceId, membershipId, event => conversations.push(event));
  const event = { kind: 'invalidated', workspaceId, membershipId, version: 4 };
  const notify = value =>
    client.emit('notification', { channel: 'tulipfarm_recommendations_v1', payload: JSON.stringify(value) });
  notify(event);
  notify({ ...event, text: 'private output must not enter the stream' });
  assert.deepEqual(mine, [event]);
  assert.deepEqual(other, []);
  assert.deepEqual(conversations, []);
  assert.equal(database.clients.length, 1, 'both streams use one held database connection');
  client.emit('error', new Error('fixture disconnect'));
  assert.deepEqual(mine.at(-1), { kind: 'resync' });
  await until(() => hub.healthy(), 'recommendation stream reconnects');
  assert.deepEqual(mine.at(-1), { kind: 'resync' });
  unsubscribe();
  const count = mine.length;
  database.clients
    .at(-1)
    .emit('notification', { channel: 'tulipfarm_recommendations_v1', payload: JSON.stringify(event) });
  assert.equal(mine.length, count);
});

test('a snapshot returns the assembled reply text as one reset update until the turn settles', async t => {
  const { hub, client } = await healthyHub(t);
  client.notify(text({ text: 'Hel' }));
  client.notify(text({ seq: 1, offset: 3, text: 'lo', reset: false }));
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), [
    {
      event: 'text',
      data: { turnId, generation: 1, epoch: 0, step: 0, seq: 1, offset: 0, text: 'Hello', reset: true },
    },
  ]);
  assert.deepEqual(hub.snapshot(workspaceId, randomUUID()), []);
  client.notify({ kind: 'changed', workspaceId, conversationId, turnId });
  assert.equal(
    hub.snapshot(workspaceId, conversationId)[0].data.text,
    'Hello',
    'an unsettled change keeps the reply text',
  );
  client.notify({ kind: 'changed', workspaceId, conversationId, turnId, settled: true });
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), []);
});

test('progress is broadcast, kept newest-first in snapshots, and cleared when the turn settles', async t => {
  const { hub, client } = await healthyHub(t);
  const received = [];
  hub.subscribe(workspaceId, conversationId, event => received.push(event));
  const progress = (fields = {}) => ({
    kind: 'progress',
    workspaceId,
    conversationId,
    turnId,
    generation: 1,
    epoch: 0,
    step: 0,
    round: 1,
    ...fields,
  });
  client.notify(progress({ step: 2, round: 2 }));
  client.notify(progress({ step: 1, round: 1 }));
  client.notify(text({ step: 2, text: 'Checking' }));
  assert.deepEqual(received[0], { event: 'progress', data: { turnId, generation: 1, epoch: 0, step: 2, round: 2 } });
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), [
    { event: 'progress', data: { turnId, generation: 1, epoch: 0, step: 2, round: 2 } },
    {
      event: 'text',
      data: { turnId, generation: 1, epoch: 0, step: 2, seq: 0, offset: 0, text: 'Checking', reset: true },
    },
  ]);
  client.notify({ kind: 'changed', workspaceId, conversationId, turnId, settled: true });
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), []);
});

test('reply text with a gap is left out of snapshots', async t => {
  const { hub, client } = await healthyHub(t);
  client.notify(text({ text: 'Hel' }));
  client.notify(text({ seq: 1, offset: 9, text: 'lo', reset: false }));
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), []);
});

test('invalid payloads and other channels are ignored', async t => {
  const { hub, client } = await healthyHub(t);
  const received = [];
  hub.subscribe(workspaceId, conversationId, event => received.push(event.data.text ?? event.event));
  client.notify('not json');
  client.notify(text({ text: 'extra', unexpected: true }));
  client.notify({ kind: 'deleted', workspaceId, conversationId });
  client.notify(text({ workspaceId: 'not-a-uuid', text: 'bad id' }));
  client.emit('notification', { channel: 'other_channel', payload: JSON.stringify(text({ text: 'elsewhere' })) });
  client.notify(text({ text: 'valid' }));
  assert.deepEqual(received, ['valid']);
});

test('a lost connection sends resync, clears buffered text, and reconnects', async t => {
  const { hub, database, client } = await healthyHub(t);
  const received = [];
  hub.subscribe(workspaceId, conversationId, event => received.push(event.event));
  client.notify(text({ text: 'Hel' }));
  client.emit('error', new Error('connection reset'));
  assert.equal(hub.healthy(), false);
  await until(() => received.length === 2, 'loss sends resync');
  assert.deepEqual(hub.snapshot(workspaceId, conversationId), []);
  await until(() => hub.healthy(), 'hub reconnects');
  assert.equal(client.released, true);
  assert.equal(database.clients.length, 2);
  assert.deepEqual(received, ['text', 'resync', 'resync']);
});

test('idle reply text expires and the buffer count stays bounded', async t => {
  const { hub, client } = await healthyHub(t, { idleMs: 30, maxBuffers: 2 });
  const turns = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of turns) client.notify(text({ turnId: id, text: id.slice(0, 4) }));
  assert.deepEqual(
    hub.snapshot(workspaceId, conversationId).map(update => update.data.turnId),
    turns.slice(1),
  );
  await until(() => hub.snapshot(workspaceId, conversationId).length === 0, 'idle reply text expires');
});

test('closing the hub releases its integration and stops reconnecting', async t => {
  const { hub, database, client } = await healthyHub(t);
  hub.close();
  assert.equal(hub.healthy(), false);
  assert.equal(client.released, true);
  await delay(40);
  assert.equal(database.clients.length, 1);
});
