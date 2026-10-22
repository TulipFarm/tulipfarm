import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubCredentialRejected } from '@tulipfarm/github';
import { githubFixture } from './fixture.mjs';

test('GitHub emits owner-only integration and committed credential-rejection events, not reads or replay', async () => {
  const f = await githubFixture();
  try {
    const started = await f.begin();
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' AND source_id=$1 ORDER BY created_at,id`,
          [started.accountId],
        )
      ).rows;
    assert.deepEqual(await events(), []);
    await f.complete(started);
    assert.deepEqual(await events(), [{ membership_ids: [f.member.membershipId], invalidate: false }]);
    await assert.rejects(f.complete(started));
    await f.service.status(f.one.id, f.member.userId, started.accountId);
    await f.service.withCredential(f.one.id, f.member.userId, started.accountId, async () => 'read');
    assert.equal((await events()).length, 1);
    await assert.rejects(
      f.service.withCredential(f.one.id, f.member.userId, started.accountId, async () => {
        throw new GitHubCredentialRejected();
      }),
      /reconnect-required/,
    );
    assert.deepEqual((await events()).at(-1), { membership_ids: [f.member.membershipId], invalidate: true });
    const reconnect = await f.service.reconnect(f.one.id, f.member.userId, 'test-session', started.accountId);
    await f.complete({ state: new URL(reconnect.url).searchParams.get('state') });
    assert.equal((await events()).at(-1).invalidate, false);
    await f.service.disconnect(f.one.id, f.member.userId, started.accountId);
    const count = (await events()).length;
    await f.service.disconnect(f.one.id, f.member.userId, started.accountId);
    assert.equal((await events()).length, count);
    assert.equal((await events()).at(-1).invalidate, true);
  } finally {
    await f.close();
  }
});
