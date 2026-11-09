import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { StorageUnavailableError, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { requestBoundaryError } from '../src/security.ts';

// Sending a message checks the chat model against the shipped catalog, which needs a provider key.
process.env.ANTHROPIC_API_KEY ??= 'test-key';

// A release starts its code before workspace-rollout applies its common migrations, so these workspaces stand in for
// one that has not been migrated yet. Nothing here may fail with a missing table or column (42P01, 42703).
const migrationNumber = migration => Number(migration.name.slice(0, 4));

async function server(f) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (!requestBoundaryError(error, reply)) reply.code(500).send({ error: 'internal' });
  });
  app.get('/table/:name', async request =>
    f.runtime.transaction(f.workspace.id, commonCompatibility, ({ client, schema }) =>
      client.query(`SELECT count(*)::int AS rows FROM "${schema}"."${request.params.name}"`).then(r => r.rows[0]),
    ),
  );
  return app;
}

async function chat(f) {
  const w = f.workspace,
    chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'What changed this week?' }],
  });
  assert.equal((await f.store.history(w.id, w.userId, chatId)).messages.length, 1);
  assert.ok((await f.store.list(w.id, w.userId)).chats.some(item => item.id === chatId));
  assert.deepEqual((await f.store.pinned(w.id, w.userId)).chats, []);
}

test('chats work in a workspace one common migration behind the release', { timeout: 120000 }, async t => {
  const f = await conversationFixture(stream => stream.slice(0, -1));
  t.after(() => f.close());
  const version = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx => tx.commonVersion);
  assert.equal(version, commonCompatibility.maximum - 1);
  await chat(f);

  // A table the release's last migration adds is missing here until rollout reaches the workspace.
  await assert.rejects(
    f.runtime.transaction(f.workspace.id, commonCompatibility, ({ client, schema }) =>
      client.query(`SELECT 1 FROM "${schema}".tf_added_by_this_release`),
    ),
    error => error instanceof StorageUnavailableError && error.code === 'updating' && error.cause?.code === '42P01',
  );
  const app = await server(f);
  t.after(() => app.close());
  const response = await app.inject('/table/tf_added_by_this_release');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  assert.deepEqual(response.json(), { error: 'workspace-updating' });
});

test(
  'a workspace from before chat pins lists none and asks the client to retry its reads',
  { timeout: 120000 },
  async t => {
    const f = await conversationFixture(stream => stream.filter(migration => migrationNumber(migration) < 43));
    t.after(() => f.close());
    await chat(f);
    const app = await server(f);
    t.after(() => app.close());
    const response = await app.inject('/table/tf_conversation_pins');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'workspace-updating' });
  },
);

test('an up-to-date workspace reports a missing table as an error and logs it', { timeout: 120000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    if (String(chunk).includes('workspace.schema-missing')) lines.push(JSON.parse(String(chunk)));
    return write.call(process.stdout, chunk, ...rest);
  };
  t.after(() => {
    process.stdout.write = write;
  });
  await f.db.platform.query(`DROP TABLE ${f.table('tf_conversation_pins')}`);
  const app = await server(f);
  t.after(() => app.close());
  for (const name of ['tf_conversation_pins', `g_${randomUUID().replaceAll('-', '')}`, 'customer_orders']) {
    const response = await app.inject(`/table/${name}`);
    assert.equal(response.statusCode, 500, name);
  }
  assert.deepEqual(
    lines.map(line => [line.level, line.operation, line['error.type'], line.table, line['workspace.version']]),
    [
      ['error', 'workspace.schema-missing', '42P01', 'tf_conversation_pins', commonCompatibility.maximum],
      ['error', 'workspace.schema-missing', '42P01', 'custom', commonCompatibility.maximum],
      ['error', 'workspace.schema-missing', '42P01', 'other', commonCompatibility.maximum],
    ],
  );
});
