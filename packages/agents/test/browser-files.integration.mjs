import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { withFileSources } from '../../conversations/src/file-references.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createChatTools, isExternalTool } from '../src/tools.ts';
import { createFiles } from '@tulipfarm/files';
import { saveBrowserDownload } from '../src/browser-tools.ts';

const page = {
  sessionId: 's',
  url: 'https://forms.example.com/',
  title: 'Upload',
  controller: 'agent',
  needsPerson: null,
};

test('the chat browser uploads only files the person may read and saves its downloads to Files', async t => {
  const db = await fixture();
  let base;
  t.after(async () => {
    await base?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  base = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const runtime = withFileSources(base);
  const table = name => qualified(w.names.schema, name);
  const objects = new Map();
  const files = createFiles(runtime, {
    putIfAbsent: async (key, body) => void objects.set(key, Buffer.from(body)),
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  });
  const mine = await files.upload(
    w.id,
    w.userId,
    randomUUID(),
    { name: 'Invoice.csv', parentId: null, mediaType: 'text/csv' },
    Buffer.from('total,12\n'),
  );
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'person-1','member')`, [
    randomUUID(),
  ]);
  const theirs = await files.upload(
    w.id,
    'person-1',
    randomUUID(),
    { name: 'Salary.csv', parentId: null, mediaType: 'text/csv' },
    Buffer.from('secret,1\n'),
  );

  const uploads = [];
  const download = { id: randomUUID(), name: 'statement.csv', size: 9 };
  const held = new Map();
  const client = {
    state: async () => page,
    open: async () => page,
    act: async () => (
      held.set(download.id, Buffer.from('paid,12\n\n')),
      { state: page, snapshot: '- link "Statement" [ref=e4]', truncated: false, downloads: [download] }
    ),
    upload: async (_id, input, bytes) => (
      uploads.push({ ...input, text: Buffer.from(bytes).toString() }),
      { state: page, snapshot: '- button "Choose file" [ref=e2]', truncated: false }
    ),
    download: async (_id, id) => {
      const bytes = held.get(id);
      held.delete(id);
      return { name: download.name, bytes };
    },
  };
  const chats = createConversations(runtime);
  const chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  async function tool(call) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Use the form.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (
        await executeTool(
          call.tool,
          isExternalTool(call.tool),
          context =>
            createChatTools(context.runtime, {
              browser: { client, imageInput: false },
              outputs: { files, autonomous: false },
              chatFiles: { files, turnFiles: { attachments: {} }, imageInput: false },
              telemetryRuntime: 'chat',
            }).invokeWithSources(context, call),
          [],
          call,
        )
      ).result;
      return { text: 'Done.', sources: [] };
    });
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return output;
  }

  const refused = await tool({ tool: 'browser.upload', file: theirs.id, ref: 'e2' });
  assert.equal(refused.error, 'file-not-found');
  assert.deepEqual(uploads, [], 'a file the person may not read never reaches the browser');

  const sent = await tool({ tool: 'browser.upload', file: mine.id, ref: 'e2' });
  assert.equal(sent.uploaded, 'Invoice.csv');
  assert.deepEqual(uploads, [{ ref: 'e2', name: 'Invoice.csv', mediaType: 'text/csv', text: 'total,12\n' }]);

  const clicked = await tool({ tool: 'browser.act', action: { action: 'click', ref: 'e4' } });
  assert.equal(clicked.files.length, 1);
  const [saved] = clicked.files;
  assert.deepEqual([saved.name, saved.size], ['statement.csv', 9]);
  const [row] = (
    await db.platform.query(`SELECT name, parent_id AS "parentId" FROM ${table('tf_files')} WHERE id=$1`, [saved.id])
  ).rows;
  assert.deepEqual(row, { name: 'statement.csv', parentId: null });
  assert.equal(Buffer.from((await files.download(w.id, w.userId, saved.id)).bytes).toString(), 'paid,12\n\n');

  const callId = randomUUID();
  const context = {
    workspaceId: w.id,
    actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    autonomous: false,
    callId,
    inputs: [],
  };
  const save = text => saveBrowserDownload(files, context, { name: 'retry.csv', bytes: Buffer.from(text) });
  const first = await save('a,1\n');
  const replayed = await save('a,1\n');
  assert.equal(replayed.file.id, first.file.id, 'a retried call reuses the file it saved');
  // Another same-named download of the call, with other bytes, is its own file.
  const other = await save('a,2\n');
  assert.notEqual(other.file.id, first.file.id, 'the other download is saved, not swapped for the first');
  assert.equal((await save('a,2\n')).file.id, other.file.id, 'and a further retry reuses it');
  const copies = await db.platform.query(`SELECT id FROM ${table('tf_files')} WHERE name='retry.csv'`);
  assert.equal(copies.rows.length, 2);
  assert.equal(Buffer.from((await files.download(w.id, w.userId, other.file.id)).bytes).toString(), 'a,2\n');
  await files.trash(w.id, w.userId, first.file.id, true);
  assert.equal((await save('a,1\n')).error, 'conflict', 'a retry never saves a file the person trashed again');
});
