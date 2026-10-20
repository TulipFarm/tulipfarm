import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, denied } from './fixture.mjs';
import { invalidateRecommendationSource, recordRecommendationChange } from '../../src/recommendations.ts';

test(
  'recommendation events commit atomically, preserve the first window and invalidate private output',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let client, migration;
    try {
      const workspace = await db.create();
      client = await connect(db.login(workspace));
      const tx = { client, schema: workspace.names.schema, commonVersion: 30 };
      const table = name => `"${tx.schema}"."${name}"`;
      const change = () => ({
        id: randomUUID(),
        kind: 'memory',
        sourceId: workspace.membershipId,
        membershipIds: [workspace.membershipId],
      });
      const state = async () => (await client.query(`SELECT * FROM ${table('tf_recommendation_refresh')}`)).rows[0];
      const first = change();
      await client.query('BEGIN');
      assert.equal((await recordRecommendationChange(tx, first)).recorded, true);
      const initial = await state();
      assert.equal(initial.due_at - initial.first_event_at, 30000);
      assert.equal((await recordRecommendationChange(tx, first)).recorded, false);
      assert.equal((await state()).generation, '1');
      await client.query('SAVEPOINT event_test');
      await recordRecommendationChange(tx, change());
      assert.equal((await state()).generation, '2');
      await client.query('ROLLBACK TO SAVEPOINT event_test');
      assert.equal((await state()).generation, '1');
      await client.query('COMMIT');
      await assert.rejects(recordRecommendationChange(tx, { ...first, kind: 'repair' }), /conflict/);
      assert.equal((await state()).generation, '1', 'a changed-payload replay cannot change member state');

      for (const age of [10, 29]) {
        await client.query(
          `UPDATE ${table('tf_recommendation_refresh')} SET first_event_at=clock_timestamp()-$1*interval '1 second',due_at=clock_timestamp()+(30-$1)*interval '1 second'`,
          [age],
        );
        const before = await state();
        await recordRecommendationChange(tx, change());
        assert.equal(
          (await state()).due_at.toISOString(),
          before.due_at.toISOString(),
          `${age}-second arrival does not slide the window`,
        );
      }
      await client.query(
        `INSERT INTO ${table('tf_recommendation_snapshots')}(membership_id,fingerprint,items,policy)
      VALUES($1,$2,$3,'event-driven-v1')`,
        [workspace.membershipId, 'a'.repeat(64), JSON.stringify([{ private: 'fixture memory text' }])],
      );
      await client.query('BEGIN');
      await recordRecommendationChange(tx, { ...change(), invalidate: true });
      assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 0);
      await client.query('ROLLBACK');
      assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 1);
      await recordRecommendationChange(tx, { ...change(), invalidate: true });
      assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 0);

      await client.query(
        `UPDATE ${table('tf_recommendation_refresh')} SET claimed_generation=generation,attempt_id=$1,claimed_at=clock_timestamp(),first_event_at=NULL,due_at=NULL`,
        [randomUUID()],
      );
      const running = await state();
      await recordRecommendationChange(tx, change());
      const next = await state();
      assert.equal(next.claimed_generation, running.claimed_generation);
      assert.equal(Number(next.generation), Number(running.generation) + 1);
      assert.equal(next.due_at - next.first_event_at, 30000, 'events during inference create a new fixed window');

      migration = await connect(db.login(workspace, 'migration'));
      await denied(migration, `SELECT items FROM ${table('tf_recommendation_snapshots')}`);
      await recordRecommendationChange(
        { ...tx, client: migration },
        { ...change(), kind: 'definition', invalidate: true },
      );
      assert.equal((await state()).status, 'pending', 'maintenance writers can emit without reading personal text');
      await migration.query(`SET ROLE "${workspace.names.customOwner}"`);
      await denied(migration, `SELECT items FROM ${table('tf_recommendation_snapshots')}`);
      await denied(migration, `SELECT items FROM ${table('tf_recommendation_results')}`);
      await recordRecommendationChange(
        { ...tx, client: migration },
        { ...change(), kind: 'definition', invalidate: true },
      );
      await migration.query('RESET ROLE');
      const payloads = (
        await client.query(`SELECT to_jsonb(e)::text AS payload FROM ${table('tf_recommendation_events')} e`)
      ).rows;
      assert.ok(payloads.every(row => !row.payload.includes('fixture memory text')));
    } finally {
      await migration?.end();
      await client?.end();
      await db.close();
    }
  },
);

test('source invalidation fences private output without scheduling a new batch', { timeout: 60000 }, async () => {
  const db = await fixture();
  let client;
  try {
    const workspace = await db.create();
    client = await connect(db.login(workspace));
    const tx = { client, schema: workspace.names.schema, workspaceId: workspace.id, commonVersion: 30 };
    const table = name => `"${tx.schema}"."${name}"`;
    const pending = randomUUID(),
      unrelated = randomUUID(),
      sourceId = randomUUID(),
      attemptId = randomUUID();
    const members = [workspace.membershipId, pending, unrelated];
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')}(id,user_id,role)
      SELECT id,id::text,'member' FROM unnest($1::uuid[]) id`,
      [[pending, unrelated]],
    );
    await recordRecommendationChange(tx, {
      id: randomUUID(),
      kind: 'seed',
      sourceId: workspace.id,
      membershipIds: members,
    });
    await client.query(
      `UPDATE ${table('tf_recommendation_refresh')} SET status='running',
      claimed_generation=generation,attempt_id=$2,claimed_at=clock_timestamp(),first_event_at=NULL,due_at=NULL WHERE membership_id=$1`,
      [workspace.membershipId, attemptId],
    );
    await client.query(
      `UPDATE ${table('tf_recommendation_refresh')} SET status='ready',first_event_at=NULL,due_at=NULL WHERE membership_id=$1`,
      [unrelated],
    );
    await client.query(
      `INSERT INTO ${table('tf_recommendation_snapshots')}(membership_id,fingerprint,items)
      SELECT id,$2,$3::jsonb FROM unnest($1::uuid[]) id`,
      [members, 'a'.repeat(64), JSON.stringify([{ private: 'removed title' }])],
    );
    await client.query(
      `INSERT INTO ${table('tf_recommendation_results')}(membership_id,attempt_id,generation,fingerprint,onboarding,items,sources)
      VALUES($1,$2,1,$3,false,$4,'[]')`,
      [workspace.membershipId, attemptId, 'a'.repeat(64), JSON.stringify([{ private: 'removed title' }])],
    );
    await client.query(
      `INSERT INTO ${table('tf_recommendation_dependencies')}(membership_id,source_id)
      SELECT id,$2 FROM unnest($1::uuid[]) id`,
      [[workspace.membershipId, pending], sourceId],
    );
    const state = async id =>
      (await client.query(`SELECT * FROM ${table('tf_recommendation_refresh')} WHERE membership_id=$1`, [id])).rows[0];
    const originalPending = await state(pending),
      originalUnrelated = await state(unrelated);
    await client.query('BEGIN');
    await client.query('SAVEPOINT replacement');
    await invalidateRecommendationSource(tx, sourceId);
    assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 1);
    await client.query('ROLLBACK TO SAVEPOINT replacement');
    assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_snapshots')}`)).rowCount, 3);
    assert.equal((await state(workspace.membershipId)).attempt_id, attemptId);
    await client.query('ROLLBACK');

    const notifications = [];
    client.on('notification', message => notifications.push(JSON.parse(message.payload)));
    await client.query('LISTEN tulipfarm_recommendations_v1');
    await client.query('BEGIN');
    await invalidateRecommendationSource(tx, sourceId);
    await client.query('COMMIT');
    const cleared = await state(workspace.membershipId);
    assert.equal(cleared.status, 'unavailable');
    assert.equal(cleared.generation, '2');
    for (const key of ['first_event_at', 'due_at', 'claimed_generation', 'attempt_id', 'claimed_at'])
      assert.equal(cleared[key], null);
    assert.equal((await state(pending)).due_at.toISOString(), originalPending.due_at.toISOString());
    assert.equal((await state(pending)).status, 'pending', 'an independent pending event retains its deadline');
    assert.deepEqual(await state(unrelated), originalUnrelated);
    assert.deepEqual((await client.query(`SELECT membership_id FROM ${table('tf_recommendation_snapshots')}`)).rows, [
      { membership_id: unrelated },
    ]);
    assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_results')}`)).rowCount, 0);
    assert.equal((await client.query(`SELECT * FROM ${table('tf_recommendation_dependencies')}`)).rowCount, 0);
    assert.equal(
      (await client.query(`SELECT * FROM ${table('tf_recommendation_events')}`)).rowCount,
      1,
      'invalidation does not enqueue',
    );
    assert.deepEqual(
      new Set(notifications.map(message => message.membershipId)),
      new Set([workspace.membershipId, pending]),
    );
    assert.ok(
      notifications.every(
        message => message.kind === 'invalidated' && message.version === 2 && message.workspaceId === workspace.id,
      ),
    );
    await invalidateRecommendationSource(tx, sourceId);
    assert.deepEqual(
      await state(workspace.membershipId),
      cleared,
      'repeated invalidation without dependencies is a no-op',
    );
  } finally {
    await client?.end();
    await db.close();
  }
});
