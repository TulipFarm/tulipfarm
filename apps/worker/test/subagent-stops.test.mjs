import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { conversationEventChannel } from '@tulipfarm/conversations/events';
import { createSubagentStops } from '../src/subagent-stops.ts';

const target = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  turnId: '00000000-0000-4000-8000-000000000003',
  id: '00000000-0000-4000-8000-000000000004',
};

function fakeClient() {
  const client = new EventEmitter();
  client.queries = [];
  client.ended = false;
  client.connect = async () => {};
  client.query = async sql => client.queries.push(sql);
  client.end = async () => {
    client.ended = true;
  };
  return client;
}
const notify = (client, payload) =>
  client.emit('notification', { channel: conversationEventChannel, payload: JSON.stringify(payload) });

test('a Stop notification reaches only the listener of its call, and the connection closes when none remain', async () => {
  const clients = [];
  const stops = createSubagentStops({ WORKSPACE_AUTHORING_DATABASE_URL: 'postgresql://worker@db/tulipfarm' }, () => {
    const client = fakeClient();
    clients.push(client);
    return client;
  });
  const stopped = [];
  const other = [];
  const unsubscribe = stops(target, key => stopped.push(key));
  const unsubscribeOther = stops({ ...target, id: '00000000-0000-4000-8000-000000000005' }, key => other.push(key));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].queries, [`LISTEN ${conversationEventChannel}`]);

  notify(clients[0], { kind: 'subagent-stop', ...target, key: 'a2' });
  notify(clients[0], { kind: 'subagent-stop', ...target, key: 'not-a-key' });
  notify(clients[0], { kind: 'changed', workspaceId: target.workspaceId, conversationId: target.conversationId });
  clients[0].emit('notification', { channel: conversationEventChannel, payload: '{' });
  assert.deepEqual(stopped, ['a2']);
  assert.deepEqual(other, []);

  unsubscribe();
  assert.equal(clients[0].ended, false);
  unsubscribeOther();
  assert.equal(clients[0].ended, true);
});

test('without a database URL, per-card Stop is unavailable but registration still works', () => {
  let connected = false;
  const stops = createSubagentStops({}, () => {
    connected = true;
    return fakeClient();
  });
  const unsubscribe = stops(target, () => assert.fail('No stop can arrive'));
  unsubscribe();
  assert.equal(connected, false);
});
