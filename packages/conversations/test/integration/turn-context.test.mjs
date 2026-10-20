import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createConversationExecutor } from '../../src/runtime.ts';
import { createInternalConversations } from '../../src/internal.ts';
import { turnRequester } from '../../src/turn-requester.ts';
import { conversationFixture } from '../fixture.mjs';
import { internalFixture } from '../internal-fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

async function chatFixture(f) {
  const w = f.workspace,
    conversationId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId: conversationId, commandId: randomUUID() });
  return {
    conversationId,
    send: text =>
      f.store.send(w.id, w.userId, conversationId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
      }),
    work: turn => ({ workspaceId: w.id, conversationId, turnId: turn.turnId, generation: 0 }),
  };
}

test('queued B receives completed A before its own source, never later C or another chat', async () => {
  const f = await conversationFixture();
  try {
    const chat = await chatFixture(f),
      other = await chatFixture(f);
    await other.send('Other private chat');
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async ({ messages }) => {
      calls.push(messages);
      return `${messages.at(-1).text} answer`;
    });
    const a = await chat.send('A');
    const fence = await executor.claim(chat.work(a));
    const b = await chat.send('B'),
      c = await chat.send('C');
    assert.equal(await executor.claim(chat.work(b)), null);
    assert.equal(await executor.complete({ ...fence, turnId: b.turnId }), 'stale');
    assert.equal(await executor.process({ ...chat.work(a), conversationId: other.conversationId }), 'idle');
    assert.equal(await executor.complete(fence), 'completed');
    assert.equal(await executor.process(chat.work(b)), 'completed');
    assert.deepEqual(calls, [
      [{ role: 'user', text: 'A' }],
      [
        { role: 'user', text: 'A' },
        { role: 'assistant', text: 'A answer' },
        { role: 'user', text: 'B' },
      ],
    ]);
    const history = await f.store.history(f.workspace.id, f.workspace.userId, chat.conversationId);
    assert.deepEqual(
      history.messages.map(message => message.parts[0].text),
      ['A', 'B', 'C', 'A answer', 'B answer'],
    );
    assert.deepEqual(
      (await executor.due(f.workspace.id)).filter(work => work.conversationId === chat.conversationId),
      [chat.work(c)],
    );
  } finally {
    await f.close();
  }
});

for (const corruption of ['different-member', 'assistant-source', 'removed-member'])
  test(`exact source integrity rejects ${corruption} without answering an older request`, async () => {
    const f = await conversationFixture();
    try {
      const chat = await chatFixture(f),
        w = f.workspace;
      let calls = 0;
      const executor = createConversationExecutor(f.runtime, async ({ executeTool, messages }) => {
        calls++;
        const actor = await executeTool('skills.list', false, async context => context.actor);
        assert.deepEqual(actor, { kind: 'human', userId: w.userId, membershipId: w.membershipId });
        return `${messages.at(-1).text} answer`;
      });
      const a = await chat.send('Older request');
      assert.equal(await executor.process(chat.work(a)), 'completed');
      const b = await chat.send('Current request');
      const fence = await executor.claim(chat.work(b));
      const member = randomUUID(),
        user = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role,removed_at) VALUES ($1,$2,'admin',$3)`,
        [member, user, corruption === 'removed-member' ? new Date() : null],
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversation_messages')} SET membership_id=$2, author_kind=$3 WHERE id=$1`,
        [
          b.messageId,
          corruption === 'assistant-source' ? null : member,
          corruption === 'assistant-source' ? 'assistant' : 'human',
        ],
      );
      if (corruption === 'different-member') {
        assert.deepEqual(
          await f.runtime.transaction(w.id, commonCompatibility, tx =>
            turnRequester(tx, chat.conversationId, b.turnId),
          ),
          { kind: 'human', userId: user, membershipId: member },
        );
      }
      assert.equal(await executor.complete(fence), 'stale');
      assert.equal(calls, 1);
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT status,error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            b.turnId,
          ])
        ).rows,
        [{ status: 'blocked', error_code: 'requester-unavailable' }],
      );
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT owner_user_id,owner_membership_id FROM ${f.table('tf_conversations')} WHERE id=$1`,
            [chat.conversationId],
          )
        ).rows,
        [{ owner_user_id: w.userId, owner_membership_id: w.membershipId }],
      );
      await assert.rejects(f.store.history(w.id, user, chat.conversationId), AccessDenied);
      await assert.rejects(
        f.store.send(w.id, user, chat.conversationId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: 'Not shared' }],
        }),
        AccessDenied,
      );
      assert.equal((await f.store.history(w.id, w.userId, chat.conversationId)).messages.length, 3);
    } finally {
      await f.close();
    }
  });

test('bounded causal history keeps the exact current request last and attachment-only input never answers prior text', async () => {
  const f = await conversationFixture();
  try {
    const chat = await chatFixture(f),
      w = f.workspace;
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async ({ messages }) => {
      calls.push(messages);
      return `${messages.at(-1).text} answer`;
    });
    for (let i = 1; i <= 21; i++)
      assert.equal(await executor.process(chat.work(await chat.send(`Request ${i}`))), 'completed');
    const next = await chat.send('Current');
    await chat.send('Later');
    assert.equal(await executor.process(chat.work(next)), 'completed');
    assert.deepEqual(calls.at(-1), [
      { role: 'assistant', text: 'Request 2 answer' },
      ...Array.from({ length: 19 }, (_, i) => [
        { role: 'user', text: `Request ${i + 3}` },
        { role: 'assistant', text: `Request ${i + 3} answer` },
      ]).flat(),
      { role: 'user', text: 'Current' },
    ]);
    const attachments = await chatFixture(f);
    assert.equal(await executor.process(attachments.work(await attachments.send('Prior text'))), 'completed');
    const attachmentId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_attachments')}
      (id,conversation_id,membership_id,filename,media_type,size,sha256,state,object_key)
      VALUES ($1,$2,$3,'note.txt','text/plain',1,$4,'ready',$5)`,
      [attachmentId, attachments.conversationId, w.membershipId, 'a'.repeat(64), randomUUID()],
    );
    const sent = await f.store.send(w.id, w.userId, attachments.conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'attachment', attachmentId }],
    });
    const callsBefore = calls.length;
    assert.equal(await executor.process(attachments.work(sent)), 'completed');
    assert.equal(calls.length, callsBefore);
    assert.equal(
      (await f.store.history(w.id, w.userId, attachments.conversationId)).messages.at(-1).parts[0].text,
      'Attachment received.',
    );
  } finally {
    await f.close();
  }
});

test('prior linked tool publication stays with A ahead of queued B and C', async () => {
  const f = await internalFixture();
  try {
    const service = createInternalConversations(f.runtime);
    const { callId, ...input } = await f.run();
    const fence = await service.claim(input);
    const w = f.workspace,
      conversationId = input.origin.conversationId;
    const send = text =>
      f.store.send(w.id, w.userId, conversationId, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text }],
      });
    const b = await send('B');
    await send('C');
    await service.publishTool(fence, { producerId: randomUUID(), callId });
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async ({ messages }) => {
      calls.push(messages);
      return 'Answer';
    });
    assert.equal(
      await executor.complete({
        workspaceId: w.id,
        conversationId,
        turnId: input.origin.turnId,
        generation: 0,
        epoch: input.origin.epoch,
      }),
      'completed',
    );
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId, turnId: b.turnId, generation: 0 }),
      'completed',
    );
    assert.deepEqual(calls, [
      [{ role: 'user', text: 'Inspect this privately' }],
      [
        { role: 'user', text: 'Inspect this privately' },
        { role: 'assistant', text: 'Tool queued.' },
        { role: 'assistant', text: 'Answer' },
        { role: 'user', text: 'B' },
      ],
    ]);
  } finally {
    await f.close();
  }
});

test('linked run must match the exact source requester even when private ownership and fence match', async () => {
  const f = await internalFixture();
  try {
    const service = createInternalConversations(f.runtime);
    const { callId: _callId, ...input } = await f.run();
    const member = randomUUID(),
      user = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      member,
      user,
    ]);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_messages')} SET membership_id=$2 WHERE id=(SELECT source_message_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1)`,
      [input.origin.turnId, member],
    );
    await assert.rejects(service.claim(input), AccessDenied);
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS count FROM ${f.table('tf_internal_conversations')} WHERE id=$1`,
          [input.runId],
        )
      ).rows[0].count,
      0,
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_messages')} SET membership_id=$2 WHERE id=(SELECT source_message_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1)`,
      [input.origin.turnId, f.workspace.membershipId],
    );
    const fence = await service.claim(input);
    await service.append(fence, { producerId: randomUUID(), parts: [{ kind: 'text', text: 'Correct requester' }] });
    assert.deepEqual(
      (await service.history(fence)).map(message => message.parts),
      [[{ kind: 'text', text: 'Correct requester' }]],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_messages')} SET membership_id=$2 WHERE id=(SELECT source_message_id FROM ${f.table('tf_conversation_turns')} WHERE id=$1)`,
      [input.origin.turnId, member],
    );
    await assert.rejects(service.renew(fence), AccessDenied);
    await assert.rejects(service.history(fence), AccessDenied);
  } finally {
    await f.close();
  }
});

for (const boundary of ['claim', 'tool', 'publication'])
  test(`retired requester cannot regain ${boundary} authority through a replacement membership`, async () => {
    const f = await conversationFixture();
    try {
      const chat = await chatFixture(f),
        w = f.workspace;
      const sent = await chat.send('Private request');
      const retire = async () => {
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
          w.membershipId,
        ]);
        await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
          randomUUID(),
          w.userId,
        ]);
      };
      let calls = 0,
        toolCalls = 0;
      const executor = createConversationExecutor(f.runtime, async ({ executeTool }) => {
        calls++;
        await retire();
        if (boundary === 'tool')
          await executeTool('skills.list', false, async () => {
            toolCalls++;
            return [];
          });
        return 'Must not publish';
      });
      if (boundary === 'claim') await retire();
      assert.equal(await executor.process(chat.work(sent)), boundary === 'claim' ? 'idle' : 'stale');
      assert.equal(calls, boundary === 'claim' ? 0 : 1);
      assert.equal(toolCalls, 0);
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT status,error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            sent.turnId,
          ])
        ).rows,
        [{ status: 'blocked', error_code: 'membership-removed' }],
      );
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT author_kind FROM ${f.table('tf_conversation_messages')} WHERE conversation_id=$1 ORDER BY sequence`,
            [chat.conversationId],
          )
        ).rows,
        [{ author_kind: 'human' }],
      );
      await assert.rejects(f.store.history(w.id, w.userId, chat.conversationId), AccessDenied);
    } finally {
      await f.close();
    }
  });

test('a later turn learns the current outcome of table proposals from earlier turns', async () => {
  const f = await conversationFixture();
  try {
    const chat = await chatFixture(f),
      w = f.workspace;
    const calls = [];
    const executor = createConversationExecutor(f.runtime, async ({ messages }) => {
      calls.push(messages);
      return `${messages.at(-1).text} answer`;
    });
    const a = await chat.send('Create a Tickets table');
    assert.equal(await executor.process(chat.work(a)), 'completed');
    const proposalId = randomUUID(),
      digest = 'a'.repeat(64),
      tableId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_proposals')} (id,conversation_id,turn_id,membership_id,user_id,input_digest,digest,manifest,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,clock_timestamp()+interval '1 hour')`,
      [
        proposalId,
        chat.conversationId,
        a.turnId,
        w.membershipId,
        w.userId,
        digest,
        { plans: [{ after: { label: 'Tickets' } }] },
      ],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_proposal_decisions')} (proposal_id,digest,membership_id,command_id,decision) VALUES ($1,$2,$3,$4,'approve')`,
      [proposalId, digest, w.membershipId, randomUUID()],
    );
    const b = await chat.send('Is it ready?');
    assert.equal(await executor.process(chat.work(b)), 'completed');
    assert.match(calls.at(-1).at(-1).text, /- Tickets: approved, still applying$/);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_proposal_receipts')} (proposal_id,table_id,attempt,receipt) VALUES ($1,$2,0,$3)`,
      [proposalId, tableId, { status: 'completed' }],
    );
    const c = await chat.send('And now?');
    assert.equal(await executor.process(chat.work(c)), 'completed');
    assert.match(calls.at(-1).at(-1).text, /- Tickets: applied and active$/);
  } finally {
    await f.close();
  }
});
