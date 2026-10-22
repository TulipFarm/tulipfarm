import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import { createModelRouteHealth } from '../src/model-health.ts';

test('deployment health has one shared probe across workspaces and fences stale completion', async () => {
  const base = process.env.CONTINUITY_POSTGRES_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres';
  const admin = new Client({ connectionString: base });
  await admin.connect();
  const database = `model_health_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  const owner = new Client({ connectionString: url.toString() });
  await owner.connect();
  const other = new Client({ connectionString: url.toString() });
  await other.connect();
  try {
    await owner.query('CREATE SCHEMA app');
    await owner.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const first = createModelRouteHealth(owner, () => 'same-trusted-endpoint-and-deployment');
    const second = createModelRouteHealth(other, () => 'same-trusted-endpoint-and-deployment');
    const a = randomUUID(),
      b = randomUUID(),
      c = randomUUID();
    const lease = new Date(Date.now() + 45000);
    const healthy = randomUUID();
    assert.equal(await first.claim({}, healthy, lease), true);
    assert.equal(await second.claim({}, randomUUID(), lease), true);
    await first.finish({}, healthy, 'unavailable', 5000);
    await owner.query("UPDATE app.model_route_health SET until_at=clock_timestamp()-interval '1 second'");
    assert.deepEqual((await Promise.all([first.claim({}, a, lease), second.claim({}, b, lease)])).sort(), [
      false,
      true,
    ]);
    const winner = (await owner.query('SELECT probe_id FROM app.model_route_health')).rows[0].probe_id;
    await first.finish({}, winner, 'unavailable', 5000);
    assert.equal(await second.claim({}, c, lease), false);
    await owner.query("UPDATE app.model_route_health SET until_at=clock_timestamp()-interval '1 second'");
    assert.equal(await second.claim({}, c, lease), true);
    await first.finish({}, winner, null, null);
    assert.equal((await owner.query('SELECT probe_id FROM app.model_route_health')).rows[0].probe_id, c);
    await second.finish({}, c, 'quota', null);
    await first.finish({}, winner, 'unavailable', 120000);
    const long = randomUUID();
    assert.equal(await first.claim({}, long, lease), true);
    await first.finish({}, long, 'unavailable', Number.MAX_SAFE_INTEGER);
    assert.equal(await second.claim({}, randomUUID(), lease), false);
    const maximum = (
      await owner.query("SELECT until_at<clock_timestamp()+interval '25 hours' AS bounded FROM app.model_route_health")
    ).rows[0];
    assert.equal(maximum.bounded, true);
    await owner.query('UPDATE app.model_route_health SET until_at=NULL');
    const expiredOrdinary = randomUUID();
    await first.claim({}, expiredOrdinary, lease);
    await owner.query(
      "UPDATE app.model_route_health_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE attempt_id=$1",
      [expiredOrdinary],
    );
    await first.finish({}, expiredOrdinary, 'unavailable', 120000);
    assert.equal((await owner.query('SELECT until_at FROM app.model_route_health')).rows[0].until_at, null);
    await owner.query("UPDATE app.model_route_health SET until_at=clock_timestamp()-interval '1 second'");
    const expiredProbe = randomUUID();
    await second.claim({}, expiredProbe, lease);
    await owner.query("UPDATE app.model_route_health SET probe_until=clock_timestamp()-interval '1 second'");
    await second.finish({}, expiredProbe, null, null);
    assert.equal((await owner.query('SELECT probe_id FROM app.model_route_health')).rows[0].probe_id, expiredProbe);
    assert.equal(await first.claim({}, randomUUID(), lease), true);
  } finally {
    await other.end();
    await owner.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
