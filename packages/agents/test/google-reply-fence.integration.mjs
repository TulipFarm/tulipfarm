import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { createGoogleOperations } from '@tulipfarm/google-workspace/operations';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createChatTools } from '../src/tools.ts';
import { googleRuntimeFixture } from './google-fixture.mjs';

async function approvedChat(f) {
  const w = f.workspace.id,
    chatId = randomUUID();
  const proposal = await createChatTools(f.runtime, { google: f.factory }).invoke(
    { workspaceId: w, actor: f.member, callId: randomUUID() },
    { tool: 'google.propose', operation: { kind: 'docs.documents.create', title: 'Owner approved' } },
  );
  await f.approve(w, f.member.userId, proposal.data.id, { digest: proposal.data.digest, decision: 'approve' });
  await f.store.create(w, f.member.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w, f.member.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Run the approved Google action.' }],
  });
  return {
    chatId,
    proposalId: proposal.data.id,
    turnId: sent.turnId,
    work: { workspaceId: w, conversationId: chatId, turnId: sent.turnId, generation: 0 },
  };
}

function operations(f, { beforeCredential = async () => {}, fetcher = f.fetcher } = {}) {
  return runtime =>
    createGoogleOperations({
      runtime,
      fetcher,
      integrations: createGoogleWorkspaceService({
        ...f.serviceOptions,
        runtime: {
          transaction: async (...args) => {
            await beforeCredential();
            return runtime.transaction(...args);
          },
        },
      }),
    });
}

function chat(f, factory, proposalId) {
  return createConversationExecutor(f.runtime, async ({ executeTool }) => {
    const result = await executeTool('google.execute', true, context =>
      createChatTools(context.runtime, { google: factory }).invoke(context, { tool: 'google.execute', proposalId }),
    );
    return { text: `Google receipt ${result.data.status}.`, sources: [{ kind: 'unknown' }] };
  });
}

const writes = f => f.calls.filter(call => call.method === 'POST').length;
const receiptStatus = async (f, proposalId) =>
  (await f.db.platform.query(`SELECT status FROM ${f.table('tf_google_receipts')} WHERE proposal_id=$1`, [proposalId]))
    .rows[0]?.status ?? null;

test('approved Google execution in a current reply dispatches exactly once', async () => {
  const f = await googleRuntimeFixture();
  try {
    const { chatId, proposalId, turnId, work } = await approvedChat(f);
    assert.equal(await chat(f, f.factory, proposalId).process(work), 'completed');
    assert.equal(writes(f), 1);
    assert.equal(await receiptStatus(f, proposalId), 'succeeded');
    assert.deepEqual(
      (
        await f.db.platform.query(`SELECT tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`, [
          turnId,
        ])
      ).rows,
      [{ tool: 'google.execute', status: 'completed' }],
    );
    assert.equal(
      (await f.store.history(f.workspace.id, f.member.userId, chatId)).messages.at(-1).parts[0].text,
      'Google receipt succeeded.',
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['cancelled', 'generation', 'expired', 'takeover'])
  test(`a ${mode} reply fence stops Google dispatch after the running receipt`, async () => {
    const f = await googleRuntimeFixture();
    try {
      const { chatId, proposalId, turnId, work } = await approvedChat(f);
      let stale = false,
        replacement;
      const beforeCredential = async () => {
        if (stale) return;
        stale = true;
        assert.deepEqual(
          (
            await f.db.platform.query(
              `SELECT tool,status FROM ${f.table('tf_conversation_tool_calls')} WHERE turn_id=$1`,
              [turnId],
            )
          ).rows,
          [{ tool: 'google.execute', status: 'running' }],
        );
        if (mode === 'cancelled')
          await f.store.cancel(f.workspace.id, f.member.userId, chatId, turnId, {
            commandId: randomUUID(),
            expectedGeneration: 0,
          });
        else if (mode === 'generation')
          await f.db.platform.query(
            `UPDATE ${f.table('tf_conversation_turns')} SET generation=generation+1 WHERE id=$1`,
            [turnId],
          );
        else
          await f.db.platform.query(
            `UPDATE ${f.table('tf_conversation_turns')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [turnId],
          );
        if (mode === 'takeover')
          replacement = await createConversationExecutor(
            f.runtime,
            async () => 'Recovered by the current owner.',
          ).claim(work);
      };
      assert.equal(await chat(f, operations(f, { beforeCredential }), proposalId).process(work), 'stale');
      assert.equal(stale, true);
      assert.equal(writes(f), 0, 'no provider request after the fence went stale');
      assert.equal(
        await receiptStatus(f, proposalId),
        'executing',
        'the claim stays unverified because no outcome was observed',
      );
      if (mode === 'takeover') assert.equal(replacement.epoch, 2);
      assert.equal((await f.store.history(f.workspace.id, f.member.userId, chatId)).messages.length, 1);
    } finally {
      await f.close();
    }
  });

test('cancellation waits behind an in-flight Google dispatch, then wins before the next transaction', async () => {
  const f = await googleRuntimeFixture();
  try {
    const { chatId, proposalId, turnId, work } = await approvedChat(f);
    let dispatched, release;
    const dispatching = new Promise(resolve => {
      dispatched = resolve;
    });
    const held = new Promise(resolve => {
      release = resolve;
    });
    const fetcher = async (url, init) => {
      if (init?.method === 'POST') {
        dispatched();
        await held;
      }
      return f.fetcher(url, init);
    };
    const reply = chat(f, operations(f, { fetcher }), proposalId).process(work);
    await dispatching;
    let settled = false;
    const cancel = f.store
      .cancel(f.workspace.id, f.member.userId, chatId, turnId, { commandId: randomUUID(), expectedGeneration: 0 })
      .finally(() => {
        settled = true;
      });
    for (
      let attempt = 0;
      !(await f.db.platform.query('SELECT 1 FROM pg_locks WHERE NOT granted')).rowCount;
      attempt++
    ) {
      assert.ok(attempt < 300, 'cancellation must wait on the dispatch transaction');
      await delay(10);
    }
    assert.equal(settled, false);
    release();
    assert.equal((await cancel).status, 'cancelled');
    assert.equal(await reply, 'stale');
    assert.equal(writes(f), 1);
    assert.equal(
      await receiptStatus(f, proposalId),
      'succeeded',
      'the dispatched outcome is recorded with the dispatch',
    );
    assert.equal((await f.store.history(f.workspace.id, f.member.userId, chatId)).messages.length, 1);
  } finally {
    await f.close();
  }
});
