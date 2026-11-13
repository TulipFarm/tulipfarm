import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import {
  CodingRunDecisionConflict,
  decideCodingRun,
  proposeCodingRun,
  resumeCodingRun,
  runApprovedCodingRun,
  viewCodingRun,
} from '../../../agents/src/coding-run-store.ts';
import { createConversationExecutor } from '../../src/runtime.ts';
import { conversationFixture } from '../fixture.mjs';

const call = { tool: 'coding.run', repository: 'octo/app', task: 'Fix the failing test', agent: 'codex' };
const digest = 'd'.repeat(64);

/** A chat whose reply asks for one coding run, with an executor that resumes it the way the worker does. */
async function codingChat(t) {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const chatId = randomUUID();
  await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  const sent = await f.store.send(w.id, w.userId, chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    parts: [{ kind: 'text', text: 'Fix the failing test in octo/app' }],
  });
  const work = { workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 };
  const replies = [];
  const starts = [];
  const executor = runtime =>
    createConversationExecutor(
      runtime,
      async input => {
        replies.push(input);
        if (replies.length > 1) return { text: 'The run is done.', sources: [] };
        await input.executeTool(
          call.tool,
          true,
          async context => {
            await proposeCodingRun(context.runtime, context.workspaceId, {
              id: context.callId,
              actor: context.actor,
              conversationId: context.origin.conversationId,
              turnId: context.origin.turnId,
              generation: context.origin.generation,
              agent: call.agent,
              repository: call.repository,
              branch: null,
              task: call.task,
              planOwnerMembershipId: context.actor.membershipId,
              digest,
            });
            return { result: { provider: 'coding-run', kind: 'waiting', runId: context.callId }, sources: [] };
          },
          [],
          call,
        );
        return { text: 'unreachable', sources: [] };
      },
      ...Array(11).fill(undefined),
      {
        offered: async () => true,
        resume: async context => {
          const resumed = await resumeCodingRun(
            context.runtime,
            context.workspaceId,
            context.callId,
            async () => void starts.push(context.callId),
          );
          return resumed.state === 'waiting' ? resumed : { ...resumed, sources: [] };
        },
      },
    );
  const turn = async () =>
    (
      await f.db.platform.query(`SELECT status, error_code FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
        sent.turnId,
      ])
    ).rows[0];
  const output = async runId =>
    (
      await f.db.platform.query(`SELECT output FROM ${f.table('tf_conversation_execution_steps')} WHERE call_id=$1`, [
        runId,
      ])
    ).rows[0].output;
  const decide = (who, runId, decision) =>
    withMaintenanceTransaction({
      workspaceId: w.id,
      connectionString: f.db.login(w, 'confirmation'),
      capability: 'confirmation',
      operation: tx => decideCodingRun(tx, who, runId, decision),
    });
  const view = (who, runId) => f.runtime.transaction(w.id, commonCompatibility, tx => viewCodingRun(tx, who, runId));

  await executor(f.runtime).process(work);
  assert.deepEqual(await turn(), { status: 'waiting', error_code: 'coding-run-waiting' });
  const runId = (
    await f.db.platform.query(`SELECT id FROM ${f.table('tf_coding_runs')} WHERE turn_id=$1`, [sent.turnId])
  ).rows[0].id;
  assert.equal(await executor(f.runtime).process(work), 'idle');
  assert.deepEqual(starts, []);
  assert.equal((await view(actor, runId)).status, 'awaiting-approval');
  return { f, w, actor, work, runId, replies, starts, executor, turn, output, decide, view };
}

test(
  'an approved coding run starts once and its result resumes the chat after a restart',
  { timeout: 60000 },
  async t => {
    const { f, w, actor, work, runId, replies, starts, executor, turn, output, decide, view } = await codingChat(t);
    const decision = { commandId: randomUUID(), digest, decision: 'approve' };
    const decided = await decide(actor, runId, decision);
    assert.equal(decided.view.status, 'approved');
    assert.deepEqual(decided.origin, { conversationId: work.conversationId, turnId: work.turnId, generation: 0 });
    assert.equal((await decide(actor, runId, decision)).view.status, 'approved', 'a retried command replays');
    await assert.rejects(decide(actor, runId, { ...decision, commandId: randomUUID() }), CodingRunDecisionConflict);

    // The worker that saw the decision is gone; a new runtime and executor read it from the database.
    const restarted = f.createRuntime();
    t.after(() => restarted.close());
    assert.equal(await executor(restarted).process(work), 'idle');
    assert.deepEqual(starts, [runId]);
    assert.equal((await turn()).status, 'waiting');

    let executed = 0;
    const run = async record => {
      executed++;
      assert.equal(record.id, runId);
      assert.deepEqual(record.actor, actor);
      assert.equal(record.repository, 'octo/app');
      return { status: 'completed', message: 'Fixed it.', files: ['src/a.ts'], diff: '', diffTruncated: false };
    };
    assert.equal(await runApprovedCodingRun(restarted, w.id, runId, 30 * 60 * 1000, run), true);
    assert.equal(await runApprovedCodingRun(restarted, w.id, runId, 30 * 60 * 1000, run), false, 'a run starts once');
    assert.equal(executed, 1);
    assert.equal((await view(actor, runId)).status, 'finished');
    assert.equal((await view(actor, runId)).outcome, 'completed');

    await executor(restarted).process(work);
    assert.equal((await output(runId)).result.message, 'Fixed it.');
    await executor(restarted).process(work);
    assert.equal((await turn()).status, 'completed');
    assert.equal(replies.length, 2);
  },
);

test('a denied coding run never starts and the chat continues', { timeout: 60000 }, async t => {
  const { actor, work, runId, replies, starts, executor, f, turn, output, decide, view } = await codingChat(t);
  await decide(actor, runId, { commandId: randomUUID(), digest, decision: 'deny' });
  assert.equal((await view(actor, runId)).status, 'denied');
  await executor(f.runtime).process(work);
  assert.equal((await output(runId)).result.status, 'denied');
  await executor(f.runtime).process(work);
  assert.equal((await turn()).status, 'completed');
  assert.deepEqual(starts, []);
  assert.equal(replies.length, 2);
  assert.equal(await runApprovedCodingRun(f.runtime, work.workspaceId, runId, 1000, async () => ({})), false);
});

test('only the member who asked can see or decide a coding run', { timeout: 60000 }, async t => {
  const { f, actor, runId, starts, decide, view } = await codingChat(t);
  const other = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
    other.membershipId,
    other.userId,
  ]);
  assert.equal(await view(other, runId), undefined);
  for (const decision of ['approve', 'deny'])
    await assert.rejects(decide(other, runId, { commandId: randomUUID(), digest, decision }), AccessDenied);
  await assert.rejects(
    decide(actor, runId, { commandId: randomUUID(), digest: 'e'.repeat(64), decision: 'approve' }),
    CodingRunDecisionConflict,
    'a stale run cannot be approved',
  );
  assert.equal((await view(actor, runId)).status, 'awaiting-approval');
  assert.deepEqual(starts, []);
});
