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
