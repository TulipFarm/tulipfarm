import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRecommendationOperations } from '../src/operations.ts';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { markWorkspaceReady } from '../../workspace-storage/test/integration/fixture.mjs';

test('explicit operations are bounded, restartable, scoped, eligible and idempotent', { timeout: 60000 }, async () => {
  const f = await conversationFixture();
  try {
    await markWorkspaceReady(f.db.platform, f.workspace.id);
    const members = Array.from({ length: 4 }, () => ({ id: randomUUID(), userId: randomUUID() }));
    for (const member of members)
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
        member.id,
        member.userId,
      ]);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      members[3].id,
    ]);
    const operation = createRecommendationOperations({
      pool: f.db.platform,
      runtime: f.runtime,
      eligible: async (_workspaceId, userId) => userId !== members[2].userId,
    });
    const request = {
      operationId: randomUUID(),
      mode: 'backfill',
      apply: false,
      workspaceId: f.workspace.id,
      limit: 2,
    };
    const count = async () =>
      (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_recommendation_events')}`)).rows[0]
        .count;
    const dry = await operation.page(request);
    assert.equal(dry.scanned, 2);
    assert.equal(dry.queued, 0);
    assert.equal(await count(), 0);
    let cursor = null,
      scanned = 0,
      queued = 0;
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 5);
      const result = await operation.page({ ...request, apply: true, after: cursor });
      scanned += result.scanned;
      queued += result.queued;
      cursor = result.next;
      if (!cursor) break;
    }
    assert.equal(scanned, 4, 'removed memberships are excluded');
    assert.equal(queued, 3, 'ineligible memberships are excluded');
    assert.equal(await count(), 3);
    const replay = await operation.page({ ...request, apply: true });
    assert.equal(replay.queued, 0);
    assert.equal(await count(), 3);
    const member = members[0];
    const repair = { ...request, operationId: randomUUID(), mode: 'repair', apply: true, membershipId: member.id };
    assert.equal((await operation.page(repair)).queued, 1);
    assert.equal((await operation.page(repair)).queued, 0);
    await assert.rejects(operation.page({ ...repair, mode: 'backfill' }), /recommendation-event-conflict/);
    const generations = (
      await f.db.platform.query(`SELECT membership_id,generation FROM ${f.table('tf_recommendation_refresh')}`)
    ).rows;
    assert.equal(generations.find(row => row.membership_id === member.id).generation, '2');
    assert.ok(generations.every(row => row.membership_id !== members[2].id && row.membership_id !== members[3].id));
    await assert.rejects(operation.page({ ...request, limit: 101 }));
  } finally {
    await f.close();
  }
});
