import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, denied } from './fixture.mjs';
import { commonTables } from '../../src/provisioning.ts';

test(
  'event storage enforces dedupe, bounded retention and immutable admission identity',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      const workspace = await db.create(),
        table = name => `"${workspace.names.schema}"."${name}"`;
      runtime = await connect(db.login(workspace));
      const workflowId = randomUUID(),
        revision = randomUUID(),
        sourceId = randomUUID(),
        deliveryId = randomUUID(),
        eventId = randomUUID();
      await db.platform.query('BEGIN');
      await db.platform.query(`INSERT INTO ${table('tf_workflows')}(id,revision) VALUES($1,$2)`, [
        workflowId,
        revision,
      ]);
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_revisions')}(workflow_id,id,definition,author_membership_id)
      VALUES($1,$2,'{}',$3)`,
        [workflowId, revision, workspace.membershipId],
      );
      await db.platform.query('COMMIT');
      await runtime.query(
        `INSERT INTO ${table(commonTables.githubEventSources)}
      (id,app_id,installation_id,account_id,account_kind,membership_id,status)
      VALUES($1,'100','200','300','organization',$2,'pending')`,
        [sourceId, workspace.membershipId],
      );
      const insert = (id, delivery, days) =>
        runtime.query(
          `INSERT INTO ${table(commonTables.workflowAutomationEvents)}
      (id,source_id,source_generation,delivery_id,body_digest,workflow_id,revision,input,received_at,expires_at,status)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,'2026-10-13T00:00:00Z','2026-10-13T00:00:00Z'::timestamptz+$8*interval '24 hours','pending')`,
          [
            id,
            sourceId,
            delivery,
            'a'.repeat(64),
            workflowId,
            revision,
            { 'pullRequest.title': 'Private fixture title' },
            days,
          ],
        );
      await insert(eventId, deliveryId, 30);
      await assert.rejects(insert(randomUUID(), deliveryId, 30), error => error.code === '23505');
      await assert.rejects(insert(randomUUID(), randomUUID(), 31), error => error.code === '23514');
      await denied(runtime, `UPDATE ${table(commonTables.workflowAutomationEvents)} SET received_at=clock_timestamp()`);
      await denied(runtime, `UPDATE ${table(commonTables.workflowAutomationEvents)} SET expires_at=clock_timestamp()`);
      await denied(runtime, `UPDATE ${table(commonTables.workflowAutomationEvents)} SET body_digest=$1`, [
        'b'.repeat(64),
      ]);
      await assert.rejects(
        runtime.query(`UPDATE ${table(commonTables.workflowAutomationEvents)} SET status='expired' WHERE id=$1`, [
          eventId,
        ]),
        error => error.code === '23514',
      );
      await assert.rejects(
        runtime.query(`UPDATE ${table(commonTables.workflowAutomationEvents)} SET status='admitted' WHERE id=$1`, [
          eventId,
        ]),
        error => error.code === '23514',
      );
      const otherRevision = randomUUID(),
        wrongRun = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_revisions')}(workflow_id,id,definition,author_membership_id)
      VALUES($1,$2,'{}',$3)`,
        [workflowId, otherRevision, workspace.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_workflow_runs')}(id,workflow_id,revision,request_key,input)
      VALUES($1,$2,$3,'fixture-wrong-revision','{}')`,
        [wrongRun, workflowId, otherRevision],
      );
      await assert.rejects(
        runtime.query(
          `UPDATE ${table(commonTables.workflowAutomationEvents)} SET status='admitted',run_id=$1 WHERE id=$2`,
          [wrongRun, eventId],
        ),
        error => error.code === '23503',
        'admission cannot point to a run from another revision',
      );
      await runtime.query(
        `UPDATE ${table(commonTables.workflowAutomationEvents)} SET status='expired',input=NULL,error='event-expired' WHERE id=$1`,
        [eventId],
      );
      const expired = (
        await runtime.query(`SELECT * FROM ${table(commonTables.workflowAutomationEvents)} WHERE id=$1`, [eventId])
      ).rows[0];
      assert.equal(expired.input, null);
      assert.equal(expired.delivery_id, deliveryId);
      assert.equal(expired.error, 'event-expired');
      assert.equal(JSON.stringify(expired).includes('Private fixture title'), false);
      await assert.rejects(
        insert(randomUUID(), deliveryId, 30),
        error => error.code === '23505',
        'expiry retains dedupe identity',
      );
    } finally {
      await runtime?.end();
      await db.close();
    }
  },
);
