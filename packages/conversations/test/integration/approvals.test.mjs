import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { approvalFixture } from '../approval-fixture.mjs';
import { createConversationExecutor } from '../../src/runtime.ts';
import { reverseReply } from '../fixture.mjs';
import { createInternalConversations } from '../../src/internal.ts';
import { AccessDenied } from '@tulipfarm/access';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createTableApprovalResolver } from '../../../tables/dist/conversation-approvals.js';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test(
  'protected approval and rejection compete for one immutable domain winner and wake once',
  { timeout: 60000 },
  async () => {
    const f = await approvalFixture();
    try {
      const w = f.workspace,
        item = await f.pending();
      assert.deepEqual(await f.requests.create(item.fence, item.input), { requestId: item.requestId, revision: 1 });
      const approve = { commandId: randomUUID(), expectedRevision: 1, decision: 'approve' },
        reject = { commandId: randomUUID(), expectedRevision: 1, decision: 'reject' };
      const results = await Promise.allSettled([
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, approve),
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, reject),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results));
      const result = results.find(result => result.status === 'fulfilled').value;
      assert.deepEqual(
        await f.resolver.decide(
          w.id,
          w.userId,
          item.conversationId,
          item.requestId,
          result.status === 'approved' ? approve : reject,
        ),
        result,
      );
      assert.equal(
        (await f.requests.read(w.id, w.userId, item.conversationId, item.requestId)).resolution.status,
        result.status,
      );
      assert.deepEqual(
        (
          await f.db.platform.query(`SELECT status,generation FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [
            item.fence.origin.turnId,
          ])
        ).rows,
        [{ status: 'queued', generation: 1 }],
      );
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::int AS n FROM ${f.table('tf_conversation_approval_resolutions')}`))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await f.maintenance.execute(w.id, item.migrationId)).status,
        result.status === 'approved' ? 'applied' : 'rejected',
      );
      for (const sql of [
        `INSERT INTO ${f.table('tf_conversation_approval_resolutions')} (request_id) VALUES ('${randomUUID()}')`,
        `UPDATE ${f.table('tf_conversation_approval_resolutions')} SET resolution='approved'`,
        `DELETE FROM ${f.table('tf_conversation_approval_resolutions')}`,
        `UPDATE ${f.table('tf_conversation_approval_requests')} SET plan_digest='forged'`,
      ])
        await assert.rejects(
          f.runtime.transaction(w.id, commonCompatibility, tx => tx.client.query(sql)),
          error => error.code === '42501',
        );
      const protectedLogin = await connect(f.db.login(w, 'confirmation'));
      try {
        await assert.rejects(
          protectedLogin.query(`UPDATE ${f.table('tf_conversation_approval_resolutions')} SET resolution='rejected'`),
          error => error.code === '42501',
        );
        await assert.rejects(
          protectedLogin.query(`DELETE FROM ${f.table('tf_conversation_approval_resolutions')}`),
          error => error.code === '42501',
        );
      } finally {
        await protectedLogin.end();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'current action authority, private incarnation, exact replay and atomic rollback protect approval',
  { timeout: 60000 },
  async () => {
    const f = await approvalFixture();
    try {
      const w = f.workspace,
        item = await f.pending(),
        table = f.table;
      const body = { commandId: randomUUID(), expectedRevision: 1, decision: 'approve' };
      const reusedCommand = randomUUID();
      await f.store.rename(w.id, w.userId, item.conversationId, {
        commandId: reusedCommand,
        expectedRevision: 1,
        title: 'Approval',
      });
      await assert.rejects(
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, { ...body, commandId: reusedCommand }),
        error => error.code === 'command-conflict',
      );
      const admin = randomUUID();
      await f.db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        admin,
      ]);
      await assert.rejects(f.resolver.decide(w.id, admin, item.conversationId, item.requestId, body), AccessDenied);
      await f.humanAuthority(item.tableId, false);
      await assert.rejects(f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body), AccessDenied);
      await f.humanAuthority(item.tableId, true);
      const revokedDuringResolution = createTableApprovalResolver({
        runtime: f.runtime,
        resolveConfirmationCredential: async () => {
          await f.humanAuthority(item.tableId, false);
          return f.db.login(w, 'confirmation');
        },
      });
      await assert.rejects(
        revokedDuringResolution.decide(w.id, w.userId, item.conversationId, item.requestId, body),
        AccessDenied,
      );
      await f.humanAuthority(item.tableId, true);
      await f.db.platform.query(`REVOKE INSERT ON ${table('tf_conversation_parts')} FROM "${w.names.confirmation}"`);
      await assert.rejects(
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body),
        error => error.code === '42501',
      );
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_confirmations')} WHERE migration_id=$1`,
            [item.migrationId],
          )
        ).rows,
        [{ n: 0 }],
      );
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('tf_conversation_approval_resolutions')} WHERE request_id=$1`,
            [item.requestId],
          )
        ).rows,
        [{ n: 0 }],
      );
      await f.db.platform.query(`GRANT INSERT ON ${table('tf_conversation_parts')} TO "${w.names.confirmation}"`);
      const result = await f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body);
      assert.equal(result.status, 'approved');
      await assert.rejects(
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, { ...body, decision: 'reject' }),
        error => error.code === 'request-conflict',
      );
      const executor = createConversationExecutor(f.runtime, reverseReply),
        work = (await executor.due(w.id))[0],
        reply = await executor.claim(work);
      const fence = await createInternalConversations(f.runtime).claim({
        workspaceId: w.id,
        runId: item.fence.runId,
        ownerId: item.fence.ownerId,
        origin: {
          kind: 'linked',
          conversationId: item.conversationId,
          turnId: reply.turnId,
          generation: reply.generation,
          epoch: reply.epoch,
        },
      });
      assert.deepEqual(await f.requests.readForRuntime(fence, item.requestId), result);
      await assert.rejects(f.requests.readForRuntime(item.fence, item.requestId));
      await f.db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      await assert.rejects(f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body));
      await f.db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        w.userId,
      ]);
      await assert.rejects(f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body));
    } finally {
      await f.close();
    }
  },
);

test(
  'fresh workspaces preserve immutable protected winners and deny cross-workspace SQL',
  { timeout: 60000 },
  async () => {
    const f = await approvalFixture();
    let runtime, confirmation;
    try {
      const other = await f.db.create(f.stream);
      runtime = await connect(f.db.login(other));
      confirmation = await connect(f.db.login(other, 'confirmation'));
      const relation = `"${other.names.schema}".tf_conversation_approval_resolutions`;
      await assert.rejects(
        runtime.query(`INSERT INTO ${relation} (request_id) VALUES ($1)`, [randomUUID()]),
        error => error.code === '42501',
      );
      await assert.rejects(
        confirmation.query(`UPDATE ${relation} SET resolution='approved'`),
        error => error.code === '42501',
      );
      await assert.rejects(
        runtime.query(`SELECT * FROM ${f.table('tf_conversation_approval_resolutions')}`),
        error => error.code === '42501',
      );
      assert.deepEqual(
        (await runtime.query(`SELECT name,checksum FROM "${other.names.schema}".tf_common_migrations ORDER BY name`))
          .rows,
        f.stream.map(({ name, checksum }) => ({ name, checksum })),
      );
    } finally {
      await runtime?.end();
      await confirmation?.end();
      await f.close();
    }
  },
);

test('cancellation and changed proposals never create an executable receipt', { timeout: 60000 }, async () => {
  const f = await approvalFixture();
  try {
    const w = f.workspace,
      item = await f.pending(),
      body = { commandId: randomUUID(), expectedRevision: 1, decision: 'approve' };
    await f.db.platform.query(`UPDATE ${f.table('tf_migration_jobs')} SET plan_digest=$2 WHERE id=$1`, [
      item.migrationId,
      'f'.repeat(64),
    ]);
    await assert.rejects(
      f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body),
      error => error.code === 'stale-plan',
    );
    const cancelled = await f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, {
      ...body,
      decision: 'cancel',
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(
      await f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, { ...body, decision: 'cancel' }),
      cancelled,
    );
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS n FROM ${f.table('tf_confirmations')} WHERE migration_id=$1`,
          [item.migrationId],
        )
      ).rows,
      [{ n: 0 }],
    );
  } finally {
    await f.close();
  }
});

test('expiry and cancellation cannot approve a bound decision', { timeout: 60000 }, async () => {
  const f = await approvalFixture();
  try {
    const w = f.workspace,
      item = await f.pending();
    await f.db.platform.query(
      `UPDATE ${f.table('tf_conversation_approval_requests')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [item.requestId],
    );
    const results = await Promise.allSettled([
      f.resolver.expire(w.id, item.requestId),
      f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, {
        commandId: randomUUID(),
        expectedRevision: 1,
        decision: 'approve',
      }),
    ]);
    assert.equal(
      results.some(result => result.status === 'fulfilled' && result.value.status === 'expired'),
      true,
    );
    assert.equal(
      (await f.requests.read(w.id, w.userId, item.conversationId, item.requestId)).resolution.status,
      'expired',
    );
    assert.equal(
      (
        await f.db.platform.query(
          `SELECT count(*)::int AS n FROM ${f.table('tf_confirmations')} WHERE migration_id=$1`,
          [item.migrationId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await f.maintenance.execute(w.id, item.migrationId)).status, 'waiting_for_confirmation');
  } finally {
    await f.close();
  }
});

test(
  'rejection commits its domain control with the winner and cannot be overwritten by approval',
  { timeout: 60000 },
  async () => {
    const f = await approvalFixture();
    try {
      const w = f.workspace,
        item = await f.pending(),
        body = { commandId: randomUUID(), expectedRevision: 1, decision: 'reject' };
      const result = await f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(await f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, body), result);
      await assert.rejects(
        f.resolver.decide(w.id, w.userId, item.conversationId, item.requestId, {
          ...body,
          commandId: randomUUID(),
          decision: 'approve',
        }),
        error => error.code === 'request-conflict',
      );
      assert.equal((await f.maintenance.execute(w.id, item.migrationId)).status, 'rejected');
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT count(*)::int AS n FROM ${f.table('tf_confirmations')} WHERE migration_id=$1`,
            [item.migrationId],
          )
        ).rows,
        [{ n: 0 }],
      );
    } finally {
      await f.close();
    }
  },
);
