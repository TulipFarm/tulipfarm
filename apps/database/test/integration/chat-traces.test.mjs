import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { conversationFixture } from '../../../../packages/conversations/test/fixture.mjs';
import { markWorkspaceReady } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { chatIdFromInput } from '../../src/chat-traces.ts';

async function chatTraces(connectionString, ...args) {
  const child = spawn(process.execPath, ['src/cli.ts', 'chat-traces', '--env', 'local', ...args], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'test', WORKSPACE_PROVISIONING_DATABASE_URL: connectionString },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, report: code === 0 ? JSON.parse(stdout) : null, stderr };
}

test('chat ids come from a chat URL or a bare id', () => {
  const id = randomUUID();
  assert.equal(chatIdFromInput(id.toUpperCase()), id);
  assert.equal(chatIdFromInput(`https://app.tulipfarm.ai/acme/chat/${id}`), id);
  assert.equal(chatIdFromInput(`https://app.tulipfarm.ai/acme/chat/${id}?tab=1#end`), id);
  assert.throws(() => chatIdFromInput('https://app.tulipfarm.ai/acme/settings'), /chat/);
  assert.throws(() => chatIdFromInput('not a chat'), /chat URL or chat id/);
});

test('the provisioning login finds a chat URL’s turn traces; other logins are refused', { timeout: 60000 }, async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const other = await f.db.create();
  await markWorkspaceReady(f.db.platform, f.workspace.id);
  await markWorkspaceReady(f.db.platform, other.id);
  const chatId = randomUUID();
  await f.store.create(f.workspace.id, f.workspace.userId, { chatId, commandId: randomUUID() });
  const send = text =>
    f.store.send(f.workspace.id, f.workspace.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
    });
  const first = await send('first');
  const second = await send('second');
  const traceId = 'a'.repeat(32);
  await f.db.platform.query(
    `UPDATE ${f.table('tf_conversation_turns')} SET trace_id=$1, trace_sampled=true WHERE id=$2`,
    [traceId, first.turnId],
  );
  await assert.rejects(
    f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET trace_id=$1 WHERE id=$2`, [
      'b'.repeat(32),
      second.turnId,
    ]),
    /tf_conversation_turns_trace_check/,
    'trace_id and trace_sampled are set together',
  );

  const url = `https://app.tulipfarm.ai/acme/chat/${chatId}`;
  const found = await chatTraces(f.db.connectionString, '--chat', url);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.report.workspaceId, f.workspace.id);
  assert.equal(found.report.chatId, chatId);
  assert.deepEqual(
    found.report.turns.map(turn => [turn.turnId, turn.traceId, turn.traceSampled]),
    [
      [first.turnId, traceId, true],
      [second.turnId, null, null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(found.report), /first|second/, 'no message content is read');

  const scoped = await chatTraces(f.db.connectionString, '--chat', chatId, '--workspace', f.workspace.id);
  assert.deepEqual(scoped.report, found.report);

  const missing = await chatTraces(f.db.connectionString, '--chat', randomUUID());
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No ready workspace has this chat/);

  const otherRuntime = await chatTraces(f.db.login(other), '--chat', chatId, '--workspace', f.workspace.id);
  assert.equal(otherRuntime.code, 1);
  assert.match(otherRuntime.stderr, /Database operation failed \(42501\)/);

  const app = await chatTraces(f.db.login(other), '--chat', url);
  assert.equal(app.code, 1, 'another workspace login cannot list ready workspaces either');
  assert.match(app.stderr, /Database operation failed \(42501\)/);
});
