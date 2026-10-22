import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AccessDenied } from '@tulipfarm/access';
import { createAgentChat } from '../../../agents/src/chat.ts';
import { createInternalConversations } from '../../src/internal.ts';
import { createInternalAgentComposition } from '../../../../apps/worker/src/internal-agent-composition.ts';
import { internalFixture } from '../internal-fixture.mjs';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const claimInput = ({ callId: _callId, ...input }) => input;

test(
  'autonomous internal runtime retains tool authority, hides legacy results, and fences takeover and retries',
  { timeout: 60000 },
  async () => {
    const f = await internalFixture();
    let restarted;
    try {
      const { workspace: w, db, table } = f;
      let service = createInternalAgentComposition(f.runtime);
      const run = await f.run('autonomous');
      const old = await service.claim(claimInput(run));
      const text = { producerId: randomUUID(), parts: [{ kind: 'text', text: 'runtime-private-sentinel' }] };
      const [a, b] = await Promise.all([service.append(old, text), service.append(old, text)]);
      assert.deepEqual(a, b);
      await assert.rejects(
        service.append(old, { ...text, parts: [{ kind: 'text', text: 'changed' }] }),
        error => error.code === 'command-conflict',
      );
      assert.equal(await service.execute(old, run.callId), 'completed');
      assert.equal(await service.execute(old, run.callId), 'completed');
      const history = await service.history(old);
      assert.deepEqual(
        history.map(message => ({ sequence: message.sequence, parts: message.parts })),
        [
          { sequence: 1, parts: text.parts },
          { sequence: 2, parts: [{ kind: 'tool', callId: run.callId }] },
        ],
      );
      assert.equal(
        (
          await db.platform.query(`SELECT result->>'name' AS name FROM ${table('tf_agent_tool_calls')} WHERE id=$1`, [
            run.callId,
          ])
        ).rows[0].name,
        'raw-secret-resource',
      );
      await assert.rejects(
        f.executor.readResult({ workspaceId: w.id, runId: run.runId, callId: run.callId }, f.actor),
        AccessDenied,
      );
      await assert.rejects(
        f.executor.execute({ workspaceId: w.id, runId: run.runId, callId: run.callId }),
        AccessDenied,
      );
      await assert.rejects(
        f.executor.queueCall(w.id, f.actor, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 1,
          call: { tool: 'schema.inspect', tableId: f.tableId },
        }),
        AccessDenied,
      );
      await assert.rejects(service.publishTool(old, { producerId: randomUUID(), callId: run.callId }), AccessDenied);
      await assert.rejects(f.store.history(w.id, w.userId, run.runId), AccessDenied);
      assert.deepEqual((await f.store.list(w.id, w.userId)).chats, []);
      const other = await f.run('autonomous');
      await assert.rejects(
        service.append(old, { producerId: randomUUID(), parts: [{ kind: 'tool', callId: other.callId }] }),
        AccessDenied,
      );
      assert.equal((await service.history(old)).length, 2);
      assert.equal(await service.claim({ ...claimInput(run), ownerId: randomUUID() }), null);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_runtime_claims')} SET lease_until=clock_timestamp()-interval '1 second' WHERE conversation_id=$1`,
        [run.runId],
      );
      restarted = f.createRuntime();
      service = createInternalAgentComposition(restarted);
      const current = await service.claim({ ...claimInput(run), ownerId: randomUUID() });
      assert.equal(current.epoch, old.epoch + 1);
      for (const producerId of [text.producerId, randomUUID()])
        await assert.rejects(service.append(old, { ...text, producerId }), AccessDenied);
      await assert.rejects(service.renew(old), AccessDenied);
      assert.deepEqual(await service.append(current, text), a);
      assert.equal((await service.history(current)).length, 2);
      await f.executor.revoke(w.id, f.actor, { kind: 'activation', id: f.activationId });
      await assert.rejects(service.history(current), AccessDenied);
      await assert.rejects(service.append(current, { ...text, producerId: randomUUID() }), AccessDenied);
    } finally {
      await restarted?.close();
      await f.close();
    }
  },
);

test(
  'linked runtime publishes only fixed tool status and enforces private incarnation and originating epoch',
  { timeout: 60000 },
  async () => {
    const f = await internalFixture();
    try {
      const { workspace: w, table, db } = f;
      const service = createInternalAgentComposition(f.runtime);
      const run = await f.run();
      const fence = await service.claim(claimInput(run));
      await service.append(fence, {
        producerId: randomUUID(),
        parts: [{ kind: 'text', text: 'hidden-linked-content' }],
      });
      assert.equal(await service.execute(fence, run.callId), 'completed');
      const publication = { producerId: randomUUID(), callId: run.callId };
      assert.deepEqual(await service.publishTool(fence, publication), await service.publishTool(fence, publication));
      assert.deepEqual(
        (await f.store.history(w.id, w.userId, run.origin.conversationId)).messages.map(
          message => message.parts[0].text,
        ),
        ['Inspect this privately', 'Tool completed.'],
      );
      const chat = createAgentChat(f.runtime, null);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_chat_turns')} (id,prompt,status,decision) VALUES ($1,'hidden-legacy-prompt','answered',$2)`,
        [run.runId, { kind: 'answer', text: 'hidden-legacy-answer' }],
      );
      await assert.rejects(chat.read(w.id, w.userId, f.agentId, run.runId), AccessDenied);
      const legacy = await f.run();
      const otherUser = randomUUID(),
        otherMember = randomUUID(),
        otherChat = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        otherMember,
        otherUser,
      ]);
      await f.store.create(w.id, otherUser, { chatId: otherChat, commandId: randomUUID() });
      await assert.rejects(
        service.claim({ ...claimInput(legacy), origin: { ...legacy.origin, conversationId: otherChat } }),
        AccessDenied,
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_chat_turns')} (id,prompt,status,decision) VALUES ($1,'legacy-prompt','answered',$2)`,
        [legacy.runId, { kind: 'answer', text: 'Legacy remains readable.' }],
      );
      assert.equal((await chat.read(w.id, w.userId, f.agentId, legacy.runId)).text, 'Legacy remains readable.');
      assert.equal(
        await f.executor.execute({ workspaceId: w.id, runId: legacy.runId, callId: legacy.callId }),
        'completed',
      );
      assert.equal(
        (await f.executor.readResult({ workspaceId: w.id, runId: legacy.runId, callId: legacy.callId }, f.actor)).result
          .name,
        'raw-secret-resource',
      );
      await assert.rejects(service.claim({ ...claimInput(legacy), origin: { kind: 'autonomous' } }), AccessDenied);
      await db.platform.query(
        `UPDATE ${table('tf_conversation_turns')} SET attempt_epoch=attempt_epoch+1 WHERE id=$1`,
        [run.origin.turnId],
      );
      await assert.rejects(
        service.append(fence, { producerId: randomUUID(), parts: [{ kind: 'text', text: 'stale' }] }),
        AccessDenied,
      );
      await assert.rejects(service.publishTool(fence, publication), AccessDenied);
      await assert.rejects(service.execute(fence, run.callId), AccessDenied);
      const current = await service.claim({
        ...claimInput(run),
        origin: { ...run.origin, epoch: run.origin.epoch + 1 },
      });
      assert.equal((await service.history(current)).length, 2);
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [w.membershipId]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        w.userId,
      ]);
      await assert.rejects(
        service.publishTool(current, { producerId: randomUUID(), callId: run.callId }),
        AccessDenied,
      );
      await assert.rejects(f.store.history(w.id, w.userId, run.origin.conversationId), AccessDenied);
    } finally {
      await f.close();
    }
  },
);

test('restricted runtime cannot mutate internal history or mint confirmation authority', async () => {
  const f = await internalFixture();
  let otherLogin;
  try {
    const run = await f.run('autonomous');
    const service = createInternalConversations(f.runtime);
    const fence = await service.claim(claimInput(run));
    await service.append(fence, { producerId: randomUUID(), parts: [{ kind: 'text', text: 'immutable' }] });
    for (const sql of [
      `UPDATE ${f.table('tf_internal_parts')} SET text='forged'`,
      `DELETE FROM ${f.table('tf_internal_messages')}`,
      `UPDATE ${f.table('tf_internal_conversations')} SET origin_turn_id=NULL`,
      `INSERT INTO ${f.table('tf_confirmations')} (id) VALUES ('${randomUUID()}')`,
    ])
      await assert.rejects(
        f.runtime.transaction(f.workspace.id, commonCompatibility, tx => tx.client.query(sql)),
        error => error.code === '42501',
      );
    assert.equal((await service.history(fence))[0].parts[0].text, 'immutable');
    const other = await f.db.create(f.stream);
    otherLogin = await connect(f.db.login(other));
    await assert.rejects(
      otherLogin.query(`SELECT * FROM ${f.table('tf_internal_messages')}`),
      error => error.code === '42501',
    );
    const receipts = await otherLogin.query(
      `SELECT name,checksum FROM "${other.names.schema}".tf_common_migrations ORDER BY name`,
    );
    assert.deepEqual(
      receipts.rows,
      f.stream.map(({ name, checksum }) => ({ name, checksum })),
    );
    assert.deepEqual((await otherLogin.query(`SELECT * FROM "${other.names.schema}".tf_internal_messages`)).rows, []);
  } finally {
    await otherLogin?.end();
    await f.close();
  }
});

test(
  'private cancellation during real tool execution rolls back the tool result and internal publication',
  { timeout: 60000 },
  async () => {
    const f = await internalFixture();
    let release;
    try {
      const run = await f.run();
      const service = createInternalConversations(f.runtime);
      const fence = await service.claim(claimInput(run));
      let entered;
      const started = new Promise(resolve => {
        entered = resolve;
      });
      const gate = new Promise(resolve => {
        release = resolve;
      });
      let paused = false;
      const runtime = {
        transaction: (id, range, action) =>
          f.runtime.transaction(id, range, tx =>
            action({
              ...tx,
              client: {
                query: async (sql, values) => {
                  const result = await tx.client.query(sql, values);
                  if (
                    !paused &&
                    sql.startsWith('UPDATE') &&
                    sql.includes('tf_agent_tool_calls') &&
                    /SET status ?= ?'completed'/.test(sql)
                  ) {
                    paused = true;
                    entered();
                    await gate;
                  }
                  return result;
                },
              },
            }),
          ),
      };
      const execution = createInternalAgentComposition(runtime).execute(fence, run.callId);
      const rejected = assert.rejects(execution, AccessDenied);
      await Promise.race([
        started,
        delay(10000, undefined, { ref: false }).then(() =>
          assert.fail('tool execution never wrote its completed status'),
        ),
      ]);
      await f.store.cancel(f.workspace.id, f.workspace.userId, run.origin.conversationId, run.origin.turnId, {
        commandId: randomUUID(),
        expectedGeneration: 0,
      });
      release();
      await rejected;
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT status,result FROM ${f.table('tf_agent_tool_calls')} WHERE id=$1`, [
            run.callId,
          ])
        ).rows,
        [{ status: 'pending', result: null }],
      );
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS count FROM ${f.table('tf_internal_messages')} WHERE conversation_id=$1`,
            [run.runId],
          )
        ).rows[0].count,
        0,
      );
      assert.deepEqual(
        (await f.store.history(f.workspace.id, f.workspace.userId, run.origin.conversationId)).messages.map(
          message => message.parts[0].text,
        ),
        ['Inspect this privately'],
      );
    } finally {
      release?.();
      await f.close();
    }
  },
);
