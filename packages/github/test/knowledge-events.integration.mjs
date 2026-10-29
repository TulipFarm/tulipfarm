import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool, escapeIdentifier } from 'pg';
import { fixture, connect, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { grantApplicationAccess } from '../../../apps/database/src/postgres.ts';
import { readMigrations } from '../../../apps/database/src/migrations.ts';
import { createGitHubKnowledgeEvents, GitHubKnowledgeEventConflict } from '../src/knowledge-events.ts';
import { githubWebhookSignature, GitHubWebhookError } from '../src/event-signature.ts';
import { pruneGitHubEventBodies, pruneGitHubEventDeliveries } from '../src/event-retention.ts';

const secret = 'fixture-github-knowledge-signing-secret';
const issue = (id = 7001, title = 'Confidential title') => ({
  action: 'edited',
  repository: { id, full_name: 'acme/private', default_branch: 'main' },
  issue: { number: 1, title, body: 'Raw payload never stored' },
});
const request = (value = issue(), id = randomUUID(), event = 'issues') => {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    headers: {
      'x-hub-signature-256': `sha256=${githubWebhookSignature(secret, raw)}`,
      'x-github-delivery': id,
      'x-github-event': event,
      'x-github-hook-installation-target-type': 'integration',
      'x-github-hook-installation-target-id': '100',
    },
  };
};

test(
  'Knowledge webhook deliveries are verified, deduplicated and kept only as changed repository IDs',
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
      await grantApplicationAccess(db.databaseAdmin, 'isolated-v1');
      await db.admin.query(`GRANT tulipfarm TO ${escapeIdentifier(db.owner)}`);
      // The API runs as the application role, so these checks also prove its grants are enough.
      pool = new Pool({ connectionString: db.connectionString, options: '-c role=tulipfarm', max: 6 });
      const make = options => createGitHubKnowledgeEvents({ pool, appId: '100', signingSecret: secret, ...options });
      const send = (events, value) => events.accept(value.raw, value.headers);
      const count = async (table, where = 'true') =>
        Number((await db.platform.query(`SELECT count(*) AS count FROM app.${table} WHERE ${where}`)).rows[0].count);

      await t.test('unsigned input never reaches storage', async () => {
        const events = make();
        const input = request();
        await assert.rejects(events.accept(input.raw, {}), GitHubWebhookError);
        await assert.rejects(
          events.accept(input.raw, { ...input.headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }),
          GitHubWebhookError,
        );
        assert.equal(await count('github_event_deliveries'), 0);
      });

      await t.test('redeliveries are deduplicated by delivery ID and payload content is never stored', async () => {
        const events = make();
        const input = request();
        const receipts = await Promise.all(Array.from({ length: 8 }, () => send(events, input)));
        assert.equal(receipts.filter(receipt => !receipt.duplicate).length, 1);
        assert.ok(receipts.every(receipt => receipt.status === 'pending'));
        assert.equal(await count('github_event_deliveries'), 1);
        const stored = JSON.stringify((await db.platform.query('SELECT envelope FROM app.github_event_payloads')).rows);
        assert.equal(stored, JSON.stringify([{ envelope: { all: false, repositories: ['7001'] } }]));
        await assert.rejects(
          send(events, request(issue(7001, 'Changed'), input.headers['x-github-delivery'])),
          GitHubKnowledgeEventConflict,
        );
        await assert.rejects(
          send(events, request(issue(), input.headers['x-github-delivery'], 'issue_comment')),
          GitHubKnowledgeEventConflict,
        );
      });

      await t.test('irrelevant deliveries are recorded once without a payload', async () => {
        const events = make();
        const ping = await send(events, request({ zen: 'hello' }, randomUUID(), 'ping'));
        assert.deepEqual([ping.status, ping.reason], ['ignored', 'ping']);
        const branch = await send(
          events,
          request(
            { ref: 'refs/heads/feature', repository: { id: 7001, default_branch: 'main' } },
            randomUUID(),
            'push',
          ),
        );
        assert.deepEqual([branch.status, branch.reason], ['ignored', 'non-default-branch']);
        const invalid = await send(events, request({ repository: { name: 'x' } }));
        assert.deepEqual([invalid.status, invalid.reason], ['rejected', 'payload-invalid']);
        assert.equal(await count('github_event_payloads'), 1);
      });

      await t.test('pending changes are read until settled, then closed and their payload removed', async () => {
        const events = make();
        await send(events, request(issue(7002)));
        const pending = await events.pending();
        assert.deepEqual(pending.map(item => item.repositories).sort(), [['7001'], ['7002']]);
        await events.settle(pending.map(item => item.deliveryId));
        assert.deepEqual(await events.pending(), []);
        assert.equal(await count('github_event_payloads'), 0);
        assert.equal(await count('github_event_deliveries', "status='routed'"), 2);
        const again = await send(events, request(issue(7001), pending[0].deliveryId));
        assert.equal(again.duplicate, true);
        assert.equal(again.status, 'routed');
      });

      await t.test('the inbox bound rejects deliveries once full and expiry frees it', async () => {
        const events = make({ maximumPending: 2 });
        await db.platform.query('UPDATE app.github_event_policy SET maximum_pending=2');
        await send(events, request(issue(1)));
        await send(events, request(issue(2)));
        const full = await send(events, request(issue(3)));
        assert.deepEqual([full.status, full.reason], ['rejected', 'capacity-exceeded']);
        await db.platform.query(
          "UPDATE app.github_event_deliveries SET received_at=received_at-interval '2 hours',expires_at=expires_at-interval '2 hours' WHERE status='pending'",
        );
        assert.deepEqual(await events.pending(), []);
        assert.equal(await count('github_event_deliveries', "status='expired'"), 2);
        assert.equal(await count('github_event_payloads'), 0);
        assert.equal((await send(events, request(issue(4)))).status, 'pending');
      });

      await t.test('processed deliveries past the retention are deleted by the application role', async () => {
        const events = make();
        await db.platform.query('TRUNCATE app.github_event_payloads, app.github_event_deliveries CASCADE');
        await db.platform.query('UPDATE app.github_event_policy SET maximum_pending=10000');
        const age = async (id, hours) =>
          db.platform.query(
            `UPDATE app.github_event_deliveries SET received_at=received_at-$2*interval '1 hour',expires_at=expires_at-$2*interval '1 hour' WHERE delivery_id=$1`,
            [id, hours],
          );
        const routed = request(issue(11));
        await send(events, routed);
        await events.settle((await events.pending()).map(item => item.deliveryId));
        const ignored = request({ zen: 'old' }, randomUUID(), 'ping');
        await send(events, ignored);
        const recent = request({ zen: 'recent' }, randomUUID(), 'ping');
        await send(events, recent);
        const middle = request({ zen: 'middle' }, randomUUID(), 'ping');
        await send(events, middle);
        const waiting = request(issue(12));
        await send(events, waiting);
        const referenced = request({ zen: 'referenced' }, randomUUID(), 'ping');
        await send(events, referenced);
        const id = value => value.headers['x-github-delivery'];
        for (const old of [routed, ignored, waiting, referenced]) await age(id(old), 7);
        await age(id(middle), 3);
        // Pending deliveries are only closed by expiry, never deleted while pending.
        await db.platform.query(
          `UPDATE app.github_event_deliveries SET expires_at=clock_timestamp()+interval '1 hour' WHERE delivery_id=$1`,
          [id(waiting)],
        );
        await db.platform.query(
          'INSERT INTO app.github_event_payloads(app_id,delivery_id,envelope) VALUES ($1,$2,$3)',
          ['100', id(referenced), { all: true, repositories: [] }],
        );
        const remaining = async () =>
          (
            await db.platform.query('SELECT delivery_id FROM app.github_event_deliveries ORDER BY delivery_id')
          ).rows.map(row => row.delivery_id);

        assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 6 }), 2);
        assert.deepEqual(await remaining(), [id(recent), id(middle), id(waiting), id(referenced)].sort());
        assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 6 }), 0);
        assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 2 }), 1);
        assert.deepEqual(await remaining(), [id(recent), id(waiting), id(referenced)].sort());

        const client = await pool.connect();
        try {
          await assert.rejects(client.query('DELETE FROM app.github_event_deliveries'), { code: '42501' });
          await assert.rejects(client.query('SELECT app.prune_github_event_deliveries(0, 10)'), { code: '22023' });
          await assert.rejects(client.query('SELECT app.prune_github_event_deliveries(6, 1001)'), { code: '22023' });
        } finally {
          client.release();
        }

        const again = await send(events, request(issue(11), id(routed)));
        assert.deepEqual([again.duplicate, again.status], [false, 'pending']);
        assert.equal((await send(events, recent)).duplicate, true);
      });

      await t.test('cleanup deletes large backlogs in bounded batches', async () => {
        await db.platform.query(
          `INSERT INTO app.github_event_deliveries (app_id,delivery_id,body_digest,event_name,status,reason,received_at,expires_at)
          SELECT '100',gen_random_uuid(),repeat('a',64),'ping','ignored','ping',now()-interval '8 hours',now()-interval '7 hours'
          FROM generate_series(1,1200)`,
        );
        assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 6, maxBatches: 2 }), 1000);
        assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 6 }), 200);
        assert.equal(await count('github_event_deliveries', "received_at < now()-interval '6 hours'"), 2);
      });

      await t.test(
        'the all-events route keeps every accepted body for one minute and the delivery after it',
        async () => {
          const events = make();
          await db.platform.query('TRUNCATE app.github_event_payloads, app.github_event_deliveries CASCADE');
          await db.platform.query('UPDATE app.github_event_policy SET maximum_pending=10000');
          const keep = value => events.accept(value.raw, value.headers, { keepBody: true });
          const bodies = async () =>
            (await db.platform.query('SELECT delivery_id FROM app.github_event_bodies')).rows.map(
              row => row.delivery_id,
            );
          const star = request(
            { action: 'created', repository: { id: 7001 }, starred_at: 'now' },
            randomUUID(),
            'star',
          );
          const big = request(
            { ref: 'refs/heads/feature', repository: { id: 7001, default_branch: 'main' }, filler: 'x'.repeat(100000) },
            randomUUID(),
            'push',
          );
          const changed = request(issue(7003));
          const invalid = request({ repository: { name: 'x' } });
          const outcomes = await Promise.all(Array.from({ length: 8 }, () => keep(star)));
          assert.equal(outcomes.filter(receipt => !receipt.duplicate).length, 1);
          await keep(big);
          await keep(changed);
          assert.equal((await keep(invalid)).status, 'rejected');
          const plain = request({ zen: 'plain' }, randomUUID(), 'ping');
          await send(events, plain);
          assert.deepEqual(
            (await bodies()).sort(),
            [star, big, changed].map(item => item.headers['x-github-delivery']).sort(),
          );
          assert.equal(await count('github_event_payloads'), 1);

          const age = id =>
            db.platform.query(
              "UPDATE app.github_event_deliveries SET received_at=received_at-interval '2 minutes' WHERE delivery_id=$1",
              [id],
            );
          await age(star.headers['x-github-delivery']);
          await age(big.headers['x-github-delivery']);
          assert.equal(await pruneGitHubEventBodies(pool), 2);
          assert.deepEqual(await bodies(), [changed.headers['x-github-delivery']]);
          assert.equal(
            await count('github_event_payloads'),
            1,
            'the Knowledge envelope is not on the one-minute clock',
          );
          assert.equal((await keep(star)).duplicate, true);
          assert.equal(await count('github_event_bodies'), 1, 'a redelivery after the sweep stores no second body');

          await db.platform.query("UPDATE app.github_event_deliveries SET received_at=received_at-interval '7 hours'");
          await db.platform.query('DELETE FROM app.github_event_payloads');
          await db.platform.query("UPDATE app.github_event_deliveries SET status='expired' WHERE status='pending'");
          assert.equal(await pruneGitHubEventDeliveries(pool, { retentionHours: 6 }), 5);
          assert.equal(await count('github_event_bodies'), 0);
          const client = await pool.connect();
          try {
            await assert.rejects(client.query('DELETE FROM app.github_event_bodies'), { code: '42501' });
            await assert.rejects(client.query('SELECT app.prune_github_event_bodies(0)'), { code: '22023' });
          } finally {
            client.release();
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
