import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility, createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAutomationSetup } from '../src/automation-setup.ts';
import { automationApprovalDigest } from '../src/automation.ts';

async function setupFixture() {
  const db = await fixture();
  let runtime;
  try {
    const w = await db.create(),
      table = name => qualified(w.names.schema, name);
    const workflowId = randomUUID(),
      revision = randomUUID(),
      sourceId = randomUUID(),
      installationId = randomUUID(),
      destinationId = randomUUID();
    await db.platform.query('BEGIN');
    await db.platform.query(`INSERT INTO ${table('tf_workflows')}(id,revision) VALUES($1,$2)`, [workflowId, revision]);
    await db.platform.query(
      `INSERT INTO ${table('tf_workflow_revisions')}(workflow_id,id,definition,author_membership_id)
      VALUES($1,$2,$3,$4)`,
      [workflowId, revision, { version: 1, name: 'Fixture', trigger: { kind: 'manual' }, steps: [] }, w.membershipId],
    );
    await db.platform.query(
      `UPDATE ${table('tf_workflows')} SET sponsor_membership_id=$3,sponsorship_revision=$2,sponsorship_id=$4
      WHERE id=$1`,
      [workflowId, revision, w.membershipId, randomUUID()],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_workflow_grants')}(workflow_id,membership_id,permission)
      SELECT $1,$2,unnest(ARRAY['read','manage','invoke'])`,
      [workflowId, w.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_github_event_sources')}
      (id,app_id,installation_id,account_id,account_kind,membership_id,status,verified_at)
      VALUES($1,'100','200','300','organization',$2,'active',clock_timestamp())`,
      [sourceId, w.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_github_event_source_grants')}(source_id,membership_id,permission,granted_by)
      SELECT $1,$2,unnest(ARRAY['use','share']),$2`,
      [sourceId, w.membershipId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_installations')}
      (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after)
      VALUES($1,'A123','T123','U123',1,'active','{}','{}',0)`,
      [installationId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_slack_destinations')}(id,installation_id,generation,channel,name)
      VALUES($1,$2,1,'C123','Fixture')`,
      [destinationId, installationId],
    );
    await db.platform.query('COMMIT');
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const input = {
      commandId: randomUUID(),
      workflowId,
      expectedRevision: revision,
      expectedVersion: 0,
      setup: {
        source: {
          kind: 'github',
          sourceId,
          generation: 1,
          repositories: { kind: 'repositories', repositoryIds: ['10'] },
          events: [{ event: 'pull_request', actions: ['opened'] }],
          baseBranches: { kind: 'all' },
          headBranches: { kind: 'all' },
        },
        destination: {
          kind: 'slack',
          destinationId,
          installationId,
          generation: 1,
          version: 1,
          channelId: 'C123',
          sender: 'app',
        },
        template: { fields: ['pullRequest.title'], parts: [{ kind: 'field', field: 'pullRequest.title' }] },
        messagesPerHour: 100,
      },
    };
    const calls = [];
    const verification = {
      source: async (_workspaceId, actor, setup, privateExport) => {
        calls.push('source');
        assert.equal(actor.membershipId, w.membershipId);
        assert.equal(setup.source.sourceId, sourceId);
        if (!privateExport) throw new AccessDenied();
      },
      destination: async (_workspaceId, actor, setup) => {
        calls.push('destination');
        assert.equal(actor.membershipId, w.membershipId);
        assert.equal(setup.destination.destinationId, destinationId);
      },
    };
    const service = createAutomationSetup(runtime, verification);
    const decision = draft => ({
      commandId: randomUUID(),
      version: draft.version,
      digest: draft.digest,
      decision: 'approve',
      privateRepositoryExport: true,
    });
    return {
      db,
      w,
      table,
      workflowId,
      revision,
      sourceId,
      destinationId,
      runtime,
      input,
      calls,
      verification,
      service,
      decision,
      close: async () => {
        await runtime.close();
        await db.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    await db.close();
    throw error;
  }
}

test(
  'automation drafts and review receipts survive retries without repeating approval or restoring revocation',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const { service, w, input, workflowId, table, db } = f;
      const [draft, replay] = await Promise.all([
        service.saveDraft(w.id, w.userId, input),
        service.saveDraft(w.id, w.userId, input),
      ]);
      assert.deepEqual(replay, draft);
      assert.deepEqual(await service.readDraft(w.id, w.userId, workflowId), draft);
      assert.deepEqual(f.calls, [], 'saving and reading never approve or contact a provider');
      await assert.rejects(
        service.saveDraft(w.id, w.userId, { ...input, setup: { ...input.setup, messagesPerHour: 101 } }),
        /command-conflict/,
      );
      await assert.rejects(
        service.saveDraft(w.id, w.userId, { ...input, commandId: randomUUID() }),
        /automation-draft-stale/,
      );
      const decision = f.decision(draft);
      const [receipt, duplicate] = await Promise.all([
        service.decide(w.id, w.userId, workflowId, decision),
        service.decide(w.id, w.userId, workflowId, decision),
      ]);
      assert.deepEqual(duplicate, receipt);
      const verificationCalls = [...f.calls];
      const sourceCalls = f.calls.filter(call => call === 'source').length;
      assert.ok(
        sourceCalls >= 1 && sourceCalls <= 2,
        'concurrent retries may repeat read-only checks before either commits',
      );
      assert.equal(f.calls.filter(call => call === 'destination').length, sourceCalls);
      const [grant] = (await db.platform.query(`SELECT * FROM ${table('tf_workflow_automation_grants')}`)).rows;
      assert.equal(grant.id, receipt.grantId);
      assert.equal(grant.digest, automationApprovalDigest(grant.approval));
      assert.equal(grant.membership_id, w.membershipId);
      assert.equal(grant.sharing_membership_id, w.membershipId);
      assert.equal(grant.sponsorship_id, grant.approval.sponsorshipId);
      assert.equal(grant.messages_per_hour, 100);
      assert.equal(grant.private_repository_export, true);
      assert.equal(
        (await db.platform.query(`SELECT enabled FROM ${table('tf_workflows')} WHERE id=$1`, [workflowId])).rows[0]
          .enabled,
        false,
      );
      assert.equal(receipt.grantDigest, grant.digest);
      const revoke = { commandId: randomUUID(), digest: receipt.grantDigest };
      await db.platform.query(`DELETE FROM ${table('tf_github_event_source_grants')} WHERE source_id=$1`, [f.sourceId]);
      await assert.rejects(service.readDraft(w.id, w.userId, workflowId), AccessDenied);
      await service.revoke(w.id, w.userId, grant.id, revoke);
      await service.revoke(w.id, w.userId, grant.id, revoke);
      await db.platform.query(
        `INSERT INTO ${table('tf_github_event_source_grants')}(source_id,membership_id,permission,granted_by)
      SELECT $1,$2,unnest(ARRAY['use','share']),$2`,
        [f.sourceId, w.membershipId],
      );
      const restarted = createAutomationSetup(f.runtime, f.verification);
      assert.deepEqual(await restarted.decide(w.id, w.userId, workflowId, decision), receipt);
      assert.deepEqual((await restarted.readDraft(w.id, w.userId, workflowId)).decision, receipt);
      assert.notEqual((await restarted.readDraft(w.id, w.userId, workflowId)).grantRevokedAt, null);
      await assert.rejects(
        restarted.decide(w.id, w.userId, workflowId, { ...decision, commandId: randomUUID() }),
        /automation-already-reviewed/,
      );
      assert.deepEqual(f.calls, verificationCalls);
      assert.notEqual(
        (
          await db.platform.query(`SELECT revoked_at FROM ${table('tf_workflow_automation_grants')} WHERE id=$1`, [
            grant.id,
          ])
        ).rows[0].revoked_at,
        null,
      );
      await assert.rejects(
        service.decide(w.id, w.userId, workflowId, { ...decision, privateRepositoryExport: false }),
        /command-conflict/,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer n FROM ${table('tf_audit_events')} WHERE operation='workflow.automation.approve'`,
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer n FROM ${table('tf_audit_events')} WHERE operation='workflow.automation.revoke'`,
          )
        ).rows[0].n,
        1,
      );
      const client = await connect(db.login(w));
      try {
        await denied(client, `UPDATE ${table('tf_workflow_automation_decisions')} SET decision='reject'`);
        await denied(client, `DELETE FROM ${table('tf_workflow_automation_decisions')}`);
        await denied(client, `UPDATE ${table('tf_workflow_automation_grants')} SET sponsorship_id=$1`, [randomUUID()]);
        await assert.rejects(
          client.query(
            `INSERT INTO ${table('tf_workflow_automation_decisions')}
        (command_id,workflow_id,membership_id,version,digest,decision,private_repository_export,grant_id)
        VALUES($1,$2,$3,1,$4,'approve',true,NULL)`,
            [randomUUID(), workflowId, w.membershipId, draft.digest],
          ),
          error => error.code === '23514',
        );
      } finally {
        await client.end();
      }
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      await assert.rejects(restarted.decide(w.id, w.userId, workflowId, decision), AccessDenied);
    } finally {
      await f.close();
    }
  },
);

test(
  'new drafts fence stale review; exact rejection is durable and never creates a send grant',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const { service, w, input, workflowId, table, db } = f;
      const first = await service.saveDraft(w.id, w.userId, input);
      const second = await service.saveDraft(w.id, w.userId, {
        ...input,
        commandId: randomUUID(),
        expectedVersion: 1,
        setup: { ...input.setup, messagesPerHour: 20 },
      });
      await assert.rejects(service.decide(w.id, w.userId, workflowId, f.decision(first)), /stale-generation/);
      await assert.rejects(
        service.decide(w.id, w.userId, workflowId, { ...f.decision(second), digest: first.digest }),
        /automation-digest-conflict/,
      );
      const reject = { ...f.decision(second), decision: 'reject', privateRepositoryExport: false };
      const receipt = await service.decide(w.id, w.userId, workflowId, reject);
      assert.equal(receipt.grantId, null);
      assert.deepEqual(await service.decide(w.id, w.userId, workflowId, reject), receipt);
      assert.deepEqual((await service.readDraft(w.id, w.userId, workflowId)).decision, receipt);
      await assert.rejects(
        service.decide(w.id, w.userId, workflowId, f.decision(second)),
        /automation-already-reviewed/,
      );
      assert.deepEqual(f.calls, []);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer n FROM ${table('tf_workflow_automation_grants')}`)).rows[0]
          .n,
        0,
      );
      await assert.rejects(
        service.decide(w.id, w.userId, workflowId, { ...reject, decision: 'approve' }),
        /command-conflict/,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'approval requires current source sharing, sponsor, provider verification and exact destination',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const { service, w, input, workflowId, table, db } = f;
      const draft = await service.saveDraft(w.id, w.userId, input),
        decision = f.decision(draft);
      await assert.rejects(
        service.decide(w.id, w.userId, workflowId, { ...decision, privateRepositoryExport: false }),
        AccessDenied,
      );
      await db.platform.query(
        `DELETE FROM ${table('tf_github_event_source_grants')} WHERE source_id=$1 AND permission='share'`,
        [f.sourceId],
      );
      await assert.rejects(service.decide(w.id, w.userId, workflowId, decision), AccessDenied);
      await db.platform.query(
        `INSERT INTO ${table('tf_github_event_source_grants')}(source_id,membership_id,permission,granted_by) VALUES($1,$2,'share',$2)`,
        [f.sourceId, w.membershipId],
      );
      await db.platform.query(`UPDATE ${table('tf_slack_destinations')} SET version=2 WHERE id=$1`, [f.destinationId]);
      await assert.rejects(service.decide(w.id, w.userId, workflowId, decision), /automation-destination-stale/);
      await db.platform.query(`UPDATE ${table('tf_slack_destinations')} SET version=1 WHERE id=$1`, [f.destinationId]);
      await db.platform.query(
        `DELETE FROM ${table('tf_workflow_grants')} WHERE workflow_id=$1 AND permission='invoke'`,
        [workflowId],
      );
      await assert.rejects(service.decide(w.id, w.userId, workflowId, decision), AccessDenied);
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_grants')}(workflow_id,membership_id,permission) VALUES($1,$2,'invoke')`,
        [workflowId, w.membershipId],
      );
      const providerError = new Error('slack-membership-required');
      const blocked = createAutomationSetup(f.runtime, {
        ...f.verification,
        destination: async () => {
          throw providerError;
        },
      });
      await assert.rejects(blocked.decide(w.id, w.userId, workflowId, decision), error => error === providerError);
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::integer n FROM ${table('tf_workflow_commands')} WHERE id=$1`, [
            decision.commandId,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer n FROM ${table('tf_workflow_automation_grants')}`)).rows[0]
          .n,
        0,
      );
      await service.decide(w.id, w.userId, workflowId, decision);
      const next = await service.saveDraft(w.id, w.userId, {
        ...input,
        commandId: randomUUID(),
        expectedVersion: 1,
        setup: { ...input.setup, messagesPerHour: 20 },
      });
      await service.decide(w.id, w.userId, workflowId, f.decision(next));
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT messages_per_hour FROM ${table('tf_workflow_automation_grants')} WHERE revoked_at IS NULL`,
          )
        ).rows,
        [{ messages_per_hour: 20 }],
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'workspace admin status does not reveal another member draft or bypass source access',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const { service, w, input, workflowId, table, db } = f;
      const draft = await service.saveDraft(w.id, w.userId, input);
      const otherId = randomUUID(),
        otherUser = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'admin')`, [
        otherId,
        otherUser,
      ]);
      await assert.rejects(service.readDraft(w.id, otherUser, workflowId), AccessDenied);
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_grants')}(workflow_id,membership_id,permission) VALUES($1,$2,'manage')`,
        [workflowId, otherId],
      );
      assert.equal(await service.readDraft(w.id, otherUser, workflowId), null);
      await assert.rejects(service.decide(w.id, otherUser, workflowId, f.decision(draft)), AccessDenied);
      await assert.rejects(service.saveDraft(w.id, otherUser, { ...input, commandId: randomUUID() }), AccessDenied);
      await db.platform.query(`UPDATE ${table('tf_github_event_sources')} SET generation=2 WHERE id=$1`, [f.sourceId]);
      await assert.rejects(service.readDraft(w.id, w.userId, workflowId), /automation-source-stale/);
      await assert.rejects(service.decide(w.id, w.userId, workflowId, f.decision(draft)), /automation-source-stale/);
      assert.deepEqual(f.calls, []);
    } finally {
      await f.close();
    }
  },
);

test(
  'review rechecks bindings after provider verification and stale workflow revisions cannot be approved',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const { service, w, input, workflowId, table, db } = f;
      const draft = await service.saveDraft(w.id, w.userId, input),
        decision = f.decision(draft);
      const changedDuringCheck = createAutomationSetup(f.runtime, {
        ...f.verification,
        destination: async () => {
          await db.platform.query(`UPDATE ${table('tf_slack_destinations')} SET version=version+1 WHERE id=$1`, [
            f.destinationId,
          ]);
        },
      });

      await assert.rejects(
        changedDuringCheck.decide(w.id, w.userId, workflowId, decision),
        /automation-destination-stale/,
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer n FROM ${table('tf_workflow_automation_grants')}`)).rows[0]
          .n,
        0,
      );
      const nextRevision = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_revisions')}(workflow_id,id,definition,author_membership_id)
      VALUES($1,$2,'{}',$3)`,
        [workflowId, nextRevision, w.membershipId],
      );
      await db.platform.query(`UPDATE ${table('tf_workflows')} SET revision=$2 WHERE id=$1`, [
        workflowId,
        nextRevision,
      ]);
      await assert.rejects(service.decide(w.id, w.userId, workflowId, decision), /automation-revision-stale/);
      await assert.rejects(
        service.saveDraft(w.id, w.userId, { ...input, commandId: randomUUID(), expectedVersion: 1 }),
        /automation-revision-stale/,
      );
    } finally {
      await f.close();
    }
  },
);

test('provider verification releases the workspace authorization lock', { timeout: 60000 }, async () => {
  const f = await setupFixture();
  try {
    const draft = await f.service.saveDraft(f.w.id, f.w.userId, f.input);
    const service = createAutomationSetup(f.runtime, {
      ...f.verification,
      source: async () => {
        await f.runtime.transaction(f.w.id, { ...commonCompatibility, minimum: 1 }, async tx => {
          await tx.client.query("SET LOCAL lock_timeout='100ms'");
          await lockAuthorization(tx, 'write');
        });
      },
    });
    const receipt = await service.decide(f.w.id, f.w.userId, f.workflowId, f.decision(draft));
    assert.equal(receipt.decision, 'approve');
  } finally {
    await f.close();
  }
});

test(
  'sponsorship and membership changes during provider verification prevent approval',
  { timeout: 60000 },
  async () => {
    const f = await setupFixture();
    try {
      const draft = await f.service.saveDraft(f.w.id, f.w.userId, f.input),
        decision = f.decision(draft);
      const changedSponsor = createAutomationSetup(f.runtime, {
        ...f.verification,
        destination: async () => {
          await f.db.platform.query(`UPDATE ${f.table('tf_workflows')} SET sponsorship_id=$2 WHERE id=$1`, [
            f.workflowId,
            randomUUID(),
          ]);
        },
      });
      await assert.rejects(
        changedSponsor.decide(f.w.id, f.w.userId, f.workflowId, decision),
        /automation-sponsorship-stale/,
      );
      const removedMember = createAutomationSetup(f.runtime, {
        ...f.verification,
        destination: async () => {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`,
            [f.w.membershipId],
          );
        },
      });
      await assert.rejects(removedMember.decide(f.w.id, f.w.userId, f.workflowId, decision), AccessDenied);
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::integer n FROM ${f.table('tf_workflow_automation_grants')}`))
          .rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
