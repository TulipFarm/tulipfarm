import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool, escapeIdentifier } from 'pg';
import { AccessDenied } from '@tulipfarm/access';
import {
  fixture,
  connect,
  loadPlatformBaseline,
  registerPlatformWorkspace,
} from '../../workspace-storage/test/integration/fixture.mjs';
import { grantApplicationAccess } from '../../../apps/database/src/postgres.ts';
import { readMigrations } from '../../../apps/database/src/migrations.ts';
import { createGitHubEventInbox, GitHubInboxError } from '../src/event-inbox.ts';
import { githubWebhookSignature, GitHubWebhookError } from '../src/event-signature.ts';

const secret = 'fixture-github-event-signing-secret';
const keyring = { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } };
const body = () => ({
  action: 'opened',
  installation: { id: 20 },
  repository: {
    id: 10,
    full_name: 'acme/private',
    html_url: 'https://github.com/acme/private',
    private: true,
    owner: { id: 30, type: 'Organization' },
  },
  pull_request: {
    number: 1,
    title: 'Confidential title',
    html_url: 'https://github.com/acme/private/pull/1',
    user: { login: 'author' },
    state: 'open',
    merged_at: null,
    base: { ref: 'main', repo: { id: 10 } },
    head: { ref: 'feature' },
    body: 'Raw payload never stored',
  },
});
const request = (value = body(), id = randomUUID(), event = 'pull_request') => {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    headers: {
      'x-hub-signature-256': `sha256=${githubWebhookSignature(secret, raw)}`,
      'x-github-delivery': id,
      'x-github-event': event,
    },
  };
};
const failure = code => error => error instanceof GitHubInboxError && error.code === code;

test(
  'durable GitHub inbox preserves private events and exact per-source routing across retries',
  { timeout: 60000 },
  async t => {
    const db = await fixture();
    let pool,
      createdRole = false;
    try {
      if (!(await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname='tulipfarm'")).rowCount) {
        await db.admin.query('CREATE ROLE tulipfarm NOLOGIN');
        createdRole = true;
      }
      await loadPlatformBaseline(db.platform);
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../../apps/database/migrations/', import.meta.url)),
      );
      for (const migration of migrations.filter(item => item.name !== '0001_baseline.sql'))
        await db.platform.query(migration.sql);
      const workspace = await db.create();
      const otherWorkspace = randomUUID();
      await registerPlatformWorkspace(db.platform, otherWorkspace);
      const sources = [
        { workspaceId: workspace.id, sourceId: randomUUID() },
        { workspaceId: otherWorkspace, sourceId: randomUUID() },
      ];
      for (const source of sources)
        await db.platform.query(
          `INSERT INTO app.github_event_routes
      (app_id,installation_id,workspace_id,source_id,generation,active) VALUES ('100','20',$1,$2,1,true)`,
          [source.workspaceId, source.sourceId],
        );
      pool = new Pool({
        connectionString: db.connectionString,
        max: 12,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
      const make = (maximumPending = 100) =>
        createGitHubEventInbox({ pool, appId: '100', signingSecret: secret, keyring, maximumPending });
      const send = (inbox, value) => inbox.accept(value.raw, value.headers);
      const reset = async () => {
        await db.platform
          .query(`TRUNCATE app.github_event_dispatches,app.github_event_payloads,app.github_event_deliveries,app.github_event_policy;
        UPDATE app.github_event_routes SET generation=1,active=true`);
      };
      const count = async table =>
        Number((await db.platform.query(`SELECT count(*) AS count FROM app.${table}`)).rows[0].count);
      const authorized = async lease => {
        assert.ok(
          sources.some(source => source.workspaceId === lease.workspaceId && source.sourceId === lease.sourceId),
        );
        assert.equal(lease.generation, 1);
        assert.equal(lease.installationId, '20');
        assert.equal(lease.repositoryId, '10');
        assert.equal(lease.ownerId, '30');
        assert.equal(lease.ownerKind, 'organization');
        assert.equal(lease.privateRepository, true);
        assert.equal(Object.hasOwn(lease, 'fields'), false);
      };

      await t.test(
        'unauthenticated input never reaches storage; concurrent retries save one payload and target snapshot',
        async () => {
          const inbox = make(),
            input = request();
          await assert.rejects(inbox.accept(input.raw, {}), GitHubWebhookError);
          assert.equal(await count('github_event_policy'), 0);
          const receipts = await Promise.all(Array.from({ length: 10 }, () => send(inbox, input)));
          assert.equal(receipts.filter(receipt => !receipt.duplicate).length, 1);
          assert.ok(receipts.every(receipt => receipt.status === 'pending'));
          assert.equal(await count('github_event_deliveries'), 1);
          assert.equal(await count('github_event_payloads'), 1);
          assert.equal(await count('github_event_dispatches'), 2);
          const text = JSON.stringify((await db.platform.query('SELECT * FROM app.github_event_payloads')).rows);
          assert.equal(text.includes('Confidential'), false);
          assert.equal(text.includes('Raw payload'), false);
          const altered = body();
          altered.pull_request.title = 'Changed';
          await assert.rejects(
            send(inbox, request(altered, input.headers['x-github-delivery'])),
            failure('delivery-conflict'),
          );
          await assert.rejects(
            send(inbox, request(body(), input.headers['x-github-delivery'], 'issue_comment')),
            failure('delivery-conflict'),
          );
        },
      );

      await t.test('a failed routing write rolls back the receipt and ciphertext before retry', async () => {
        await reset();
        await db.platform.query(`CREATE FUNCTION app.reject_github_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture dispatch failure'; END $$;
        CREATE TRIGGER reject_dispatch BEFORE INSERT ON app.github_event_dispatches FOR EACH ROW EXECUTE FUNCTION app.reject_github_dispatch()`);
        const input = request();
        await assert.rejects(send(make(), input), /fixture dispatch failure/);
        assert.equal(await count('github_event_deliveries'), 0);
        assert.equal(await count('github_event_payloads'), 0);
        await db.platform.query(
          'DROP TRIGGER reject_dispatch ON app.github_event_dispatches; DROP FUNCTION app.reject_github_dispatch()',
        );
        assert.equal((await send(make(), input)).duplicate, false);
      });

      await t.test(
        'partial fan-out survives restart without reissuing completed recipients or adding late sources',
        async () => {
          await reset();
          const input = request(),
            inbox = make();
          await send(inbox, input);
          const first = await inbox.claim(authorized);
          assert.equal(first.kind, 'ready');
          assert.equal(first.event.fields['pullRequest.title'], 'Confidential title');
          assert.equal(JSON.stringify(first.event).includes('Raw payload'), false);
          await inbox.finish(first.lease, { status: 'delivered' });
          await inbox.finish(first.lease, { status: 'delivered' });
          await assert.rejects(
            inbox.finish(first.lease, { status: 'blocked', reason: 'changed-result' }),
            failure('lease-lost'),
          );
          assert.equal(await count('github_event_payloads'), 1);
          const lateSource = randomUUID();
          await db.platform.query(`INSERT INTO app.github_event_routes VALUES ('100','20',$1,$2,1,true)`, [
            workspace.id,
            lateSource,
          ]);
          const restarted = make();
          const second = await restarted.claim(authorized);
          assert.notEqual(second.lease.sourceId, first.lease.sourceId);
          await restarted.finish(second.lease, { status: 'delivered' });
          assert.equal(await restarted.claim(authorized), null);
          assert.equal(await count('github_event_payloads'), 0);
          assert.equal((await send(restarted, input)).status, 'routed');
          assert.equal(await count('github_event_dispatches'), 2);
          await db.platform.query('DELETE FROM app.github_event_routes WHERE source_id=$1', [lateSource]);
        },
      );

      await t.test('leases fence stale workers and retries retain one dispatch identity', async () => {
        await reset();
        const inbox = make();
        await send(inbox, request());
        const claims = await Promise.all(Array.from({ length: 8 }, () => inbox.claim(authorized)));
        const active = claims.filter(Boolean);
        assert.equal(active.length, 2);
        const [old, other] = active;
        await inbox.finish(other.lease, { status: 'delivered' });
        await db.platform.query(
          `UPDATE app.github_event_dispatches SET lease_until=now()-interval '1 second' WHERE lease_id=$1`,
          [old.lease.leaseId],
        );
        const retry = await make().claim(authorized);
        assert.equal(retry.lease.sourceId, old.lease.sourceId);
        assert.notEqual(retry.lease.leaseId, old.lease.leaseId);
        await assert.rejects(inbox.finish(old.lease, { status: 'delivered' }), failure('lease-lost'));
        await inbox.defer(retry.lease, 30, 'provider-unavailable');
        assert.equal(await inbox.claim(authorized), null);
        await db.platform.query(
          "UPDATE app.github_event_dispatches SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
        );
        const resumed = await inbox.claim(authorized);
        await inbox.finish(resumed.lease, { status: 'delivered' });
        assert.equal(await count('github_event_dispatches'), 2);
      });

      await t.test(
        'source authorization runs outside locks and denial or changed generation reveals no content',
        async () => {
          await reset();
          const inbox = make();
          await send(inbox, request());
          const denied = await inbox.claim(async () => {
            throw new AccessDenied();
          });
          assert.equal(denied.kind, 'blocked');
          assert.equal(Object.hasOwn(denied, 'event'), false);
          await assert.rejects(
            inbox.claim(async lease => {
              await db.platform.query('BEGIN');
              try {
                await db.platform.query("SET LOCAL lock_timeout='100ms'");
                await db.platform.query('UPDATE app.github_event_routes SET generation=2 WHERE source_id=$1', [
                  lease.sourceId,
                ]);
                await db.platform.query('UPDATE app.github_event_dispatches SET reason=reason WHERE source_id=$1', [
                  lease.sourceId,
                ]);
                await db.platform.query('COMMIT');
              } catch (error) {
                await db.platform.query('ROLLBACK');
                throw error;
              }
            }),
            failure('lease-lost'),
          );
          assert.equal(await inbox.claim(authorized), null);
        },
      );

      await t.test('expiry removes content, fences active leases and keeps deduplication tombstones', async () => {
        await reset();
        const inbox = make(),
          input = request();
        const initial = await send(inbox, input);
        assert.equal(initial.expiresAt.getTime() - initial.receivedAt.getTime(), 30 * 86400000);
        const claim = await inbox.claim(authorized);
        await db.platform.query(
          `UPDATE app.github_event_deliveries SET received_at=now()-interval '721 hours',expires_at=now()-interval '1 hour'`,
        );
        assert.equal(await inbox.expire(1), 1);
        assert.equal(await count('github_event_payloads'), 0);
        assert.equal(await count('github_event_deliveries'), 1);
        assert.equal(await count('github_event_dispatches'), 2);
        await assert.rejects(inbox.finish(claim.lease, { status: 'delivered' }), failure('lease-lost'));
        const replay = await send(make(), input);
        assert.equal(replay.status, 'expired');
        assert.equal(replay.duplicate, true);
        assert.ok(replay.expiresAt < new Date());
        assert.equal(await inbox.claim(authorized), null);
      });

      await t.test(
        'shared capacity and policy are atomic and rejected or ignored events do not retain content',
        async () => {
          await reset();
          const inbox = make(2);
          const receipts = await Promise.all(Array.from({ length: 8 }, () => send(inbox, request())));
          assert.equal(receipts.filter(receipt => receipt.status === 'pending').length, 2);
          assert.equal(
            receipts.filter(receipt => receipt.status === 'rejected' && receipt.reason === 'capacity-exceeded').length,
            6,
          );
          assert.equal(await count('github_event_payloads'), 2);
          await assert.rejects(send(make(3), request()), failure('policy-conflict'));
          assert.equal((await send(inbox, request({}, randomUUID(), 'ping'))).reason, 'ping');
          assert.equal(
            (await send(inbox, request({}, randomUUID(), 'installation'))).reason,
            'lifecycle-reconciliation-required',
          );
          const bad = body();
          bad.pull_request.title = 'x'.repeat(4001);
          assert.equal((await send(inbox, request(bad))).status, 'rejected');
          const unrelated = body();
          unrelated.installation.id = 21;
          assert.equal((await send(inbox, request(unrelated))).reason, 'no-active-source');
          assert.equal(await count('github_event_payloads'), 2);
        },
      );

      await t.test(
        'grant replay protects identities, deadlines, receipts and private content from workspace roles',
        async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            await grantApplicationAccess(db.databaseAdmin, 'isolated-v1');
            await db.databaseAdmin.query('SET ROLE tulipfarm');
            try {
              assert.ok((await db.databaseAdmin.query('SELECT * FROM app.github_event_deliveries')).rowCount > 0);
              await assert.rejects(db.databaseAdmin.query('DELETE FROM app.github_event_deliveries'), {
                code: '42501',
              });
              await assert.rejects(
                db.databaseAdmin.query("UPDATE app.github_event_deliveries SET expires_at=now()+interval '90 days'"),
                { code: '42501' },
              );
              await assert.rejects(
                db.databaseAdmin.query("UPDATE app.github_event_deliveries SET body_digest=repeat('b',64)"),
                { code: '42501' },
              );
              await assert.rejects(
                db.databaseAdmin.query('UPDATE app.github_event_routes SET source_id=gen_random_uuid()'),
                { code: '42501' },
              );
              await assert.rejects(db.databaseAdmin.query('UPDATE app.github_event_policy SET maximum_pending=999'), {
                code: '42501',
              });
            } finally {
              await db.databaseAdmin.query('RESET ROLE');
            }
          }
          for (const capability of ['runtime', 'migration', 'confirmation']) {
            const client = await connect(db.login(workspace, capability));
            try {
              await assert.rejects(client.query('SELECT * FROM app.github_event_payloads'), { code: '42501' });
              await assert.rejects(client.query('SELECT * FROM app.github_event_routes'), { code: '42501' });
            } finally {
              await client.end();
            }
          }
          await reset();
          await db.admin.query(`GRANT tulipfarm TO ${escapeIdentifier(db.owner)}`);
          const applicationPool = new Pool({
            connectionString: db.connectionString,
            options: '-c role=tulipfarm',
            max: 2,
          });
          try {
            const inbox = createGitHubEventInbox({
              pool: applicationPool,
              appId: '100',
              signingSecret: secret,
              keyring,
              maximumPending: 2,
            });
            assert.equal((await send(inbox, request())).status, 'pending');
            const first = await inbox.claim(authorized);
            await inbox.finish(first.lease, { status: 'delivered' });
            const second = await inbox.claim(authorized);
            await inbox.finish(second.lease, { status: 'blocked', reason: 'source-access-denied' });
            assert.equal(await count('github_event_payloads'), 0);
            await send(inbox, request());
            const pending = await inbox.claim(authorized);
            await inbox.defer(pending.lease, 30, 'provider-unavailable');
            await db.platform.query(`UPDATE app.github_event_deliveries SET received_at=now()-interval '721 hours',
          expires_at=now()-interval '1 hour' WHERE status='pending'`);
            assert.equal(await inbox.expire(10), 1);
            assert.equal(await count('github_event_payloads'), 0);
          } finally {
            await applicationPool.end();
          }
        },
      );
    } finally {
      await pool?.end();
      await db.close();
      if (createdRole) {
        const admin = await connect(process.env.TEST_ADMIN_DATABASE_URL);
        try {
          await admin.query('DROP ROLE tulipfarm');
        } finally {
          await admin.end();
        }
      }
    }
  },
);
