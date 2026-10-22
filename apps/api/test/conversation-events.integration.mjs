import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createConversationEventHub } from '../src/conversation-events.ts';

const url = process.env.TEST_ADMIN_DATABASE_URL;
assert.ok(url, 'TEST_ADMIN_DATABASE_URL is required');

async function until(check, message) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

test('a hub on a real pool receives notifications sent from another connection and recovers from a terminated listener', async t => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const sender = new pg.Client({ connectionString: url });
  await sender.connect();
  const hub = createConversationEventHub({ connect: () => pool.connect(), backoffMs: { initial: 50, maximum: 200 } });
  t.after(async () => {
    hub.close();
    await sender.end();
    await pool.end();
  });
  await until(() => hub.healthy(), 'hub passes its probe');

  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const received = [];
  hub.subscribe(workspaceId, conversationId, event => received.push(event));
  const notify = payload =>
    sender.query('SELECT pg_notify($1, $2)', ['tf_conversation_events', JSON.stringify(payload)]);
  await notify({
    kind: 'text',
    workspaceId,
    conversationId,
    turnId,
    generation: 1,
    epoch: 0,
    step: 0,
    seq: 0,
    offset: 0,
    text: 'Hello',
    reset: true,
  });
  await notify({ kind: 'changed', workspaceId: randomUUID(), conversationId, turnId });
  await notify({ kind: 'changed', workspaceId, conversationId, turnId, settled: true });
  await until(() => received.length === 2, 'notifications arrive');
  assert.deepEqual(received, [
    {
      event: 'text',
      data: { turnId, generation: 1, epoch: 0, step: 0, seq: 0, offset: 0, text: 'Hello', reset: true },
    },
    { event: 'changed', data: { turnId, settled: true } },
  ]);

  received.length = 0;
  const listeners = await sender.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query = 'SELECT pg_notify($1, $2)' AND backend_type = 'client backend'",
  );
  assert.equal(listeners.rowCount, 1);
  await until(() => received.length === 2 && hub.healthy(), 'hub resyncs and reconnects');
  assert.deepEqual(
    received.map(event => event.event),
    ['resync', 'resync'],
  );
  await notify({
    kind: 'text',
    workspaceId,
    conversationId,
    turnId,
    generation: 2,
    epoch: 0,
    step: 0,
    seq: 0,
    offset: 0,
    text: 'Again',
    reset: true,
  });
  await until(() => received.length === 3, 'notifications arrive after reconnecting');
  assert.deepEqual(
    hub.snapshot(workspaceId, conversationId).map(update => update.data.text),
    ['Again'],
  );
});
