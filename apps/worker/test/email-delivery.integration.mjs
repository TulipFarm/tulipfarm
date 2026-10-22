import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fixture, connect, denied } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { createGovernanceService } from '@tulipfarm/workspaces/governance';
import { createEmailDeliveryStore, decryptEmailDelivery } from '@tulipfarm/workspaces/email-delivery';
import { createEmailDeliveryComposition } from '../dist/email-delivery-composition.js';
import { teardownDisposableWorkspace } from '../../database/src/workspace-operations-lifecycle.ts';
import {
  backupDisposableWorkspace,
  inspectWorkspaceSnapshot,
  restoreDisposableWorkspace,
} from '../../database/src/workspace-operations-recovery.ts';
import { createWorkspaceMember } from '../../../packages/tables/test/fixture.mjs';

function payloadText(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(payloadText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(payloadText).join('\n');
  return typeof value === 'string' ? value : '';
}
async function eventually(read, accepts) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (accepts(value)) return value;
    await setTimeout(50);
  }
  assert.fail('Delivery did not converge');
}

test(
  'encrypted outbox commits atomically, enforces workspace isolation and recovers dispatch with ID-only Temporal history',
  { timeout: 90000 },
  async () => {
    const env = { ...process.env };
    const f = await fixture();
    const keys = { keyId: 'test-v1', key: randomBytes(32), previous: new Map() };
    const role = `email_test_${randomUUID().replaceAll('-', '')}`;
    let runtime, pool, composition, connection, native, worker, running;
    const captured = [];
    try {
      await f.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const migrations = f.baseline;
      const a = await f.create(migrations);
      const b = await f.create(migrations);
      await f.platform.query(
        "UPDATE app.workspaces SET name = CASE id WHEN $1 THEN 'Delivery workspace' ELSE 'Other workspace' END WHERE id IN ($1, $2)",
        [a.id, b.id],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        connectionsPerPool: 3,
        resolveCredential: async id => ({
          workspaceId: id,
          generation: 1,
          connectionString: f.login(f.workspaces.find(w => w.id === id)),
        }),
      });
      const governance = createGovernanceService({
        runtime,
        identity: f.platform,
        compatibility: { minimum: migrations.length, maximum: migrations.length },
        emailDelivery: { keys, webOrigin: 'http://localhost:5173' },
      });
      const recipient = await createWorkspaceMember({
        runtime,
        workspace: a,
        profile: { name: 'Recipient', contactEmail: 'recipient@example.com' },
      });
      const input = {
        kind: 'email',
        email: 'recipient@example.com',
        requestId: randomUUID(),
        workspaceMemberId: recipient.id,
      };
      const first = await governance.createInvitation(a.id, a.userId, input);
      assert.equal(first.outcome, 'created');
      assert.equal(first.invitation.delivery, 'pending');
      assert.equal((await governance.createInvitation(a.id, a.userId, input)).invitation.id, first.invitation.id);
      await assert.rejects(governance.createInvitation(a.id, a.userId, { ...input, email: 'different@example.com' }));
      const row = async id =>
        (await f.platform.query('SELECT * FROM app.email_deliveries WHERE id = $1', [id])).rows[0];
      const firstRow = await row(first.invitation.id);
      const firstPayload = decryptEmailDelivery(firstRow.id, firstRow.payload, keys);
      assert.equal(firstPayload.email, 'recipient@example.com');
      assert.equal(firstPayload.workspaceName, 'Delivery workspace');
      assert.equal(firstPayload.expiresAt, first.invitation.expiresAt);
      assert.equal((await governance.copyInvitation(a.id, a.userId, first.invitation.id)).url, firstPayload.url);
      const changedOrigin = createGovernanceService({
        runtime,
        identity: f.platform,
        compatibility: { minimum: migrations.length, maximum: migrations.length },
        emailDelivery: { keys, webOrigin: 'https://changed.example' },
      });
      assert.equal((await changedOrigin.copyInvitation(a.id, a.userId, first.invitation.id)).url, firstPayload.url);
      assert.equal(
        (
          await f.platform.query(
            `SELECT expires_at-created_at BETWEEN interval '7 days' AND interval '7 days 1 second' AS lifetime FROM "${a.names.schema}".tf_invitations WHERE id=$1`,
            [first.invitation.id],
          )
        ).rows[0].lifetime,
        true,
      );
      assert.equal(JSON.stringify(firstRow).includes(firstPayload.url), false);
      await f.platform.query(
        `REVOKE EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM ${escapeIdentifier(a.names.runtime)}`,
      );
      await assert.rejects(governance.createInvitation(a.id, a.userId, { ...input, requestId: randomUUID() }));
      assert.equal(
        (await f.platform.query(`SELECT id FROM "${a.names.schema}".tf_invitations WHERE revoked_at IS NULL`)).rowCount,
        1,
      );
      assert.equal((await row(firstRow.id)).status, 'pending');
      await f.platform.query(
        `GRANT EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) TO ${escapeIdentifier(a.names.runtime)}`,
      );
      const workspaceLogin = await connect(f.login(a));
      try {
        await f.platform.query(
          'CREATE FUNCTION app.future_private_function() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
        );
        await denied(workspaceLogin, 'SELECT app.future_private_function()');
        await denied(workspaceLogin, 'SELECT * FROM app.email_deliveries');
        await denied(workspaceLogin, 'SELECT app.invitation_delivery($1, $2, $3)', [b.id, firstRow.id, 'status']);
        await denied(workspaceLogin, 'SELECT app.invitation_delivery($1, $2, $3)', [b.id, firstRow.id, 'cancel']);
      } finally {
        await workspaceLogin.end();
      }
      const pending = await governance.createInvitation(a.id, a.userId, { ...input, requestId: randomUUID() });
      assert.equal(pending.outcome, 'pending');
      assert.equal(pending.invitation.id, first.invitation.id);
      const resend = { requestId: randomUUID() };
      const second = await governance.resendInvitation(a.id, a.userId, first.invitation.id, resend);
      assert.deepEqual(await governance.resendInvitation(a.id, a.userId, first.invitation.id, resend), second);
      await assert.rejects(
        governance.resendInvitation(a.id, a.userId, second.invitation.id, resend),
        /invitation-request-conflict/,
      );
      await assert.rejects(
        governance.createInvitation(a.id, a.userId, { ...input, requestId: resend.requestId }),
        /invitation-request-conflict/,
      );
      assert.equal((await row(firstRow.id)).payload, null);
      assert.equal(
        (await governance.listInvitations(a.id, a.userId)).items.find(i => i.id === firstRow.id).status,
        'revoked',
      );
      await governance.revokeInvitation(a.id, a.userId, second.invitation.id);
      assert.equal((await row(second.invitation.id)).status, 'cancelled');
      assert.equal((await row(second.invitation.id)).payload, null);
      const password = randomBytes(32).toString('hex');
      await f.admin.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)}`);
      const db = new URL(f.connectionString);
      await f.platform.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(db.pathname.slice(1))} TO ${escapeIdentifier(role)}; GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(role)}; GRANT SELECT, UPDATE ON app.email_deliveries TO ${escapeIdentifier(role)}`,
      );
      db.username = role;
      db.password = password;
      pool = new Pool({ connectionString: db.href });
      const store = createEmailDeliveryStore(pool, keys);
      const { enqueueMagicLink } = createEmailDeliveryStore(f.platform, keys);
      await denied(pool, 'SELECT * FROM app.accounts');
      await denied(pool, 'INSERT INTO app.email_deliveries DEFAULT VALUES');
      await denied(pool, 'DELETE FROM app.email_deliveries');
      const magic = await enqueueMagicLink(
        'new@example.com',
        `http://localhost:5173/verify-email?token=private-auth-token&callbackURL=${encodeURIComponent(firstPayload.url)}`,
      );
      assert.deepEqual(await store.pending(), [magic]);
      await assert.rejects(
        store.deliver(magic, async payload => {
          throw new Error(payload.url);
        }),
        /^Error: Email delivery failed$/,
      );
      assert.equal((await row(magic)).status, 'failed');
      assert.ok((await row(magic)).payload);
      await f.platform.query(
        "UPDATE app.email_deliveries SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
        [magic],
      );
      const invitation = await governance.createInvitation(a.id, a.userId, { ...input, requestId: randomUUID() });
      const invitationPayload = decryptEmailDelivery(
        invitation.invitation.id,
        (await row(invitation.invitation.id)).payload,
        keys,
      );
      process.env.EMAIL_DELIVERY_KEY_ID = keys.keyId;
      process.env.EMAIL_DELIVERY_KEY = keys.key.toString('hex');
      process.env.EMAIL_DELIVERY_DATABASE_URL = db.href;
      process.env.TEMPORAL_TASK_QUEUE = `email-proof-${randomUUID()}`;
      await f.platform.query(`GRANT SELECT ON app.accounts TO ${escapeIdentifier(role)}`);
      await assert.rejects(
        createEmailDeliveryComposition(async () => {}),
        /restricted delivery database login/,
      );
      await f.platform.query(`REVOKE SELECT ON app.accounts FROM ${escapeIdentifier(role)}`);
      const failing = await enqueueMagicLink('failure@example.com', 'https://example.com/private-failure-token');
      let failOnce = true;
      composition = await createEmailDeliveryComposition(async (to, message) => {
        if (to === 'failure@example.com' && failOnce) {
          failOnce = false;
          throw new Error(message.html);
        }
        captured.push({ to, message });
      });
      connection = await Connection.connect({ address: '127.0.0.1:7233' });
      const client = new Client({ connection });
      native = await NativeConnection.connect({ address: '127.0.0.1:7233' });
      worker = await Worker.create({
        connection: native,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
        activities: { ...composition.activities, sendEmail: async () => 'legacy-delivered' },
      });
      running = worker.run();
      const legacy = await client.workflow.start('sendEmailWorkflow', {
        workflowId: `legacy-email-${randomUUID()}`,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        args: ['legacy@example.com', { template: 'test', props: { sentAt: 'fixture' } }],
      });
      assert.equal(await legacy.result(), 'legacy-delivered');
      for (const id of [magic, invitation.invitation.id]) {
        await eventually(
          () => row(id),
          value => value.status === 'sent',
        );
        assert.equal((await row(id)).payload, null);
        const handle = client.workflow.getHandle(`email-delivery-${id}`);
        await handle.result();
        const history = payloadText(await handle.fetchHistory());
        assert.ok(history.includes(id));
        for (const secret of [
          'private-auth-token',
          new URL(firstPayload.url).searchParams.get('token'),
          new URL(invitationPayload.url).searchParams.get('token'),
          'recipient@example.com',
        ])
          assert.equal(history.includes(secret), false);
      }
      assert.equal(captured.length, 2);
      assert.equal(
        (await governance.copyInvitation(a.id, a.userId, invitation.invitation.id)).url,
        invitationPayload.url,
      );
      assert.ok(captured.find(item => item.to === 'recipient@example.com').message.html.includes('Accept Invite'));
      assert.ok(captured.find(item => item.to === 'recipient@example.com').message.html.includes('Delivery workspace'));
      assert.ok(
        captured.find(item => item.to === 'recipient@example.com').message.html.includes('recipient@example.com'),
      );
      assert.ok(captured.find(item => item.to === 'new@example.com').message.html.includes('private-auth-token'));
      await eventually(
        () => row(failing),
        value => value.status === 'failed',
      );
      const failedHandle = client.workflow.getHandle(`email-delivery-${failing}`);
      await assert.rejects(failedHandle.result());
      const failedHistory = payloadText(await failedHandle.fetchHistory());
      assert.equal(failedHistory.includes('private-failure-token'), false);
      assert.equal(failedHistory.includes('failure@example.com'), false);
      await f.platform.query(
        "UPDATE app.email_deliveries SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
        [failing],
      );
      await eventually(
        () => row(failing),
        value => value.status === 'sent',
      );
      assert.equal((await row(failing)).attempts, 2);
      worker.shutdown();
      await running;
      running = undefined;
      worker = undefined;
      await composition.close();
      composition = undefined;
      const expired = await enqueueMagicLink('expired@example.com', 'https://example.com/private-expired');
      await f.platform.query(
        "UPDATE app.email_deliveries SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [expired],
      );
      assert.deepEqual(await store.pending(), []);
      assert.equal((await row(expired)).payload, null);
      const crash = await enqueueMagicLink('restart@example.com', 'https://example.com/private-restart');
      await f.platform.query(
        "UPDATE app.email_deliveries SET status = 'sending', lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
        [crash],
      );
      composition = await createEmailDeliveryComposition(async (to, message) => {
        captured.push({ to, message });
      });
      worker = await Worker.create({
        connection: native,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE,
        workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
        activities: composition.activities,
      });
      running = worker.run();
      await eventually(
        () => row(crash),
        value => value.status === 'sent',
      );
      assert.equal(captured.at(-1).to, 'restart@example.com');
      assert.equal((await row(crash)).attempts, 1);
      const concurrent = await enqueueMagicLink('concurrent@example.com', 'https://example.com/concurrent');
      let releaseSend;
      const sending = new Promise(resolve => {
        releaseSend = resolve;
      });
      let calls = 0;
      const send = async () => {
        calls++;
        await sending;
      };
      const inFlight = store.deliver(concurrent, send);
      await eventually(
        () => row(concurrent),
        value => value.status === 'sending',
      );
      await store.deliver(concurrent, send);
      assert.equal(calls, 1);
      releaseSend();
      await inFlight;
      assert.equal((await row(concurrent)).status, 'sent');
      const directory = await mkdtemp(join(tmpdir(), 'invitation-restore-'));
      try {
        const snapshot = await inspectWorkspaceSnapshot(f.platform, b.names.schema);
        const options = {
          connectionString: f.connectionString,
          schema: b.names.schema,
          archivePath: join(directory, 'workspace.dump'),
        };
        const archive = await backupDisposableWorkspace(options);
        await f.platform.query(
          `DROP SCHEMA "${b.names.schema}" CASCADE; REVOKE USAGE ON SCHEMA app FROM "${b.names.runtime}"; REVOKE EXECUTE ON FUNCTION app.invitation_delivery(uuid, uuid, text, jsonb, timestamptz) FROM "${b.names.runtime}"`,
        );
        assert.equal(
          (await restoreDisposableWorkspace({ ...options, ...archive, expected: snapshot })).status,
          'verified',
        );
        assert.deepEqual((await governance.listInvitations(b.id, b.userId)).items, []);
      } finally {
        await rm(directory, { recursive: true });
      }
      const otherRecipient = await createWorkspaceMember({
        runtime,
        workspace: b,
        profile: { name: 'Recipient in other workspace', contactEmail: input.email },
      });
      const pendingRemoval = await governance.createInvitation(b.id, b.userId, {
        ...input,
        requestId: randomUUID(),
        workspaceMemberId: otherRecipient.id,
      });
      await runtime.close();
      runtime = undefined;
      const removal = {
        connectionString: f.connectionString,
        workspaceId: b.id,
        operatorId: 'local-proof',
        lifecycle: {
          markUnavailable: async () => {},
          stopJobs: async () => {},
          drainPools: async () => {},
          assertUnavailable: async () => {},
        },
      };
      await teardownDisposableWorkspace(removal);
      await teardownDisposableWorkspace(removal);
      assert.equal(
        (await f.admin.query('SELECT rolname FROM pg_roles WHERE rolname = $1', [b.names.runtime])).rowCount,
        0,
      );
      assert.equal((await row(pendingRemoval.invitation.id)).payload, null);
    } finally {
      if (worker) worker.shutdown();
      await running;
      await composition?.close();
      await connection?.close();
      await native?.close();
      await runtime?.close();
      await pool?.end();
      await f.close();
      const cleanup = new Pool({ connectionString: env.TEST_ADMIN_DATABASE_URL });
      try {
        await cleanup.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
      } finally {
        await cleanup.end();
      }
      process.env = env;
    }
  },
);
