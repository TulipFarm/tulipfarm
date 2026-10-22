import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationMaintenance } from '@tulipfarm/conversations/maintenance';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createConversationMaintenanceActivities } from '../src/conversation-maintenance-activities.ts';
import { conversationCompactor } from '../src/conversation-compactor.ts';
import { conversationModel } from '../src/conversation-model.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { anthropicText, azureChat } from './native-chat-fixture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';

test(
  'real worker compactor meters durable steps once and resumes saved publication without model calls',
  { timeout: 60000 },
  async t => {
    const f = await conversationFixture();
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
    t.after(() => {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    });
    t.after(useModelCatalog());
    try {
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return Response.json(
          anthropicText(
            calls === 1
              ? JSON.stringify({ goal: 'Launch next week', openWork: ['Invite customers'] })
              : calls === 3
                ? '{"content":"","evidence":[]}'
                : '## Goal\nLaunch next week\n## Open work\nInvite customers',
          ),
        );
      });
      const w = f.workspace,
        id = randomUUID();
      await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
      const sent = await f.store.send(w.id, w.userId, id, {
        commandId: randomUUID(),
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: 'Launch next week.' }],
      });
      assert.equal(
        await createConversationExecutor(f.runtime, async () => ({
          text: 'Invite customers.',
          sources: [{ kind: 'private-conversation', conversationId: id }],
        })).process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
        'completed',
      );
      await f.db.platform.query(
        `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
        [id],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_compaction_policy')} (automatic,trigger_percent,target_percent,model_family_id,revision,editor_membership_id)
      VALUES (false,70,30,'claude-haiku',1,$1)`,
        [w.membershipId],
      );
      const maintenance = createConversationMaintenance(f.runtime),
        jobs = [];
      await maintenance.sweep(w.id);
      await maintenance.dispatch(w.id, async work => jobs.push(work));
      let publications = 0;
      const activities = createConversationMaintenanceActivities(f.runtime, {
        publish: async () => {
          publications++;
          if (publications === 1) throw new Error('retry publication');
          return { documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' };
        },
      });
      assert.equal(await activities.processConversationMaintenance(jobs[0]), 'failed');
      assert.equal(calls, 3);
      const usage = await f.db.platform.query(
        `SELECT count(*)::int AS count FROM ${f.table('tf_credit_usage')} WHERE id LIKE 'compact-maintenance:%'`,
      );
      assert.equal(usage.rows[0].count, 3);
      await f.store.resumeMaintenance(w.id, w.userId, id, { commandId: randomUUID() });
      assert.equal(await activities.processConversationMaintenance(jobs[0]), 'ready');
      assert.equal(calls, 3);
      assert.equal(publications, 2);
      assert.equal(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS count FROM ${f.table('tf_conversation_maintenance_steps')}`,
          )
        ).rows[0].count,
        2,
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_conversation_turns')}`)).rows[0]
          .count,
        1,
        'maintenance never invents a reply turn',
      );
    } finally {
      await f.close();
    }
  },
);

test('maintenance retains returned model answers across bounded save retries', { timeout: 55000 }, async t => {
  const f = await conversationFixture();
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AZURE_FOUNDRY_API_KEY: process.env.AZURE_FOUNDRY_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  process.env.AZURE_FOUNDRY_API_KEY = 'synthetic-test-key';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.after(useModelCatalog());
  const w = f.workspace;
  const summary = JSON.stringify({ goal: 'Launch next week', openWork: ['Invite customers'] });
  const recap = '## Goal\nLaunch next week\n## Open work\nInvite customers';
  const publish = async () => ({ documentId: randomUUID(), revisionId: randomUUID(), embeddingStatus: 'disabled' });
  async function prepare(fallback = 'deepseek-flash') {
    const id = randomUUID();
    await f.store.create(w.id, w.userId, { chatId: id, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, id, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Launch next week.' }],
    });
    assert.equal(
      await createConversationExecutor(f.runtime, async () => ({
        text: 'Invite customers.',
        sources: [{ kind: 'private-conversation', conversationId: id }],
      })).process({ workspaceId: w.id, conversationId: id, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_compaction_policy')}
      (automatic,trigger_percent,target_percent,model_family_id,fallback_family_id,revision,editor_membership_id)
      VALUES (false,70,30,'claude-haiku',$1,1,$2)
      ON CONFLICT (singleton) DO UPDATE SET fallback_family_id=EXCLUDED.fallback_family_id`,
      [fallback, w.membershipId],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversations')} SET activity_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
      [id],
    );
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_maintenance_sweep')} SET close_due_at=clock_timestamp(),scan_due_at=clock_timestamp() WHERE id=1`,
    );
    const maintenance = createConversationMaintenance(f.runtime),
      jobs = [];
    await maintenance.sweep(w.id);
    await maintenance.dispatch(w.id, async work => jobs.push(work));
    const job = jobs.find(work => work.conversationId === id);
    assert.ok(job);
    return job;
  }
  async function state(job) {
    return (
      await f.db.platform.query(
        `SELECT j.state,j.error_code,j.recap,
      (SELECT count(*)::int FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1) AS receipts,
      (SELECT count(*)::int FROM ${f.table('tf_credit_usage')} WHERE flow_id=$1 AND charged IS NOT NULL AND provider_pico_usd>0) AS settled,
      (SELECT count(*)::int FROM ${f.table('tf_conversation_maintenance_steps')} WHERE job_id=j.id) AS steps
      FROM ${f.table('tf_conversation_maintenance')} j WHERE id=$2`,
        [job.conversationId, job.jobId],
      )
    ).rows[0];
  }
  function provider(t, respond) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body.model);
      if (respond) return respond();
      const text = request.body.includes('personal preferences')
        ? '{"content":"","evidence":[]}'
        : request.body.includes('Transcript chunk')
          ? summary
          : recap;
      return Response.json(
        String(url).includes('anthropic.com')
          ? anthropicText(text)
          : azureChat({ kind: 'answer', text }, { usage: { prompt_tokens: 100, completion_tokens: 20 } }),
      );
    });
    return calls;
  }
  function failingSaves({ code = '40001', failures = 1, purpose = 'summary', afterRollback } = {}) {
    const responses = [],
      errors = [];
    let attempts = 0;
    const runtime = {
      ...f.runtime,
      transaction: async (workspaceId, compatibility, operation) => {
        let saving = false;
        try {
          return await f.runtime.transaction(workspaceId, compatibility, tx =>
            operation({
              ...tx,
              client: {
                query: async (sql, args) => {
                  if (
                    typeof sql !== 'string' ||
                    !sql.includes('INSERT INTO') ||
                    !sql.includes('tf_conversation_maintenance_steps')
                  )
                    return tx.client.query(sql, args);
                  saving = true;
                  responses.push(JSON.parse(args[4]));
                  const result = await tx.client.query(sql, args);
                  if (args[1] === purpose && ++attempts <= failures) {
                    if (code === null) throw new Error('synthetic-step-persistence-failed');
                    await tx.client.query(
                      `DO $$ BEGIN RAISE EXCEPTION 'step persistence failure fixture' USING ERRCODE='${code}'; END $$`,
                    );
                  }
                  return result;
                },
              },
            }),
          );
        } catch (error) {
          if (saving) {
            errors.push(error);
            if (responses.length === 1) await afterRollback?.();
          }
          throw error;
        }
      },
    };
    return { runtime, responses, errors };
  }
  try {
    for (const recovery of [
      { fallback: null, purpose: 'summary' },
      { fallback: 'deepseek-flash', purpose: 'summary' },
      { fallback: 'deepseek-flash', purpose: 'handoff' },
    ]) {
      await t.test(
        `rolled-back ${recovery.purpose} save reaches ready with fallback ${recovery.fallback ?? 'disabled'} and no extra model call or charge`,
        async t => {
          const job = await prepare(recovery.fallback),
            calls = provider(t);
          const fault = failingSaves({ purpose: recovery.purpose });
          const activities = createConversationMaintenanceActivities(fault.runtime, { publish });
          assert.equal(await activities.processConversationMaintenance(job), 'ready');
          assert.deepEqual(await state(job), {
            state: 'ready',
            error_code: null,
            recap,
            receipts: 3,
            settled: 3,
            steps: 2,
          });
          assert.deepEqual(calls, ['claude-haiku-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5']);
          assert.deepEqual(fault.responses, [
            { text: summary, familyId: 'claude-haiku', fallbackFrom: null },
            { text: recovery.purpose === 'summary' ? summary : recap, familyId: 'claude-haiku', fallbackFrom: null },
            { text: recap, familyId: 'claude-haiku', fallbackFrom: null },
            { text: '{"content":"","evidence":[]}', familyId: 'claude-haiku', fallbackFrom: null },
          ]);
          assert.deepEqual(
            (
              await f.db.platform.query(
                `SELECT purpose,response FROM ${f.table('tf_conversation_maintenance_steps')}
          WHERE job_id=$1 ORDER BY purpose`,
                [job.jobId],
              )
            ).rows,
            [
              { purpose: 'handoff', response: { text: recap, familyId: 'claude-haiku', fallbackFrom: null } },
              { purpose: 'summary', response: { text: summary, familyId: 'claude-haiku', fallbackFrom: null } },
            ],
          );
          assert.equal(await activities.processConversationMaintenance(job), 'idle');
          assert.equal(calls.length, 3);
        },
      );
    }
    await t.test('a lost commit acknowledgement retries the same saved answer once', async t => {
      const job = await prepare(),
        calls = provider(t);
      let saves = 0;
      const runtime = {
        ...f.runtime,
        transaction: async (workspaceId, compatibility, operation) => {
          let saving = false;
          const value = await f.runtime.transaction(workspaceId, compatibility, tx =>
            operation({
              ...tx,
              client: {
                query: async (sql, args) => {
                  if (
                    typeof sql === 'string' &&
                    sql.includes('INSERT INTO') &&
                    sql.includes('tf_conversation_maintenance_steps')
                  )
                    saving = true;
                  return tx.client.query(sql, args);
                },
              },
            }),
          );
          if (saving && ++saves === 1)
            throw Object.assign(new Error('lost commit acknowledgement'), { code: 'ECONNRESET' });
          return value;
        },
      };
      assert.equal(
        await createConversationMaintenanceActivities(runtime, { publish }).processConversationMaintenance(job),
        'ready',
      );
      assert.deepEqual(await state(job), {
        state: 'ready',
        error_code: null,
        recap,
        receipts: 3,
        settled: 3,
        steps: 2,
      });
      assert.deepEqual(calls, ['claude-haiku-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5']);
      assert.equal(saves, 4);
    });
    for (const failure of [
      { code: '40001', attempts: 3 },
      { code: '23514', attempts: 1 },
      { code: null, attempts: 1 },
    ]) {
      await t.test(`save failure ${failure.code ?? 'without a code'} stops without model-family fallback`, async t => {
        const job = await prepare(),
          calls = provider(t);
        const fault = failingSaves({ code: failure.code, failures: Infinity });
        const compactor = conversationCompactor(fault.runtime, family => conversationModel(family));
        let surfaced;
        const activities = createConversationMaintenanceActivities(fault.runtime, {
          publish,
          compactor: {
            ...compactor,
            summarize: async input => {
              try {
                return await compactor.summarize(input);
              } catch (error) {
                surfaced = error;
                throw error;
              }
            },
          },
        });
        assert.equal(await activities.processConversationMaintenance(job), 'failed');
        assert.deepEqual(await state(job), {
          state: 'failed',
          error_code: 'maintenance-failed',
          recap: null,
          receipts: 1,
          settled: 1,
          steps: 0,
        });
        assert.deepEqual(calls, ['claude-haiku-4-5']);
        assert.equal(fault.responses.length, failure.attempts);
        assert.equal(surfaced, fault.errors.at(-1), 'the original storage error reaches maintenance error handling');
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp() WHERE id=$1`,
          [job.jobId],
        );
        assert.equal(await activities.processConversationMaintenance(job), 'blocked');
        assert.deepEqual(await state(job), {
          state: 'blocked',
          error_code: 'generation-unconfirmed',
          recap: null,
          receipts: 1,
          settled: 1,
          steps: 0,
        });
        assert.deepEqual(calls, ['claude-haiku-4-5']);
      });
    }
    for (const change of ['revoked', 'expired']) {
      await t.test(`${change} authority between save attempts prevents result persistence`, async t => {
        const job = await prepare(),
          calls = provider(t);
        const fault = failingSaves({
          afterRollback: async () => {
            assert.equal((await state(job)).steps, 0, 'the failed transaction rolled back its inserted response');
            if (change === 'revoked')
              await f.db.platform.query(
                `UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
                [w.membershipId],
              );
            else
              await f.db.platform.query(
                `UPDATE ${f.table('tf_conversation_maintenance')} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
                [job.jobId],
              );
          },
        });
        try {
          const expected = change === 'revoked' ? 'blocked' : 'stale';
          assert.equal(
            await createConversationMaintenanceActivities(fault.runtime, { publish }).processConversationMaintenance(
              job,
            ),
            expected,
          );
          assert.deepEqual(await state(job), {
            state: expected,
            error_code: change === 'revoked' ? 'access-denied' : 'maintenance-stale',
            recap: null,
            receipts: 1,
            settled: 1,
            steps: 0,
          });
          assert.deepEqual(calls, ['claude-haiku-4-5']);
          assert.equal(fault.responses.length, 1, 'the second attempt must stop before INSERT');
        } finally {
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            w.membershipId,
          ]);
        }
      });
    }
    for (const outcome of ['transport-error', 'http-error-with-usage']) {
      await t.test(`${outcome} without a returned answer remains generation-unconfirmed`, async t => {
        const job = await prepare(null);
        const calls = provider(t, () => {
          if (outcome === 'transport-error') throw new Error('synthetic connection lost after dispatch');
          return Response.json(anthropicText('Not a successful answer'), { status: 503 });
        });
        const settled = outcome === 'transport-error' ? 0 : 1;
        const activities = createConversationMaintenanceActivities(f.runtime, { publish });
        assert.equal(await activities.processConversationMaintenance(job), 'failed');
        assert.deepEqual(await state(job), {
          state: 'failed',
          error_code: 'maintenance-failed',
          recap: null,
          receipts: 1,
          settled,
          steps: 0,
        });
        await f.db.platform.query(
          `UPDATE ${f.table('tf_conversation_maintenance')} SET next_attempt_at=clock_timestamp() WHERE id=$1`,
          [job.jobId],
        );
        assert.equal(await activities.processConversationMaintenance(job), 'blocked');
        assert.deepEqual(await state(job), {
          state: 'blocked',
          error_code: 'generation-unconfirmed',
          recap: null,
          receipts: 1,
          settled,
          steps: 0,
        });
        assert.deepEqual(calls, ['claude-haiku-4-5']);
        await assert.rejects(
          f.store.resumeMaintenance(w.id, w.userId, job.conversationId, { commandId: randomUUID() }),
          { message: 'maintenance-not-resumable' },
        );
      });
    }
  } finally {
    await f.close();
  }
});
