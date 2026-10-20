import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { settleCredits } from '@tulipfarm/workspace-storage/credits';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import {
  coordinatorAdmission,
  createPlanRuntime,
  recordCoordinatorModelTime,
  reserveCoordinatorModel,
} from '../src/plan-runtime.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

test(
  'coordinator claims are fenced and completion requires fresh receipts and final verification',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const chatId = randomUUID(),
      turnId = randomUUID(),
      messageId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
      [chatId, w.userId, w.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
      [messageId, chatId, w.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence,responder,status,attempt_epoch,lease_until)
    VALUES ($1,$2,$3,1,'reverse-text-v1','processing',1,clock_timestamp()+interval '60 seconds')`,
      [turnId, chatId, messageId],
    );
    const plans = createAgentPlans(runtime),
      coordinator = createPlanRuntime(runtime);
    let sequence = 0;
    async function receipt(tool, result) {
      const callId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,$4,$5,'completed')`,
        [callId, chatId, turnId, ++sequence, tool],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output) VALUES ($1,$2,$3,'[]',$4)`,
        [callId, turnId, { tool }, { result, sources: [] }],
      );
      return { callId, summary: 'Checked current state.' };
    }
    async function origin(tool) {
      const { callId } = await receipt(tool, {});
      return { conversationId: chatId, turnId, generation: 0, epoch: 1, callId };
    }
    const created = await plans.create(
      w.id,
      w.userId,
      chatId,
      randomUUID(),
      {
        title: 'Verified agent setup',
        planning: {
          requirements: [{ key: 'active', description: 'An active agent', tasks: ['setup'] }],
          prerequisites: [],
          verificationTask: 'verify',
        },
        tasks: [
          { key: 'setup', title: 'Set up agent', criteria: ['Agent is active'], assignee: { kind: 'coordinator' } },
          {
            key: 'verify',
            title: 'Verify request',
            criteria: ['All requirements met'],
            dependsOn: ['setup'],
            assignee: { kind: 'coordinator' },
          },
        ],
      },
      turnId,
    );
    const old = await receipt('agents.read', { active: true });
    const claimOrigin = await origin('plans.claim');
    const command = { planId: created.id, task: 'setup', expectedVersion: 0 };
    const claimed = await coordinator.claimCoordinator(w.id, w.userId, claimOrigin, command);
    assert.equal(claimed.task, 'setup');
    assert.deepEqual(await coordinator.claimCoordinator(w.id, w.userId, claimOrigin, command), claimed);
    await assert.rejects(
      coordinator.claimCoordinator(w.id, w.userId, { ...claimOrigin, epoch: 2 }, command),
      AccessDenied,
    );
    const fence = { workspaceId: w.id, conversationId: chatId, turnId, generation: 0, epoch: 1 };
    const admission = reserve =>
      runtime.transaction(w.id, coordinator.compatibility, tx => coordinatorAdmission(tx, fence, { reserve }));
    assert.equal(
      await admission(2_000_000_000_000n),
      claimed.attemptId,
      '300 credits exactly fits the default allowance',
    );
    await assert.rejects(
      admission(2_000_000_000_001n),
      /planning-budget/,
      'one provider unit above rounds to 301 credits',
    );
    const modelUsage = step => ({
      id: `chat:${turnId}:0:1:${step}`,
      modelId: 'fixture-model',
      agentId: null,
      activity: 'chat',
      providerPicoUsd: '1000000000',
      pricingRevision: 'fixture',
    });
    for (const step of [0, 1]) {
      const usage = modelUsage(step);
      assert.deepEqual(
        await runtime.transaction(w.id, coordinator.compatibility, tx => reserveCoordinatorModel(tx, fence, usage)),
        { admitted: true, attemptId: claimed.attemptId },
      );
      assert.equal(
        (await runtime.transaction(w.id, coordinator.compatibility, tx => reserveCoordinatorModel(tx, fence, usage)))
          .admitted,
        false,
      );
      await runtime.transaction(w.id, coordinator.compatibility, async tx => {
        await recordCoordinatorModelTime(tx, usage.id, claimed.attemptId, 25);
        await settleCredits(tx, usage.id, usage.providerPicoUsd);
      });
      await runtime.transaction(w.id, coordinator.compatibility, async tx => {
        await recordCoordinatorModelTime(tx, usage.id, claimed.attemptId, 1000);
        await settleCredits(tx, usage.id, usage.providerPicoUsd);
      });
    }
    const billed = (
      await db.platform.query(
        `SELECT flow_id,plan_attempt_id,charged::text,plan_milliseconds::text FROM ${table('tf_credit_usage')} WHERE plan_attempt_id=$1 ORDER BY id`,
        [claimed.attemptId],
      )
    ).rows;
    assert.deepEqual(
      billed.map(row => row.flow_id),
      [chatId, chatId],
      'plan attribution preserves ordinary conversation billing',
    );
    assert.equal(
      billed.reduce((total, row) => total + BigInt(row.charged), 0n),
      1_000_000_000_000n,
      'two model calls round once in the existing chat flow',
    );
    assert.deepEqual(
      billed.map(row => row.plan_milliseconds),
      ['25', '25'],
      'replayed settlement cannot repeat active time',
    );
    assert.equal(
      (
        await db.platform.query(
          `SELECT active_milliseconds::text AS elapsed FROM ${table('tf_agent_plan_attempts')} WHERE id=$1`,
          [claimed.attemptId],
        )
      ).rows[0].elapsed,
      '50',
    );
    const report = evidence => ({
      outcome: 'passed',
      summary: 'Agent is active.',
      checks: [{ criterion: 0, outcome: 'passed', evidence: [evidence] }],
    });
    await assert.rejects(
      coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
        planId: created.id,
        attemptId: claimed.attemptId,
        report: report(old),
      }),
      /planning-evidence/,
    );
    const denied = await receipt('agents.read', { error: 'access-denied' });
    await assert.rejects(
      coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
        planId: created.id,
        attemptId: claimed.attemptId,
        report: report(denied),
      }),
      /planning-evidence/,
    );
    const checked = await receipt('agents.read', { active: true });
    const reportOrigin = await origin('plans.report');
    const submitted = { planId: created.id, attemptId: claimed.attemptId, report: report(checked) };
    const accepted = await coordinator.reportCoordinator(w.id, w.userId, reportOrigin, submitted);
    assert.deepEqual(await coordinator.reportCoordinator(w.id, w.userId, reportOrigin, submitted), accepted);
    let view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.tasks.find(task => task.key === 'setup').state, 'completed');
    assert.equal(view.lifecycle, 'active', 'a deliverable is not final verification');
    const verify = await coordinator.claimCoordinator(w.id, w.userId, await origin('plans.claim'), {
      planId: created.id,
      task: 'verify',
      expectedVersion: view.version,
    });
    const finalEvidence = await receipt('agents.read', { active: true });
    await assert.rejects(
      coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
        planId: created.id,
        attemptId: verify.attemptId,
        report: report(finalEvidence),
      }),
      /planning-evidence/,
    );
    await coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
      planId: created.id,
      attemptId: verify.attemptId,
      report: {
        ...report(finalEvidence),
        requirements: [{ key: 'active', outcome: 'passed', evidence: [finalEvidence] }],
      },
    });
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.lifecycle, 'completed');
    assert.equal(view.counts.completed, 2);
    assert.equal(view.tasks.find(task => task.key === 'verify').report.requirements[0].key, 'active');
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS count FROM ${table('tf_agent_plan_attempts')} WHERE plan_id=$1 AND report->>'outcome'='passed'`,
          [created.id],
        )
      ).rows[0].count,
      2,
    );

    const partial = await plans.create(
      w.id,
      w.userId,
      chatId,
      randomUUID(),
      {
        title: 'Independent work with a blocked successor',
        planning: {
          requirements: [
            { key: 'setup', description: 'Complete all tasks', tasks: ['independent', 'blocked', 'repair'] },
          ],
          prerequisites: [
            {
              key: 'access',
              title: 'Integration access',
              status: 'blocked',
              reason: 'Access denied.',
              tasks: ['blocked'],
              evidence: [denied],
            },
          ],
          verificationTask: 'verify',
        },
        tasks: [
          {
            key: 'independent',
            title: 'Read accessible inventory',
            criteria: ['Inventory checked'],
            assignee: { kind: 'coordinator' },
          },
          {
            key: 'blocked',
            title: 'Read restricted inventory',
            criteria: ['Restricted inventory checked'],
            assignee: { kind: 'coordinator' },
          },
          {
            key: 'repair',
            title: 'Check a failing setup',
            criteria: ['Setup works'],
            assignee: { kind: 'coordinator' },
          },
          {
            key: 'verify',
            title: 'Verify all',
            criteria: ['Request met'],
            dependsOn: ['independent', 'blocked', 'repair'],
            assignee: { kind: 'coordinator' },
          },
        ],
      },
      turnId,
    );
    const independent = await coordinator.claimCoordinator(w.id, w.userId, await origin('plans.claim'), {
      planId: partial.id,
      task: 'independent',
      expectedVersion: partial.version,
    });
    await coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
      planId: partial.id,
      attemptId: independent.attemptId,
      report: report(await receipt('tables.list', { items: [] })),
    });
    const partialView = await plans.read(w.id, w.userId, partial.id);
    assert.equal(
      partialView.tasks.find(task => task.key === 'independent').state,
      'completed',
      'an unrelated denied prerequisite cannot reject checked work',
    );
    assert.equal(partialView.tasks.find(task => task.key === 'blocked').state, 'blocked');
    assert.notEqual(partialView.lifecycle, 'completed');
    let repairVersion = partialView.version;
    for (let retry = 0; retry < 3; retry++) {
      const claim = await coordinator.claimCoordinator(w.id, w.userId, await origin('plans.claim'), {
        planId: partial.id,
        task: 'repair',
        expectedVersion: repairVersion,
      });
      const failed = await coordinator.reportCoordinator(w.id, w.userId, await origin('plans.report'), {
        planId: partial.id,
        attemptId: claim.attemptId,
        report: { outcome: 'failed', summary: 'The required setup check failed.', checks: [] },
      });
      const reset = await plans.update(w.id, w.userId, partial.id, randomUUID(), {
        expectedVersion: failed.version,
        mutations: [{ op: 'retry', key: 'repair' }],
      });
      repairVersion = reset.version;
    }
    await assert.rejects(
      coordinator.claimCoordinator(w.id, w.userId, await origin('plans.claim'), {
        planId: partial.id,
        task: 'repair',
        expectedVersion: repairVersion,
      }),
      /invalid-transition/,
    );
    assert.deepEqual(
      (await plans.read(w.id, w.userId, partial.id)).planning.requirements,
      partialView.planning.requirements,
      'bounded repair never weakens the original requirement',
    );
  },
);
