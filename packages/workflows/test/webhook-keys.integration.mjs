import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows, WebhookKeyUnavailable } from '../src/service.ts';

const keyring = { activeKeyId: 'fixture', keys: { fixture: '5a'.repeat(32) } };
const definition = {
  version: 1,
  name: 'Signed intake',
  trigger: { kind: 'webhook' },
  steps: [{ id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 86400 }],
};
const sign = (key, timestamp, raw) => `sha256=${createHmac('sha256', key).update(`${timestamp}.${raw}`).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

async function webhookWorkspace(migrations) {
  const db = await fixture();
  const w = await db.create(migrations);
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const service = createWorkflows(runtime, { keyring });
  const id = randomUUID(),
    revision = randomUUID();
  await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
  await service.sponsorship(w.id, w.userId, id, {
    sponsorMembershipId: w.membershipId,
    historyAudience: [w.membershipId],
  });
  await service.activate(w.id, w.userId, id, {
    commandId: randomUUID(),
    expectedGeneration: 2,
    revision,
    enabled: true,
  });
  const generation = async () => (await service.list(w.id, w.userId)).find(item => item.id === id).generation;
  const rotate = async (mode, extra = {}) =>
    service.webhookKey(w.id, w.userId, id, {
      commandId: randomUUID(),
      expectedGeneration: await generation(),
      mode,
      ...extra,
    });
  const close = async () => {
    await runtime.close();
    await db.close();
  };
  return { db, w, runtime, service, id, rotate, generation, close, table: name => qualified(w.names.schema, name) };
}

const signed = (key, raw, timestamp = now(), signature = sign(key, timestamp, raw)) => ({
  body: JSON.parse(raw),
  raw: Buffer.from(raw),
  headers: { 'x-tulipfarm-timestamp': String(timestamp), 'x-tulipfarm-signature': signature },
});
const bearer = key => ({ body: { requestId: randomUUID(), input: null }, headers: { authorization: `Bearer ${key}` } });
const envelope = (input = null) => JSON.stringify({ requestId: randomUUID(), input });

test(
  'signed webhooks accept only a fresh, unseen HMAC over the timestamp and exact body',
  { timeout: 120000 },
  async () => {
    const setup = await webhookWorkspace(await workspaceTableMigrations());
    const { service, w, id, rotate, table, db } = setup;
    try {
      await assert.rejects(
        service.webhookKey(w.id, w.userId, id, {
          commandId: randomUUID(),
          expectedGeneration: await setup.generation(),
          mode: 'bearer',
          key: 'ab'.repeat(32),
        }),
        { name: 'ZodError' },
        'A client cannot choose its key',
      );
      const { workflow, key } = await rotate('signed');
      assert.match(key, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        [workflow.webhookConfigured, workflow.webhookMode, workflow.webhookPrevious, workflow.webhookRotation],
        [true, 'signed', null, true],
      );
      const stored = (
        await db.platform.query(
          `SELECT webhook_digest,webhook_secret::text AS secret FROM ${table('tf_workflows')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      assert.equal(stored.webhook_digest, null);
      assert.equal(stored.secret.includes(key), false, 'The signing key is stored only inside its encrypted envelope');

      const raw = envelope({ amount: 12 }).replace(',', ' ,  ');
      assert.match(
        (await service.webhook(w.id, id, signed(key, raw))).runId,
        /^[a-f0-9-]{36}$/,
        'The signature covers the raw bytes, including whitespace a parser drops',
      );
      await assert.rejects(service.webhook(w.id, id, signed(key, raw)), { message: 'webhook-signature-replayed' });
      const invalid = signed(key, JSON.stringify({ input: null }));
      await assert.rejects(service.webhook(w.id, id, invalid), { name: 'ZodError' });
      await assert.rejects(
        service.webhook(w.id, id, invalid),
        { message: 'webhook-signature-replayed' },
        'A verified signature is spent even when its body is refused',
      );
      const tampered = signed(key, raw);
      tampered.raw = Buffer.from(raw.replace('12', '13'));
      tampered.body = JSON.parse(tampered.raw.toString());
      await assert.rejects(service.webhook(w.id, id, tampered), AccessDenied);
      await assert.rejects(service.webhook(w.id, id, signed(key, envelope(), now() - 301)), {
        message: 'webhook-signature-expired',
      });
      await assert.rejects(service.webhook(w.id, id, signed(key, envelope(), now() + 301)), {
        message: 'webhook-signature-expired',
      });
      assert.match(
        (await service.webhook(w.id, id, signed(key, envelope(), now() - 240))).runId,
        /^[a-f0-9-]{36}$/,
        'A timestamp inside the five-minute window is accepted',
      );
      await assert.rejects(
        service.webhook(w.id, id, signed('cd'.repeat(32), envelope())),
        AccessDenied,
        'Another key cannot sign',
      );
      await assert.rejects(
        service.webhook(w.id, id, bearer(key)),
        AccessDenied,
        'A signing key is never accepted as a bearer key',
      );
      const unsigned = signed(key, envelope());
      delete unsigned.raw;
      await assert.rejects(
        service.webhook(w.id, id, unsigned),
        AccessDenied,
        'A signature cannot be checked without the raw body',
      );

      await db.platform.query(
        `UPDATE ${table('tf_workflow_webhook_signatures')} SET received_at=clock_timestamp()-interval '11 minutes'`,
      );
      assert.match((await service.webhook(w.id, id, signed(key, envelope()))).runId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(
        (await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_workflow_webhook_signatures')}`))
          .rows[0],
        { count: 1 },
        'Signatures older than twice the window are pruned',
      );

      for (let n = 0; n < 7; n++) await service.webhook(w.id, id, signed(key, envelope()));
      const full = signed(key, envelope());
      await assert.rejects(service.webhook(w.id, id, full), { message: 'limit-reached' });
      await assert.rejects(
        service.webhook(w.id, id, full),
        { message: 'limit-reached' },
        'A run limit leaves the signature unspent so the sender can retry it',
      );
    } finally {
      await setup.close();
    }
  },
);

test(
  'GitHub and Stripe webhook signatures use their native headers and encrypted secrets',
  { timeout: 120000 },
  async () => {
    const setup = await webhookWorkspace(await workspaceTableMigrations());
    const { service, w, id, rotate, table, db } = setup;
    try {
      const github = await rotate('github');
      const githubRaw = envelope({ provider: 'github' }),
        githubSignature = createHmac('sha256', github.key).update(githubRaw).digest('hex');
      const githubRequest = {
        body: JSON.parse(githubRaw),
        raw: Buffer.from(githubRaw),
        headers: { 'x-hub-signature-256': `sha256=${githubSignature}` },
      };
      assert.match((await service.webhook(w.id, id, githubRequest)).runId, /^[a-f0-9-]{36}$/);
      await assert.rejects(
        service.webhook(w.id, id, { ...githubRequest, headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } }),
        AccessDenied,
      );
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).webhookMode, 'github');

      const stripeSecret = 'whsec_workflow_test_signing_secret_123';
      const stripe = await rotate('stripe', { secret: stripeSecret });
      const timestamp = now(),
        stripeRaw = envelope({ provider: 'stripe' });
      const stripeSignature = createHmac('sha256', stripeSecret).update(`${timestamp}.${stripeRaw}`).digest('hex');
      const stripeRequest = {
        body: JSON.parse(stripeRaw),
        raw: Buffer.from(stripeRaw),
        headers: { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)},v1=${stripeSignature}` },
      };
      assert.match((await service.webhook(w.id, id, stripeRequest)).runId, /^[a-f0-9-]{36}$/);
      await assert.rejects(service.webhook(w.id, id, stripeRequest), { message: 'webhook-signature-replayed' });

      const oldTimestamp = timestamp - 301,
        oldRaw = envelope();
      const oldSignature = createHmac('sha256', stripeSecret).update(`${oldTimestamp}.${oldRaw}`).digest('hex');
      await assert.rejects(
        service.webhook(w.id, id, {
          body: JSON.parse(oldRaw),
          raw: Buffer.from(oldRaw),
          headers: { 'stripe-signature': `t=${oldTimestamp},v1=${oldSignature}` },
        }),
        { message: 'webhook-signature-expired' },
      );
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).webhookMode, 'stripe');
      const stored = (
        await db.platform.query(`SELECT webhook_secret::text AS secret FROM ${table('tf_workflows')} WHERE id=$1`, [id])
      ).rows[0].secret;
      assert.equal(stored.includes(stripeSecret), false, 'The Stripe secret is encrypted at rest');
      assert.equal(stripe.key, null, 'A provider-generated secret is not returned by the server');
    } finally {
      await setup.close();
    }
  },
);

test(
  'rotation keeps the previous key valid until its grace period ends or a manager revokes it',
  { timeout: 120000 },
  async () => {
    const setup = await webhookWorkspace(await workspaceTableMigrations());
    const { service, w, id, rotate, table, db } = setup;
    try {
      const first = await rotate('bearer');
      assert.equal(first.workflow.webhookPrevious, null, 'The first key has no predecessor');
      const second = await rotate('signed');
      assert.equal(second.workflow.webhookMode, 'signed');
      assert.equal(second.workflow.webhookPrevious.mode, 'bearer');
      const expiresIn = Date.parse(second.workflow.webhookPrevious.expiresAt) - Date.now();
      assert.ok(expiresIn > 86300000 && expiresIn <= 86400000, 'The previous key is accepted for 24 hours by default');
      assert.match(
        (await service.webhook(w.id, id, bearer(first.key))).runId,
        /^[a-f0-9-]{36}$/,
        'The previous key works during its grace period',
      );
      assert.match((await service.webhook(w.id, id, signed(second.key, envelope()))).runId, /^[a-f0-9-]{36}$/);
      const rekeyed = createWorkflows(setup.runtime, {
        keyring: { activeKeyId: 'other', keys: { other: '6b'.repeat(32) } },
      });
      assert.match(
        (await rekeyed.webhook(w.id, id, bearer(first.key))).runId,
        /^[a-f0-9-]{36}$/,
        'A key that cannot be unsealed does not hide another matching key',
      );
      await assert.rejects(
        rekeyed.webhook(w.id, id, signed(second.key, envelope())),
        WebhookKeyUnavailable,
        'A missing keyring key is an outage, not a wrong signature',
      );

      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET webhook_previous_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [id],
      );
      await assert.rejects(
        service.webhook(w.id, id, bearer(first.key)),
        AccessDenied,
        'The previous key stops after its grace period',
      );
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).webhookPrevious, null);

      const third = await rotate('bearer', { graceSeconds: 3600 });
      const graceIn = Date.parse(third.workflow.webhookPrevious.expiresAt) - Date.now();
      assert.ok(graceIn > 3500000 && graceIn <= 3600000);
      assert.match(
        (await service.webhook(w.id, id, signed(second.key, envelope()))).runId,
        /^[a-f0-9-]{36}$/,
        'A previous signing key keeps verifying signatures',
      );
      const revoke = { commandId: randomUUID(), expectedGeneration: third.workflow.generation };
      const revoked = await service.revokePreviousWebhookKey(w.id, w.userId, id, revoke);
      assert.equal(revoked.webhookPrevious, null);
      assert.equal(
        (await service.revokePreviousWebhookKey(w.id, w.userId, id, revoke)).generation,
        revoked.generation,
        'A replayed revoke changes nothing',
      );
      await assert.rejects(
        service.webhook(w.id, id, signed(second.key, envelope())),
        AccessDenied,
        'A revoked key stops at once',
      );
      assert.match((await service.webhook(w.id, id, bearer(third.key))).runId, /^[a-f0-9-]{36}$/);

      const fourth = await rotate('bearer', { graceSeconds: 0 });
      await assert.rejects(
        service.webhook(w.id, id, bearer(third.key)),
        AccessDenied,
        'A zero grace period replaces the key at once',
      );
      assert.equal(
        (
          await service.revokePreviousWebhookKey(w.id, w.userId, id, {
            commandId: randomUUID(),
            expectedGeneration: fourth.workflow.generation,
          })
        ).generation,
        fourth.workflow.generation,
        'Revoking with no previous key changes nothing',
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT operation,count(*)::integer AS count FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation LIKE 'workflow.webhook.%' GROUP BY operation ORDER BY operation`,
            [id],
          )
        ).rows,
        [
          { operation: 'workflow.webhook.revoke', count: 1 },
          { operation: 'workflow.webhook.rotate', count: 4 },
        ],
      );
    } finally {
      await setup.close();
    }
  },
);

test(
  'workspaces before common version 5 keep single bearer keys without signing or grace',
  { timeout: 120000 },
  async () => {
    const setup = await webhookWorkspace((await workspaceTableMigrations()).slice(0, 4));
    const { service, w, id, rotate } = setup;
    try {
      await assert.rejects(rotate('signed'), { message: 'webhook-signing-unavailable' });
      const first = await rotate('bearer');
      const second = await rotate('bearer');
      assert.deepEqual(
        [second.workflow.webhookMode, second.workflow.webhookPrevious, second.workflow.webhookRotation],
        ['bearer', null, false],
      );
      await assert.rejects(service.webhook(w.id, id, bearer(first.key)), AccessDenied);
      assert.match((await service.webhook(w.id, id, bearer(second.key))).runId, /^[a-f0-9-]{36}$/);
      await assert.rejects(
        service.revokePreviousWebhookKey(w.id, w.userId, id, {
          commandId: randomUUID(),
          expectedGeneration: second.workflow.generation,
        }),
        { message: 'webhook-signing-unavailable' },
      );
    } finally {
      await setup.close();
    }
  },
);

test(
  'workspaces before common version 7 report no delivery log and still accept test sends',
  { timeout: 120000 },
  async () => {
    const setup = await webhookWorkspace((await workspaceTableMigrations()).slice(0, 6));
    const { service, w, id } = setup;
    try {
      await service.recordWebhookDelivery(w.id, id, {
        status: 404,
        outcome: 'key-missing',
        test: false,
        runId: null,
        bodyBytes: 10,
        requestId: null,
      });
      assert.deepEqual(await service.webhookDeliveries(w.id, w.userId, id), { available: false, deliveries: [] });
      const requestId = randomUUID();
      const sent = await service.testWebhook(w.id, w.userId, id, { requestId });
      assert.deepEqual(await service.testWebhook(w.id, w.userId, id, { requestId }), {
        runId: sent.runId,
        replayed: true,
      });
    } finally {
      await setup.close();
    }
  },
);
