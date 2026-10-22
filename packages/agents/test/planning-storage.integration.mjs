import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import { createPlanRuntime } from '../src/plan-runtime.ts';
import { createPlanSchema } from '../src/plan-contracts.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { registerExtension } from '@tulipfarm/extensions';
import { hostedCreditPricingExtension } from '../../workspace-storage/test/hosted-credit-pricing.mjs';

// Budget and balance assertions here count whole credits, so they use the hosted price.
await registerExtension(hostedCreditPricingExtension, { app: 'worker', env: {} });

test(
  'Planning persists drafts, checks real receipts, keeps prerequisite waits and fences Start',
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
    const plans = createAgentPlans(runtime),
      scheduler = createPlanRuntime(runtime);
    async function conversation() {
      const chatId = randomUUID(),
        messageId = randomUUID(),
        turnId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,next_message_sequence) VALUES ($1,$2,$3,2)`,
        [chatId, w.userId, w.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id) VALUES ($1,$2,1,'human',$3)`,
        [messageId, chatId, w.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_turns')} (id,conversation_id,source_message_id,accepted_sequence,responder) VALUES ($1,$2,$3,1,'reverse-text-v1')`,
        [turnId, chatId, messageId],
      );
      return { chatId, turnId };
    }
    const chat = await conversation(),
      other = await conversation();
    async function receipt(origin, sequence, result, tool = 'slack.resolve', sources = []) {
      const id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,$4,$5,'completed')`,
        [id, origin.chatId, origin.turnId, sequence, tool],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output) VALUES ($1,$2,$3,'[]',$4)`,
        [id, origin.turnId, { tool }, { result, sources }],
      );
      return { callId: id, summary: 'Read the live prerequisite.' };
    }
    const good = await receipt(chat, 1, { available: true, channel: 'C_SYNTHETIC' });
    const denied = await receipt(chat, 2, { error: 'access-denied' });
    const draft = await receipt(chat, 3, { status: 'completed' }, 'agents.draft');
    const foreign = await receipt(other, 1, { available: true });
    const stale = await receipt(chat, 4, { available: true }, 'schema.inspect', [
      { kind: 'table', tableId: randomUUID() },
    ]);
    const specification = {
      requirements: [{ key: 'triage', description: 'An active triage agent', tasks: ['agent'] }],
      prerequisites: [
        {
          key: 'slack',
          title: 'Slack access',
          tasks: ['agent'],
          status: 'unknown',
          evidence: [],
          reason: 'Resolve the channel first.',
        },
      ],
      verificationTask: 'verify',
    };
    const tasks = [
      { key: 'agent', title: 'Create the agent', assignee: { kind: 'coordinator' }, criteria: ['Agent is active'] },
      {
        key: 'verify',
        title: 'Verify the request',
        assignee: { kind: 'coordinator' },
        criteria: ['All requirements met'],
        dependsOn: ['agent'],
      },
    ];
    const input = { title: 'Alert triage', execution: 'plan-only', planning: specification, tasks };
    const requestId = randomUUID();
    await assert.rejects(plans.create(w.id, w.userId, chat.chatId, requestId, input, other.turnId), AccessDenied);
    const created = await plans.create(w.id, w.userId, chat.chatId, requestId, input, chat.turnId);
    assert.deepEqual(await plans.create(w.id, w.userId, chat.chatId, requestId, input, chat.turnId), created);
    let view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.lifecycle, 'draft');
    assert.equal(view.outcome, 'waiting');
    assert.deepEqual(view.planning, specification);
    assert.deepEqual(view.tasks[0].assignee, { kind: 'coordinator' });
    await assert.rejects(plans.create(w.id, w.userId, chat.chatId, randomUUID(), input), /plan-open/);
    await assert.rejects(
      plans.control(w.id, w.userId, created.id, { requestId: randomUUID(), expectedVersion: 0, action: 'resume' }),
      /invalid-transition/,
    );
    assert.deepEqual(await scheduler.step(w.id, created.id), { kind: 'terminal', specialists: [] });
    assert.equal((await plans.read(w.id, w.userId, created.id)).lifecycle, 'draft');
    const checked = evidence => ({
      ...specification,
      prerequisites: [{ ...specification.prerequisites[0], status: 'verified', evidence: [evidence] }],
    });
    for (const evidence of [denied, draft, foreign, { callId: randomUUID(), summary: 'Invented receipt' }]) {
      await assert.rejects(
        plans.update(w.id, w.userId, created.id, randomUUID(), { expectedVersion: 0, planning: checked(evidence) }),
        /planning-evidence/,
      );
    }
    await assert.rejects(
      plans.update(w.id, w.userId, created.id, randomUUID(), { expectedVersion: 0, planning: checked(stale) }),
      AccessDenied,
    );
    await assert.rejects(
      plans.update(w.id, w.userId, created.id, randomUUID(), {
        expectedVersion: 0,
        planning: { ...specification, prerequisites: [] },
      }),
      /planning-prerequisite/,
    );
    await plans.update(w.id, w.userId, created.id, randomUUID(), { expectedVersion: 0, planning: checked(good) });
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.tasks.find(task => task.key === 'agent').state, 'ready');
    const start = { requestId: randomUUID(), expectedVersion: 1, action: 'start' };
    const started = await plans.control(w.id, w.userId, created.id, start);
    assert.deepEqual(await plans.control(w.id, w.userId, created.id, start), started);
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS n FROM ${table('tf_conversation_turns')} WHERE plan_id=$1`,
          [created.id],
        )
      ).rows[0].n,
      1,
      'Start retries create one real user-action turn',
    );
    await assert.rejects(
      plans.control(w.id, w.userId, created.id, { ...start, requestId: randomUUID() }),
      /version-conflict/,
    );
    assert.equal((await plans.read(w.id, w.userId, created.id)).lifecycle, 'active');
    await scheduler.step(w.id, created.id);
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS n FROM ${table('tf_agent_plan_attempts')} WHERE plan_id=$1`,
          [created.id],
        )
      ).rows[0].n,
      0,
      'the worker scheduler does not create phantom coordinator attempts',
    );

    const delegated = await plans.create(
      w.id,
      w.userId,
      other.chatId,
      randomUUID(),
      {
        title: 'Delegated check',
        planning: { ...specification, prerequisites: [] },
        specialists: [
          {
            key: 'reader',
            name: 'Reader',
            role: 'Read public facts',
            instructions: 'Check the requested facts.',
            tools: ['web.search'],
          },
        ],
        tasks: [{ ...tasks[0], assignee: { kind: 'specialist', specialist: 'reader' } }, tasks[1]],
      },
      other.turnId,
    );
    const work = await scheduler.step(w.id, delegated.id);
    assert.equal(work.specialists.length, 1);
    await db.platform.query(
      `UPDATE ${table('tf_conversation_turns')} SET status='waiting',error_code='plan-worker-waiting',plan_id=$2 WHERE id=$1`,
      [other.turnId, delegated.id],
    );
    let reservations = 0;
    assert.equal(
      await scheduler.admitSpecialistStep(w.id, work.specialists[0], 2_000_000_000_000n, async () => {
        reservations++;
        return true;
      }),
      true,
    );
    assert.equal(
      await scheduler.admitSpecialistStep(w.id, work.specialists[0], 2_000_000_000_001n, async () => {
        reservations++;
        return true;
      }),
      false,
    );
    assert.equal(reservations, 1, 'specialists use the same rounded credit units before reservation');
    await scheduler.settleSpecialist(
      w.id,
      work.specialists[0],
      { kind: 'completed', result: 'I could not inspect the agent.', sources: [] },
      { toolCalls: 0, activeMilliseconds: 10 },
    );
    assert.ok(
      (await scheduler.due(w.id)).includes(delegated.id),
      'recovery finds a plan even when its completion wake was lost',
    );
    await scheduler.step(w.id, delegated.id);
    await scheduler.step(w.id, delegated.id);
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS n FROM ${table('tf_conversation_outbox')} WHERE turn_id=$1 AND generation=1`,
          [other.turnId],
        )
      ).rows[0].n,
      1,
      'worker completion wakes the same source turn once',
    );
    const reported = await plans.read(w.id, w.userId, delegated.id);
    assert.equal(reported.tasks.find(task => task.key === 'agent').state, 'verifying');
    assert.equal(reported.tasks.find(task => task.key === 'verify').state, 'pending');
    assert.notEqual(reported.lifecycle, 'completed');

    const legacyChat = await conversation(),
      legacyRequest = randomUUID();
    const legacyInput = { title: 'Legacy outline', tasks: [{ key: 'read', title: 'Read the report' }] };
    const legacy = await plans.create(w.id, w.userId, legacyChat.chatId, legacyRequest, legacyInput);
    const { execution: _execution, planning: _planning, ...legacyCommand } = createPlanSchema.parse(legacyInput);
    const legacyDigest = createHash('sha256')
      .update(canonicalJson({ chatId: legacyChat.chatId, command: legacyCommand }))
      .digest('hex');
    await db.platform.query(`UPDATE ${table('tf_agent_plan_creations')} SET input_digest=$2 WHERE request_id=$1`, [
      legacyRequest,
      legacyDigest,
    ]);
    assert.deepEqual(
      await plans.create(w.id, w.userId, legacyChat.chatId, legacyRequest, legacyInput),
      legacy,
      'pre-Planning create digests remain replayable',
    );
    await assert.rejects(
      plans.create(w.id, w.userId, legacyChat.chatId, legacyRequest, { ...legacyInput, title: 'Different request' }),
      /idempotency-conflict/,
    );

    for (const outcome of [
      { kind: 'failed', code: 'credits-exhausted' },
      {
        kind: 'completed',
        result: 'The table ID was not provided.',
        sources: [],
        report: {
          outcome: 'blocked',
          summary: 'The table ID was not provided.',
          checks: [{ criterion: 0, outcome: 'unknown', summary: 'No live table could be inspected.' }],
        },
      },
    ]) {
      const blockedChat = await conversation();
      const blockedPlan = await plans.create(
        w.id,
        w.userId,
        blockedChat.chatId,
        randomUUID(),
        {
          title: 'Blocked worker check',
          planning: { ...specification, prerequisites: [] },
          specialists: [
            {
              key: 'reader',
              name: 'Reader',
              role: 'Read public facts',
              instructions: 'Check the requested facts.',
              tools: ['web.search'],
            },
          ],
          tasks: [{ ...tasks[0], assignee: { kind: 'specialist', specialist: 'reader' } }, tasks[1]],
        },
        blockedChat.turnId,
      );
      const startedWork = await scheduler.step(w.id, blockedPlan.id);
      await scheduler.settleSpecialist(w.id, startedWork.specialists[0], outcome, {
        toolCalls: 0,
        activeMilliseconds: 10,
      });
      await scheduler.step(w.id, blockedPlan.id);
      const blockedView = await plans.read(w.id, w.userId, blockedPlan.id);
      assert.equal(blockedView.tasks.find(task => task.key === 'agent').state, 'failed');
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS n FROM ${table('tf_agent_plan_attempts')} WHERE plan_id=$1`,
            [blockedPlan.id],
          )
        ).rows[0].n,
        1,
        'a deterministic blocker does not repeat the worker',
      );
      if (outcome.kind === 'failed') {
        assert.equal(blockedView.lifecycle, 'paused');
        assert.equal(blockedView.pause, 'budget');
      } else {
        assert.match(blockedView.tasks.find(task => task.key === 'agent').reason, /table ID/);
        assert.notEqual(blockedView.lifecycle, 'completed');
      }
    }
  },
);
