import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleFixture } from './fixture.mjs';

test('Google connect, scope loss, recovery and disconnect events stay private and skip ordinary rotation', async () => {
  const f = await googleFixture();
  try {
    const events = async () =>
      (
        await f.db.platform.query(
          `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE kind='integration' ORDER BY created_at,id`,
        )
      ).rows;
    let status = await f.connect();
    assert.deepEqual(await events(), [{ membership_ids: [f.member.membershipId], invalidate: false }]);
    await f.connect();
    f.advance(3_600_000);
    await f.service.withCredential(f.fence(status), async () => 'ok');
    assert.equal((await events()).length, 1);
    f.advance(3_600_000);
    f.behavior({ scopes: status.scopes.filter(scope => scope !== 'https://www.googleapis.com/auth/gmail.send') });
    await assert.rejects(
      f.service.withCredential(f.fence(status), async () => 'no'),
      /insufficient-scope/,
    );
    assert.equal((await events()).at(-1).invalidate, true);
    f.behavior({});
    status = await f.connect();
    assert.equal((await events()).at(-1).invalidate, false);
    f.advance(3_600_000);
    f.behavior({ throw: true });
    const count = (await events()).length;
    await assert.rejects(f.service.withCredential(f.fence(status), async () => 'no'));
    assert.equal((await events()).length, count);
    f.behavior({ refreshError: 'invalid_grant' });
    await assert.rejects(
      f.service.withCredential(f.fence(status), async () => 'no'),
      /reconnect-required/,
    );
    assert.deepEqual((await events()).at(-1), { membership_ids: [f.member.membershipId], invalidate: true });
    f.behavior({});
    await f.connect();
    await f.service.disconnect(f.workspace.id, f.member.userId);
    const disconnected = (await events()).length;
    await f.service.disconnect(f.workspace.id, f.member.userId);
    assert.equal((await events()).length, disconnected);
    assert.equal((await events()).at(-1).invalidate, true);
  } finally {
    await f.close();
  }
});
