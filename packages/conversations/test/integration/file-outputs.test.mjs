import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import JSZip from 'jszip';
import { AccessDenied } from '@tulipfarm/access';
import { createFiles } from '../../../files/src/index.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createAttachments } from '../../src/attachments.ts';
import { createFileOutput, fileOutputId } from '../../src/file-outputs.ts';
import { conversationFixture } from '../fixture.mjs';

const report = '# Q3 summary\n\nRenewal is due 9 December.\n';
const call = { tool: 'files.create', name: 'Q3 summary', format: 'md', content: report };

async function setup({ quotaBytes } = {}) {
  const f = await conversationFixture();
  const objects = new Map();
  const bytes = {
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => {
      objects.delete(key);
    },
  };
  const files = createFiles(f.runtime, bytes, quotaBytes ? { quotaBytes } : {});
  const member = { id: randomUUID(), user: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.id,
    member.user,
  ]);
  const chat = async user => {
    const chatId = randomUUID();
    await f.store.create(f.workspace.id, user, { chatId, commandId: randomUUID() });
    return chatId;
  };
  const send = (user, chatId, parts, ids = { commandId: randomUUID(), messageId: randomUUID() }) =>
    f.store.send(f.workspace.id, user, chatId, { ...ids, parts });
  const rows = async () =>
    (
      await f.db.platform.query(
        `SELECT id, creator_membership_id, parent_id, name, media_type, size, ready FROM ${f.table('tf_files')} WHERE kind = 'file' ORDER BY name`,
      )
    ).rows;
  const receipts = async chatId =>
    (
      await f.db.platform.query(
        `SELECT c.tool, c.status, s.output FROM ${f.table('tf_conversation_tool_calls')} c LEFT JOIN ${f.table('tf_conversation_execution_steps')} s ON s.call_id = c.id WHERE c.conversation_id = $1 ORDER BY c.created_at`,
        [chatId],
      )
    ).rows;
  /** Runs one turn whose model asks for each call in order, the way the worker invokes files.create. */
  const reply = async (chatId, sent, calls, store = files, { autonomous = false, before } = {}) => {
    const executor = createConversationExecutor(
      f.runtime,
      async input => {
        for (const next of calls) {
          await before?.();
          await input.executeTool(
            'files.create',
            true,
            context =>
              createFileOutput(
                store,
                { workspaceId: context.workspaceId, actor: context.actor, autonomous, origin: context.origin },
                next,
              ).then(result => ({ result, sources: [] })),
            [],
            next,
          );
        }
        return { text: 'Saved.', sources: [] };
      },
      undefined,
      undefined,
      undefined,
      files,
    );
    return executor.process({
      workspaceId: f.workspace.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
  };
  return { ...f, objects, bytes, files, member, chat, send, rows, receipts, reply };
}

test(
  'a requested output is one personal file of the requester, replayed by its tool call, and shown as a card in history',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w, member } = f;
      const chatId = await f.chat(w.userId);
      const sent = await f.send(w.userId, chatId, [{ kind: 'text', text: 'Write the Q3 summary as a file' }]);
      assert.equal(await f.reply(chatId, sent, [call, call]), 'completed');
      const id = fileOutputId(sent.turnId, call);
      assert.deepEqual(await f.rows(), [
        {
          id,
          creator_membership_id: w.membershipId,
          parent_id: null,
          name: 'Q3 summary.md',
          media_type: 'text/markdown',
          size: Buffer.byteLength(report),
          ready: true,
        },
      ]);
      assert.equal(Buffer.from((await f.files.download(w.id, w.userId, id)).bytes).toString(), report);
      assert.deepEqual(
        (await f.receipts(chatId)).map(row => [row.tool, row.status, row.output.result.file.id]),
        [
          ['files.create', 'completed', id],
          ['files.create', 'completed', id],
        ],
      );
      assert.deepEqual((await f.files.usage(w.id, w.userId)).usedBytes, Buffer.byteLength(report));

      const library = await f.files.library(w.id, w.userId, { section: 'mine', location: { kind: 'root' }, query: '' });
      assert.deepEqual(
        library.items.map(item => item.name),
        ['Q3 summary.md'],
      );
      await assert.rejects(f.files.read(w.id, member.user, id), AccessDenied);

      const tools = (await f.store.history(w.id, w.userId, chatId)).messages.flatMap(message => message.tools);
      assert.deepEqual(
        tools.map(tool => tool.fileId),
        [id, id],
      );
      await f.files.rename(w.id, w.userId, id, 'Renamed.md');
      const replay = await createFileOutput(
        f.files,
        {
          workspaceId: w.id,
          actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
          autonomous: false,
          origin: { turnId: sent.turnId },
        },
        call,
      );
      assert.equal(replay.file.id, id, 'a retry after rename returns the stored file instead of creating another');
      assert.equal((await f.rows()).length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'an Office output is rendered from its spec, and an invalid spec creates nothing',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w } = f;
      const chatId = await f.chat(w.userId);
      const sent = await f.send(w.userId, chatId, [{ kind: 'text', text: 'Make the budget workbook' }]);
      const workbook = {
        tool: 'files.create',
        name: 'Budget',
        format: 'xlsx',
        content: JSON.stringify({
          sheets: [
            {
              name: 'Budget',
              columns: [{ header: 'Item' }, { header: 'Cost' }],
              rows: [
                ['Rent', 900],
                ['Total', { formula: '=SUM(B2)' }],
              ],
            },
          ],
        }),
      };
      const invalid = { tool: 'files.create', name: 'Notes', format: 'docx', content: JSON.stringify({ blocks: [] }) };
      assert.equal(await f.reply(chatId, sent, [workbook, invalid]), 'completed');
      assert.deepEqual(
        (await f.rows()).map(row => [row.name, row.media_type]),
        [['Budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
      );
      const bytes = (await f.files.download(w.id, w.userId, fileOutputId(sent.turnId, workbook))).bytes;
      assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), 'PK');
      const [, refused] = await f.receipts(chatId);
      assert.equal(refused.output.result.error, 'invalid-content');
      assert.match(refused.output.result.instruction, /document spec is invalid/);
    } finally {
      await f.close();
    }
  },
);

test(
  'an Office output places images the requester can read, records them as inputs, and refuses any it cannot use',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w, member } = f;
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      const upload = async (user, name, mediaType, body) => {
        const id = randomUUID();
        await f.files.upload(w.id, user, id, { name, parentId: null, mediaType }, body);
        return id;
      };
      const logo = await upload(w.userId, 'Logo.png', 'image/png', png);
      const hidden = await upload(member.user, 'Private.png', 'image/png', png);
      const notes = await upload(w.userId, 'Notes.txt', 'text/plain', Buffer.from('Not an image'));
      const doc = (name, fileId) => ({
        tool: 'files.create',
        name,
        format: 'docx',
        content: JSON.stringify({ blocks: [{ type: 'image', fileId, alt: 'Logo' }] }),
      });
      const chatId = await f.chat(w.userId);
      const sent = await f.send(w.userId, chatId, [{ kind: 'text', text: 'Put the logo in a document' }]);
      const placed = doc('Brief', logo);
      const deck = {
        tool: 'files.create',
        name: 'Deck',
        format: 'pptx',
        content: JSON.stringify({ slides: [{ layout: 'content', content: [{ type: 'image', fileId: logo }] }] }),
      };
      assert.equal(
        await f.reply(chatId, sent, [
          placed,
          deck,
          doc('Hidden', hidden),
          doc('Text', notes),
          doc('Missing', randomUUID()),
        ]),
        'completed',
      );
      const [brief, slides, ...refused] = await f.receipts(chatId);
      assert.deepEqual(
        [brief, slides].map(row => row.output.result.derivedFrom.map(source => [source.fileId, source.sha256])),
        [
          [[logo, createHash('sha256').update(png).digest('hex')]],
          [[logo, createHash('sha256').update(png).digest('hex')]],
        ],
      );
      assert.deepEqual(
        refused.map(row => [
          row.output.result.error,
          row.output.result.instruction.match(/can't be read|not a PNG/)?.[0],
        ]),
        [
          ['invalid-content', "can't be read"],
          ['invalid-content', 'not a PNG'],
          ['invalid-content', "can't be read"],
        ],
      );
      const bytes = (await f.files.download(w.id, w.userId, fileOutputId(sent.turnId, placed))).bytes;
      const media = Object.keys((await JSZip.loadAsync(bytes)).files).filter(name => name.startsWith('word/media/'));
      assert.equal(media.length, 1);
      assert.deepEqual(
        (await f.rows()).map(row => row.name).filter(name => !['Logo.png', 'Private.png', 'Notes.txt'].includes(name)),
        ['Brief.docx', 'Deck.pptx'],
      );
    } finally {
      await f.close();
    }
  },
);

test('an image revoked while its output is published blocks the output', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const { workspace: w, member } = f;
    const imageId = randomUUID();
    await f.files.upload(
      w.id,
      w.userId,
      imageId,
      { name: 'Chart.png', parentId: null, mediaType: 'image/png' },
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    await f.files.share(w.id, w.userId, imageId, { kind: 'individual', id: member.id }, 'viewer');
    const chatId = await f.chat(member.user);
    const sent = await f.send(member.user, chatId, [{ kind: 'text', text: 'Make a deck with the chart' }]);
    const revoking = createFiles(f.runtime, {
      ...f.bytes,
      putIfAbsent: async (key, body) => {
        await f.bytes.putIfAbsent(key, body);
        await f.files.share(w.id, w.userId, imageId, { kind: 'individual', id: member.id }, null);
      },
    });
    const deck = {
      tool: 'files.create',
      name: 'Deck',
      format: 'pptx',
      content: JSON.stringify({ slides: [{ layout: 'content', content: [{ type: 'image', fileId: imageId }] }] }),
    };
    assert.equal(await f.reply(chatId, sent, [deck], revoking), 'completed');
    assert.deepEqual(
      (await f.receipts(chatId)).map(row => row.status),
      ['blocked'],
      'the call is denied, and the turn goes on without the file',
    );
    assert.deepEqual(
      (await f.rows()).map(row => row.name),
      ['Chart.png'],
    );
  } finally {
    await f.close();
  }
});

test('a named folder is used only when the requester can add to it', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const { workspace: w, member } = f;
    const folderId = randomUUID();
    await f.files.createFolder(w.id, w.userId, folderId, { name: 'Reports', parentId: null });
    await f.files.share(w.id, w.userId, folderId, { kind: 'individual', id: member.id }, 'viewer');
    const chatId = await f.chat(member.user);
    const viewerOnly = await f.send(member.user, chatId, [{ kind: 'text', text: 'Save it in Reports' }]);
    assert.equal(await f.reply(chatId, viewerOnly, [{ ...call, folderId }]), 'completed');
    assert.deepEqual(
      (await f.receipts(chatId)).map(row => row.status),
      ['blocked'],
    );
    assert.deepEqual(await f.rows(), []);

    await f.files.share(w.id, w.userId, folderId, { kind: 'individual', id: member.id }, 'editor');
    const editor = await f.send(member.user, chatId, [{ kind: 'text', text: 'Try again' }]);
    assert.equal(await f.reply(chatId, editor, [{ ...call, folderId }]), 'completed');
    assert.deepEqual(
      (await f.rows()).map(row => [row.creator_membership_id, row.parent_id]),
      [[member.id, folderId]],
    );
  } finally {
    await f.close();
  }
});

test('autonomous work without an explicit destination is refused and creates nothing', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const { workspace: w } = f;
    const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const turnId = randomUUID();
    assert.equal(
      (await createFileOutput(f.files, { workspaceId: w.id, actor, autonomous: true, origin: { turnId } }, call)).error,
      'destination-required',
    );
    assert.deepEqual(await f.rows(), []);
    assert.equal(f.objects.size, 0, 'nothing reached storage');

    const folderId = randomUUID();
    await f.files.createFolder(w.id, w.userId, folderId, { name: 'Agent outputs', parentId: null });
    const placed = await createFileOutput(
      f.files,
      { workspaceId: w.id, actor, autonomous: true, origin: { turnId } },
      { ...call, folderId },
    );
    assert.equal(placed.file.parentId, folderId);
  } finally {
    await f.close();
  }
});

test('a storage failure or corrupt write leaves no ready file and no charge', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const { workspace: w } = f;
    const chatId = await f.chat(w.userId);
    const failing = createFiles(f.runtime, {
      ...f.bytes,
      putIfAbsent: async () => {
        throw new Error('storage unavailable');
      },
    });
    const unavailable = await f.send(w.userId, chatId, [{ kind: 'text', text: 'Save it' }]);
    assert.equal(await f.reply(chatId, unavailable, [call], failing), 'completed');
    const corrupt = createFiles(f.runtime, { ...f.bytes, read: async () => Buffer.from('tampered') });
    const tampered = await f.send(w.userId, chatId, [{ kind: 'text', text: 'Save it again' }]);
    assert.equal(await f.reply(chatId, tampered, [call], corrupt), 'completed');
    assert.deepEqual(
      (await f.receipts(chatId)).map(row => row.status),
      ['failed', 'failed'],
    );
    assert.deepEqual(await f.rows(), []);
    assert.equal(f.objects.size, 0, 'the unreferenced object was discarded');
    assert.equal((await f.files.usage(w.id, w.userId)).usedBytes, 0);
    const tools = (await f.store.history(w.id, w.userId, chatId)).messages.flatMap(message => message.tools);
    assert.deepEqual(
      tools.map(tool => [tool.status, tool.fileId]),
      [
        ['failed', undefined],
        ['failed', undefined],
      ],
    );
  } finally {
    await f.close();
  }
});

test('a referenced input revoked before or during publication blocks the output', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const { workspace: w, member } = f;
    const sourceId = randomUUID();
    await f.files.upload(
      w.id,
      w.userId,
      sourceId,
      { name: 'Plan.txt', parentId: null, mediaType: 'text/plain' },
      Buffer.from('Renewal is due 9 December.'),
    );
    await f.files.share(w.id, w.userId, sourceId, { kind: 'individual', id: member.id }, 'viewer');
    const revoke = () => f.files.share(w.id, w.userId, sourceId, { kind: 'individual', id: member.id }, null);
    const grant = () => f.files.share(w.id, w.userId, sourceId, { kind: 'individual', id: member.id }, 'viewer');
    const chatId = await f.chat(member.user);

    const granted = await f.send(member.user, chatId, [
      { kind: 'text', text: 'Summarize into a file' },
      { kind: 'file', fileId: sourceId },
    ]);
    assert.equal(await f.reply(chatId, granted, [call]), 'completed');
    const [created] = await f.receipts(chatId);
    assert.deepEqual(
      created.output.result.derivedFrom.map(source => [source.fileId, source.sha256]),
      [[sourceId, createHash('sha256').update('Renewal is due 9 December.').digest('hex')]],
    );

    const beforeChat = await f.chat(member.user);
    const before = await f.send(member.user, beforeChat, [
      { kind: 'text', text: 'Again' },
      { kind: 'file', fileId: sourceId },
    ]);
    assert.equal(
      await f.reply(beforeChat, before, [{ ...call, name: 'Before' }], f.files, { before: revoke }),
      'failed',
    );

    await grant();
    const duringChat = await f.chat(member.user);
    const during = await f.send(member.user, duringChat, [
      { kind: 'text', text: 'Once more' },
      { kind: 'file', fileId: sourceId },
    ]);
    const revoking = createFiles(f.runtime, {
      ...f.bytes,
      putIfAbsent: async (key, body) => {
        await f.bytes.putIfAbsent(key, body);
        await revoke();
      },
    });
    assert.equal(await f.reply(duringChat, during, [{ ...call, name: 'During' }], revoking), 'failed');

    assert.deepEqual(
      (await f.receipts(beforeChat)).map(row => row.status),
      [],
      'admission stops the call before it starts',
    );
    assert.deepEqual(
      (await f.receipts(duringChat)).map(row => row.status),
      ['failed'],
      'the interrupted call is never completed',
    );
    assert.deepEqual(
      (await f.rows()).map(row => row.name),
      ['Plan.txt', 'Q3 summary.md'],
    );
  } finally {
    await f.close();
  }
});

test(
  'a sent upload is published once as a personal file, charged once, and a staged upload is not',
  { timeout: 60000 },
  async () => {
    const content = Buffer.from('a,b\n1,2\n');
    const f = await setup({ quotaBytes: content.byteLength * 2 + 1 });
    try {
      const { workspace: w } = f;
      const attachments = createAttachments(f.runtime, f.bytes, {
        files: f.files,
        quotaBytes: content.byteLength * 2 + 1,
      });
      const chatId = await f.chat(w.userId);
      const stage = async () => {
        const id = randomUUID();
        await attachments.reserve(w.id, w.userId, chatId, id, {
          filename: 'Ledger.csv',
          mediaType: 'text/csv',
          size: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
        await attachments.upload(w.id, w.userId, chatId, id, content);
        return id;
      };
      const sentId = await stage();
      const ids = { commandId: randomUUID(), messageId: randomUUID() };
      await f.send(
        w.userId,
        chatId,
        [
          { kind: 'text', text: 'Here' },
          { kind: 'attachment', attachmentId: sentId },
        ],
        ids,
      );
      const stagedId = await stage();
      assert.equal((await f.files.usage(w.id, w.userId)).usedBytes, content.byteLength * 2);

      assert.deepEqual(await attachments.publishSent(w.id, w.userId, chatId, ids.messageId), [sentId]);
      await f.send(
        w.userId,
        chatId,
        [
          { kind: 'text', text: 'Here' },
          { kind: 'attachment', attachmentId: sentId },
        ],
        ids,
      );
      assert.deepEqual(
        await attachments.publishSent(w.id, w.userId, chatId, ids.messageId),
        [sentId],
        'a replayed send converges on the same file',
      );

      assert.deepEqual(await f.rows(), [
        {
          id: sentId,
          creator_membership_id: w.membershipId,
          parent_id: null,
          name: 'Ledger.csv',
          media_type: 'text/csv',
          size: content.byteLength,
          ready: true,
        },
      ]);
      const attachmentKey = (
        await f.db.platform.query(`SELECT object_key FROM ${f.table('tf_conversation_attachments')} WHERE id = $1`, [
          sentId,
        ])
      ).rows[0].object_key;
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT object_key, object_owner FROM ${f.table('tf_files')} WHERE id = $1`, [
            sentId,
          ])
        ).rows,
        [{ object_key: attachmentKey, object_owner: 'attachment' }],
      );
      assert.deepEqual(
        [...f.objects.keys()].filter(key => key.includes('/files/')),
        [],
        'the published file borrows the attachment object instead of storing a copy',
      );
      assert.equal(
        (await f.files.usage(w.id, w.userId)).usedBytes,
        content.byteLength * 2,
        'the sent upload and its file share one charge; the staged upload keeps its own',
      );
      assert.equal(Buffer.from((await f.files.download(w.id, w.userId, sentId)).bytes).toString(), content.toString());
      assert.equal(
        Buffer.from((await attachments.download(w.id, w.userId, chatId, sentId)).bytes).toString(),
        content.toString(),
        'the chat attachment link still works',
      );
      assert.equal(stagedId === sentId, false);

      await f.files.trash(w.id, w.userId, sentId, true);
      await assert.rejects(
        attachments.publishSent(w.id, w.userId, chatId, ids.messageId),
        error => error.code === 'conflict',
        'republishing never reports or restores a trashed file',
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT trashed_at IS NOT NULL AS trashed FROM ${f.table('tf_files')} WHERE id = $1`,
            [sentId],
          )
        ).rows[0].trashed,
        true,
      );
      assert.equal((await f.files.deleteForever(w.id, w.userId, sentId)).state, 'deleted');
      assert.equal(
        (await f.files.usage(w.id, w.userId)).usedBytes,
        content.byteLength * 2,
        'deleting the file charges the attachment bytes again',
      );
      assert.equal(
        Buffer.from((await attachments.download(w.id, w.userId, chatId, sentId)).bytes).toString(),
        content.toString(),
        'deleting the file forever keeps the bytes the attachment still uses',
      );
      assert.equal(f.objects.has(`${w.id}/${attachmentKey}`), true);
    } finally {
      await f.close();
    }
  },
);

/** A sent attachment published into Files, plus helpers that expire the attachment as a future retention rule would. */
async function published(f) {
  const { workspace: w } = f;
  const content = Buffer.from('a,b\n1,2\n');
  const removed = [];
  const bytes = {
    ...f.bytes,
    remove: async key => {
      removed.push(key);
      await f.bytes.remove(key);
    },
  };
  const files = createFiles(f.runtime, bytes);
  const attachments = createAttachments(f.runtime, bytes, { files });
  const chatId = await f.chat(w.userId);
  const id = randomUUID(),
    messageId = randomUUID();
  await attachments.reserve(w.id, w.userId, chatId, id, {
    filename: 'Ledger.csv',
    mediaType: 'text/csv',
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  await attachments.upload(w.id, w.userId, chatId, id, content);
  await f.send(w.userId, chatId, [{ kind: 'attachment', attachmentId: id }], { commandId: randomUUID(), messageId });
  const results = await Promise.all([
    attachments.publishSent(w.id, w.userId, chatId, messageId),
    attachments.publishSent(w.id, w.userId, chatId, messageId),
  ]);
  assert.deepEqual(results, [[id], [id]], 'concurrent publications converge on one file');
  const key = `${w.id}/${(await f.db.platform.query(`SELECT object_key FROM ${f.table('tf_conversation_attachments')} WHERE id = $1`, [id])).rows[0].object_key}`;
  const expire = () =>
    f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_attachments')} SET state = 'ready', message_id = NULL, expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
  const state = async () =>
    (await f.db.platform.query(`SELECT state FROM ${f.table('tf_conversation_attachments')} WHERE id = $1`, [id]))
      .rows[0].state;
  const deleteFile = async () => {
    await files.trash(w.id, w.userId, id, true);
    return (await files.deleteForever(w.id, w.userId, id)).state;
  };
  return {
    w,
    id,
    key,
    content,
    removed,
    files,
    attachments,
    expire,
    state,
    deleteFile,
    usage: async () => (await files.usage(w.id, w.userId)).usedBytes,
  };
}

test(
  'attachment cleanup keeps bytes a published file still uses, and deleting the file then removes them',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const p = await published(f);
      assert.equal(await p.usage(), p.content.byteLength);
      await p.expire();
      assert.equal(await p.attachments.cleanup(p.w.id), 1);
      assert.equal(await p.state(), 'abandoned');
      assert.deepEqual(p.removed, [], 'cleanup leaves the object to the file');
      assert.equal(
        Buffer.from((await p.files.download(p.w.id, p.w.userId, p.id)).bytes).toString(),
        p.content.toString(),
      );
      assert.equal(await p.usage(), p.content.byteLength, 'the file alone carries the charge');
      assert.equal(await p.deleteFile(), 'deleted');
      assert.deepEqual(p.removed, [p.key]);
      assert.equal(f.objects.has(p.key), false);
      assert.equal(await p.usage(), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'deleting the file first leaves the bytes to the attachment, whose cleanup then removes them',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const p = await published(f);
      assert.equal(await p.deleteFile(), 'deleted');
      assert.deepEqual(p.removed, []);
      assert.equal(await p.usage(), p.content.byteLength, 'the attachment is charged again');
      await p.expire();
      assert.equal(await p.attachments.cleanup(p.w.id), 1);
      assert.deepEqual(p.removed, [p.key]);
      assert.equal(f.objects.has(p.key), false);
      assert.equal(await p.usage(), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'a deletion racing attachment cleanup under the storage lock still removes the object',
  { timeout: 60000 },
  async () => {
    for (const first of ['file', 'attachment']) {
      const f = await setup();
      try {
        const p = await published(f);
        await p.expire();
        await p.files.trash(p.w.id, p.w.userId, p.id, true);
        await f.db.platform.query('BEGIN');
        await f.db.platform.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [
          f.workspace.names.schema,
        ]);
        const runs =
          first === 'file'
            ? [p.files.deleteForever(p.w.id, p.w.userId, p.id), p.attachments.cleanup(p.w.id)]
            : [p.attachments.cleanup(p.w.id), p.files.deleteForever(p.w.id, p.w.userId, p.id)];
        for (const deadline = Date.now() + 5000; ;) {
          const { waiting } = (
            await f.db.databaseAdmin.query(
              `SELECT count(*)::integer AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND usename = $1 AND wait_event = 'advisory'`,
              [f.workspace.names.runtime],
            )
          ).rows[0];
          if (waiting === 2) break;
          assert.ok(Date.now() < deadline, 'both the purge and the cleanup wait on the storage lock');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await f.db.platform.query('COMMIT');
        await Promise.all(runs);
        assert.equal(await p.files.sweepDeletions(p.w.id).then(result => result.failed), 0);
        assert.equal(f.objects.has(p.key), false, `${first} first: the object is removed`);
        assert.equal(p.removed.includes(p.key), true);
        assert.deepEqual(
          (await f.db.platform.query(`SELECT id FROM ${f.table('tf_files')} WHERE id = $1`, [p.id])).rows,
          [],
        );
        assert.equal(await p.usage(), 0);
      } finally {
        await f.db.platform.query('ROLLBACK').catch(() => {});
        await f.close();
      }
    }
  },
);

test(
  'a file published before 0110 keeps its own copy: its deletion removes only that copy',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w } = f;
      const files = createFiles(f.runtime, f.bytes);
      const attachments = createAttachments(f.runtime, f.bytes, { files });
      const content = Buffer.from('legacy');
      const chatId = await f.chat(w.userId);
      const id = randomUUID(),
        messageId = randomUUID(),
        copy = randomUUID();
      await attachments.reserve(w.id, w.userId, chatId, id, {
        filename: 'Old.txt',
        mediaType: 'text/plain',
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      await attachments.upload(w.id, w.userId, chatId, id, content);
      await f.send(w.userId, chatId, [{ kind: 'attachment', attachmentId: id }], {
        commandId: randomUUID(),
        messageId,
      });
      f.objects.set(`${w.id}/files/${copy}`, Buffer.from(content));
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
      VALUES ($1,'file',$2,'Old.txt',$3,'text/plain',$4,$5,true)`,
        [id, w.membershipId, copy, content.byteLength, createHash('sha256').update(content).digest('hex')],
      );
      assert.deepEqual(
        await attachments.publishSent(w.id, w.userId, chatId, messageId),
        [id],
        'a replay accepts the earlier copy',
      );
      assert.equal(
        (await f.db.platform.query(`SELECT object_owner FROM ${f.table('tf_files')} WHERE id = $1`, [id])).rows[0]
          .object_owner,
        'files',
      );
      assert.equal((await files.usage(w.id, w.userId)).usedBytes, content.byteLength, 'the pair is still charged once');
      await files.trash(w.id, w.userId, id, true);
      assert.equal((await files.deleteForever(w.id, w.userId, id)).state, 'deleted');
      assert.equal(f.objects.has(`${w.id}/files/${copy}`), false);
      assert.equal(Buffer.from((await attachments.download(w.id, w.userId, chatId, id)).bytes).toString(), 'legacy');
    } finally {
      await f.close();
    }
  },
);
