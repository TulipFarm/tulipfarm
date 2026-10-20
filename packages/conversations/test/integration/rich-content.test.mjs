import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../fixture.mjs';
import { chatDocumentText } from '../../src/rich-content.ts';

test(
  'conversation send and history persist the validated rich document while the agent text remains projected once',
  { timeout: 60000 },
  async () => {
    const fixture = await conversationFixture();
    try {
      const { workspace, store, db, table } = fixture;
      const chatId = randomUUID();
      await store.create(workspace.id, workspace.userId, { chatId, commandId: randomUUID() });
      const content = {
        version: 1,
        doc: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: 'Launch plan', marks: [{ type: 'bold' }] }],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Ship ' },
                { type: 'text', text: 'carefully', marks: [{ type: 'italic' }] },
              ],
            },
          ],
        },
      };
      const text = chatDocumentText(content);
      const messageId = randomUUID();
      await store.send(workspace.id, workspace.userId, chatId, {
        commandId: randomUUID(),
        messageId,
        parts: [{ kind: 'text', text, content }],
      });
      const history = await store.history(workspace.id, workspace.userId, chatId);
      assert.deepEqual(history.messages[0].parts, [{ kind: 'text', text, content }]);
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT text, rich_content AS content FROM ${table('tf_conversation_parts')} WHERE message_id=$1`,
            [messageId],
          )
        ).rows,
        [{ text, content }],
      );
    } finally {
      await fixture.close();
    }
  },
);
