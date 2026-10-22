import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

test(
  'the runtime and migrated database allow call 1000 across resume and reject call 1001',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace,
        chatId = randomUUID();
      await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, chatId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Continue reading pages' }],
      });
      await f.db.platform.query(
        `WITH inserted AS (
      INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status)
      SELECT gen_random_uuid(),$1,$2,n,'skills.list','completed' FROM generate_series(1,999) n RETURNING id,turn_id
    ) INSERT INTO ${f.table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output)
      SELECT id,turn_id,'{"tool":"skills.list"}','[]','{"result":{"skills":[]},"sources":[]}' FROM inserted`,
        [chatId, sent.turnId],
      );
      let effects = 0;
      const executor = createConversationExecutor(
        f.runtime,
        async ({ executeTool, priorCalls, priorToolCalls }) => {
          assert.equal(priorCalls, 999);
          assert.equal(priorToolCalls.length, 999);
          assert.deepEqual(priorToolCalls[0], { tool: 'skills.list' });
          await executeTool(
            'skills.list',
            false,
            async () => {
              effects++;
              return { result: { skills: [] }, sources: [] };
            },
            [],
            { tool: 'skills.list' },
          );
          await assert.rejects(
            executeTool('skills.list', false, () => assert.fail('1001st tool executed')),
            /conversation-tool-unavailable/,
          );
          return 'Read all 1000 pages.';
        },
        undefined,
        undefined,
        () => assert.fail('No MCP action to resume'),
      );
      assert.equal(
        await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      assert.equal(effects, 1);
      const count = await f.db.platform.query(
        `SELECT count(*)::integer AS count,max(sequence) AS last FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`,
        [sent.turnId],
      );
      assert.deepEqual(count.rows, [{ count: 1000, last: 1000 }]);
      await assert.rejects(
        f.db.platform.query(
          `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status)
      VALUES ($1,$2,$3,1001,'skills.list','completed')`,
          [randomUUID(), chatId, sent.turnId],
        ),
        error => error.code === '23514',
      );
    } finally {
      await f.close();
    }
  },
);
