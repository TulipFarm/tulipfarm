import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import { createPlanDocumentStore } from '../src/plan-document-store.ts';

process.env.FEATURE_FLAG_PLAN_DOCUMENTS = 'true';

test(
  'an approved plan pauses for a starter change, keeps running through its own changes, and documents what changed since approval',
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
    const plans = createAgentPlans(runtime);
    const documents = createPlanDocumentStore(runtime);
    const names = async ids => new Map(ids.map(id => [id, 'Starter']));

    const chatId = randomUUID(),
      messageId = randomUUID(),
      turnId = randomUUID(),
      callId = randomUUID();
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
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'slack.resolve','completed')`,
      [callId, chatId, turnId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output) VALUES ($1,$2,$3,'[]',$4)`,
      [callId, turnId, { tool: 'slack.resolve' }, { result: { available: true, channel: 'C_SYNTHETIC' }, sources: [] }],
    );

    const prerequisite = {
      key: 'slack',
      title: 'Slack access',
      tasks: ['agent'],
      status: 'unknown',
      evidence: [],
      reason: 'Resolve the channel first.',
    };
    const planning = {
      requirements: [{ key: 'triage', description: 'An active triage agent', tasks: ['agent'] }],
      prerequisites: [prerequisite],
      verificationTask: 'verify',
    };
    const created = await plans.create(
      w.id,
      w.userId,
      chatId,
      randomUUID(),
      {
        title: 'Alert triage',
        planning,
        document: { summary: 'Set up alert triage.', risks: [{ risk: 'Noise', mitigation: 'Tune the filters.' }] },
        tasks: [
          { key: 'agent', title: 'Create the agent', assignee: { kind: 'coordinator' }, criteria: ['Agent is active'] },
          {
            key: 'verify',
            title: 'Verify the request',
            assignee: { kind: 'coordinator' },
            criteria: ['All requirements met'],
            dependsOn: ['agent'],
          },
        ],
      },
      turnId,
    );
    let view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.contentRevision, 1);
    assert.equal(view.document.summary, 'Set up alert triage.');
    assert.equal(view.approval, null);

    const draft = await documents.prepare(w.id, created.id, 'auto', names);
    assert.deepEqual([draft.revision, draft.generation], [1, 0]);
    assert.equal(draft.job.model.approval, null);
    assert.deepEqual(draft.job.model.changes, [], 'a plan never approved lists no changes');

    const approve = (revision, expectedVersion) =>
      plans.control(w.id, w.userId, created.id, {
        requestId: randomUUID(),
        action: 'approve',
        expectedVersion,
        contentRevision: revision,
        timeZone: 'Asia/Kolkata',
      });
    await approve(1, view.version);
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.lifecycle, 'active');
    assert.equal(view.approval.revision, 1);

    const approved = await documents.prepare(w.id, created.id, 'auto', names);
    assert.deepEqual([approved.revision, approved.generation], [1, 1], 'approval renders the revision again');
    assert.equal(approved.job.model.approval.revision, 1);
    assert.deepEqual(approved.job.model.changes, [], 'the first approval has no changes since approval');
    await documents.fail(w.id, created.id, approved, 'render');
    assert.equal(
      await documents.prepare(w.id, created.id, 'auto', names),
      null,
      'a failed rendering waits for a retry',
    );
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.documentRender.revision, 1);
    assert.equal(view.documentRender.status, 'failed');
    assert.equal(view.documentRender.error, 'render');
    assert.equal(view.documentRender.pageRevision, null, 'no page was ever drawn');
    assert.equal((await documents.prepare(w.id, created.id, 'retry', names)).generation, 1);
    await documents.fail(w.id, created.id, approved, 'too-large');
    assert.equal(
      await documents.retry(w.id, w.userId, created.id),
      null,
      'a revision too large to save is not rendered again',
    );

    // Verifying a prerequisite while running is the plan's own progress: a revision, but no new approval.
    await plans.update(w.id, w.userId, created.id, randomUUID(), {
      expectedVersion: view.version,
      planning: {
        ...planning,
        prerequisites: [
          { ...prerequisite, status: 'verified', evidence: [{ callId, summary: 'Read the live prerequisite.' }] },
        ],
      },
    });
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.contentRevision, 2);
    assert.equal(view.lifecycle, 'active');
    assert.equal(view.awaitingApproval, false);

    // Rewriting the document is the starter's change: it pauses the plan until that revision is approved.
    await plans.update(w.id, w.userId, created.id, randomUUID(), {
      expectedVersion: view.version,
      document: { summary: 'Set up alert triage for the support team.' },
    });
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.contentRevision, 3);
    assert.equal(view.lifecycle, 'paused');
    assert.equal(view.pause, 'awaiting-approval');
    assert.equal(view.awaitingApproval, true);
    assert.deepEqual(
      view.document.risks,
      [{ risk: 'Noise', mitigation: 'Tune the filters.' }],
      'an update keeps the sections it does not replace',
    );
    assert.deepEqual(
      view.changesSinceApproval.map(({ revision, changeKind }) => [revision, changeKind]),
      [
        [2, 'runtime'],
        [3, 'starter'],
      ],
    );
    await assert.rejects(
      plans.control(w.id, w.userId, created.id, {
        requestId: randomUUID(),
        action: 'resume',
        expectedVersion: view.version,
      }),
      /approval-required/,
    );

    const changed = await documents.prepare(w.id, created.id, 'auto', names);
    assert.deepEqual([changed.revision, changed.generation], [3, 1]);
    assert.equal(changed.job.model.approval.revision, 1);
    const origins = changed.job.model.changes.map(change => change.origin);
    assert.ok(origins.includes('runtime') && origins.includes('starter'), JSON.stringify(changed.job.model.changes));
    assert.deepEqual(
      origins,
      [...origins].sort((a, b) => (a === b ? 0 : a === 'runtime' ? -1 : 1)),
      'each step since the approved revision is listed in order, with who made it',
    );

    await assert.rejects(approve(2, view.version), /revision-conflict/, 'an older revision cannot be approved');
    await approve(3, view.version);
    view = await plans.read(w.id, w.userId, created.id);
    assert.equal(view.lifecycle, 'active');
    assert.equal(view.approval.revision, 3);
    assert.deepEqual(view.changesSinceApproval, []);
    const reapproved = await documents.prepare(w.id, created.id, 'auto', names);
    assert.deepEqual([reapproved.revision, reapproved.generation], [3, 2]);
    assert.deepEqual(reapproved.job.model.changes, [], 'changes are listed since the latest approval only');
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT revision, generation, status FROM ${table('tf_agent_plan_documents')} WHERE plan_id=$1 ORDER BY revision, generation`,
          [created.id],
        )
      ).rows,
      [
        { revision: 1, generation: 0, status: 'failed' },
        { revision: 1, generation: 1, status: 'failed' },
        { revision: 3, generation: 1, status: 'failed' },
        { revision: 3, generation: 2, status: 'rendering' },
      ],
      'renderings that never finished are superseded by the newest',
    );
  },
);
