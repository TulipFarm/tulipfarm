import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountFixture } from './account-fixture.mjs';
import { createAtlassianOperations } from '../src/operations.ts';

test('Atlassian capability events scope shared grants and exclude identical grants and normal token refresh', async () => {
  const f = await accountFixture();
  try {
    const id = await f.connect('trello', 'business');
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [id],
        )
      ).rows;
    assert.deepEqual(await events(), [{ membership_ids: [f.member.membershipId], invalidate: false }]);
    const grants = { expectedVersion: 1, memberIds: [f.member.membershipId, f.one.membershipId], teamIds: [] };
    await f.service.setGrants(f.one.id, f.member.userId, id, grants);
    assert.deepEqual((await events()).at(-1), { membership_ids: [f.one.membershipId], invalidate: false });
    await f.service.setGrants(f.one.id, f.member.userId, id, {
      ...grants,
      expectedVersion: 2,
      memberIds: [...grants.memberIds].reverse(),
    });
    assert.equal((await events()).length, 2);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_atlassian_accounts')} SET expires_at=clock_timestamp() WHERE id=$1`,
      [id],
    );
    await f.service.withAccessToken(f.one.id, f.member.userId, id, async () => 'read');
    assert.equal((await events()).length, 2);
    await f.service.setGrants(f.one.id, f.member.userId, id, {
      expectedVersion: 3,
      memberIds: [f.member.membershipId],
      teamIds: [],
    });
    assert.deepEqual((await events()).at(-1), { membership_ids: [f.one.membershipId], invalidate: true });
    await f.service.disconnect(f.one.id, f.member.userId, id);
    assert.deepEqual((await events()).at(-1), { membership_ids: [f.member.membershipId], invalidate: true });
    const count = (await events()).length;
    await f.service.disconnect(f.one.id, f.member.userId, id);
    assert.equal((await events()).length, count);
  } finally {
    await f.close();
  }
});

test('Atlassian selected source creation and concurrent disable emit one event per actual change', async () => {
  const f = await accountFixture();
  try {
    const accountId = await f.connect();
    const operations = createAtlassianOperations({ runtime: f.runtime, accounts: f.service });
    const source = await operations.createSource(f.one.id, f.member.userId, {
      name: 'Board',
      accountId,
      binding: { kind: 'trello', boardId: 'a'.repeat(24) },
    });
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [source.id],
        )
      ).rows;
    assert.deepEqual(await events(), [{ membership_ids: [f.member.membershipId], invalidate: false }]);
    await operations.sources(f.one.id, f.member.userId);
    assert.equal((await events()).length, 1);
    await Promise.all([
      operations.disableSource(f.one.id, f.member.userId, source.id),
      operations.disableSource(f.one.id, f.member.userId, source.id),
    ]);
    assert.deepEqual(await events(), [
      { membership_ids: [f.member.membershipId], invalidate: false },
      { membership_ids: [f.member.membershipId], invalidate: true },
    ]);
  } finally {
    await f.close();
  }
});
