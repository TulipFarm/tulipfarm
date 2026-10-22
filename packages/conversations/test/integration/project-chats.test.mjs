import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createProjects } from '../../src/projects.ts';
import { conversationFixture } from '../fixture.mjs';

const send = (store, w, user, chatId, text) =>
  store.send(w.id, user, chatId, { commandId: randomUUID(), messageId: randomUUID(), parts: [{ kind: 'text', text }] });

test(
  'project chats share access with members, snapshot context, protect the audience and move with confirmation',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const { workspace: w, store } = f;
      const projects = createProjects(f.runtime);
      const reader = { id: randomUUID(), user: randomUUID() },
        outsider = { id: randomUUID(), user: randomUUID() };
      for (const person of [reader, outsider])
        await f.db.platform.query(
          `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`,
          [person.id, person.user],
        );
      const projectId = randomUUID();
      await projects.create(w.id, w.userId, { id: projectId, name: 'Launch' });
      await projects.edit(w.id, w.userId, projectId, {
        expectedRevision: 0,
        name: 'Launch',
        instructions: 'Answer as the launch team.',
        archived: false,
      });
      await projects.member(w.id, w.userId, projectId, { membershipId: reader.id, role: 'member', removed: false });
      await projects.saveKnowledge(w.id, w.userId, projectId, randomUUID(), {
        revisionId: randomUUID(),
        expectedRevision: null,
        title: 'Brief',
        content: 'Launch date is 12 November.',
      });

      const chatId = randomUUID();
      await store.create(w.id, reader.user, { chatId, commandId: randomUUID(), projectId });
      await assert.rejects(
        store.create(w.id, outsider.user, { chatId: randomUUID(), commandId: randomUUID(), projectId }),
        /Resource not found/,
      );
      assert.deepEqual(
        (await store.list(w.id, w.userId, { projectId })).chats.map(chat => [chat.id, chat.projectId]),
        [[chatId, projectId]],
      );
      assert.deepEqual((await store.list(w.id, reader.user)).chats, []);
      await assert.rejects(store.read(w.id, outsider.user, chatId), /Resource not found/);
      await assert.rejects(store.list(w.id, outsider.user, { projectId }), /Resource not found/);

      const seen = [];
      const replies = [
        { text: 'Launch is 12 November.', sources: [] },
        { text: 'Secret answer', sources: [{ kind: 'unknown' }] },
      ];
      const executor = createConversationExecutor(f.runtime, async input => {
        seen.push(input.project);
        return replies.shift();
      });
      const first = await send(store, w, w.userId, chatId, 'When is the launch date?');
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: first.turnId, generation: 0 }),
        'completed',
      );
      assert.equal(seen[0].instructions, 'Answer as the launch team.');
      assert.deepEqual(
        seen[0].files.map(file => [file.title, file.content]),
        [['Brief', 'Launch date is 12 November.']],
      );
      const second = await send(store, w, reader.user, chatId, 'Tell me the secret');
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: second.turnId, generation: 0 }),
        'completed',
      );
      assert.deepEqual(
        (await store.history(w.id, reader.user, chatId)).messages
          .filter(message => message.author === 'assistant')
          .map(message => message.parts[0].text),
        [
          'Launch is 12 November.',
          'This answer uses information that some project members cannot see, so it was not shared here. Ask again in a private chat.',
        ],
      );

      const standalone = randomUUID();
      await store.create(w.id, w.userId, { chatId: standalone, commandId: randomUUID() });
      const old = await send(store, w, w.userId, standalone, 'Private note');
      assert.equal(
        await createConversationExecutor(f.runtime, async () => 'Private answer').process({
          workspaceId: w.id,
          conversationId: standalone,
          turnId: old.turnId,
          generation: 0,
        }),
        'completed',
      );
      await assert.rejects(
        store.move(w.id, w.userId, standalone, { commandId: randomUUID(), projectId }),
        /invalid|literal|Invalid/i,
      );
      await assert.rejects(
        store.move(w.id, reader.user, standalone, {
          commandId: randomUUID(),
          projectId,
          confirmFullHistoryIncludingAdmins: true,
        }),
        /Resource not found/,
      );
      const move = { commandId: randomUUID(), projectId, confirmFullHistoryIncludingAdmins: true };
      assert.deepEqual(await store.move(w.id, w.userId, standalone, move), { projectId });
      assert.deepEqual(await store.move(w.id, w.userId, standalone, move), { projectId });
      await assert.rejects(store.move(w.id, w.userId, standalone, { ...move, commandId: randomUUID() }), {
        code: 'move-conflict',
      });
      assert.deepEqual(
        (await store.history(w.id, reader.user, standalone)).messages.map(message => message.parts[0].text),
        ['Private note', 'This reply is hidden because it uses information you cannot access.'],
      );
      await assert.rejects(
        store.rename(w.id, reader.user, standalone, { commandId: randomUUID(), title: 'Mine', expectedRevision: 0 }),
        /Resource not found/,
      );

      const project = (await projects.read(w.id, w.userId, projectId)).project;
      await projects.edit(w.id, w.userId, projectId, {
        expectedRevision: project.revision,
        name: 'Launch',
        instructions: project.instructions,
        archived: true,
      });
      await assert.rejects(send(store, w, reader.user, chatId, 'Still there?'), { code: 'project-archived' });
      assert.equal((await store.history(w.id, reader.user, chatId)).messages.length, 4);
      await projects.member(w.id, w.userId, projectId, { membershipId: reader.id, role: 'member', removed: true });
      await assert.rejects(store.history(w.id, reader.user, chatId), /Resource not found/);
    } finally {
      await f.close();
    }
  },
);
