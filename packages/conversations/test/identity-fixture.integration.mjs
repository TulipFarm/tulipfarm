import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { conversationFixture } from './fixture.mjs';
import { internalFixture } from './internal-fixture.mjs';

test('actor setup precedes admission and persisted internal ownership exactly once', async () => {
  const userId = randomUUID(),
    membershipId = randomUUID();
  let prepared = 0,
    closed = 0;
  const f = await internalFixture(undefined, async () => {
    prepared++;
    return {
      userId,
      membershipId,
      close: async () => {
        closed++;
      },
    };
  });
  try {
    assert.equal(prepared, 1);
    assert.equal(closed, 0);
    assert.equal(f.workspace.userId, userId);
    assert.equal(f.workspace.membershipId, membershipId);
    assert.deepEqual(f.actor, { kind: 'human', userId, membershipId });
    const commands = await f.db.platform.query(
      `SELECT user_id, membership_id FROM ${f.table('tf_agent_commands')} WHERE agent_id=$1`,
      [f.agentId],
    );
    assert.ok(commands.rows.length);
    assert.ok(commands.rows.every(row => row.user_id === userId && row.membership_id === membershipId));
    const mapping = await f.db.platform.query(
      `SELECT user_id, membership_id FROM ${f.table('tf_workspace_member_accounts')}`,
    );
    assert.deepEqual(mapping.rows, [{ user_id: userId, membership_id: membershipId }]);
  } finally {
    await f.close();
  }
  assert.equal(closed, 1);
});

test('failed initial admission closes the prepared actor resource', async () => {
  let closed = 0;
  await assert.rejects(
    conversationFixture(undefined, async () => ({
      userId: randomUUID(),
      membershipId: 'not-a-membership-id',
      close: async () => {
        closed++;
      },
    })),
    error => error.name === 'ZodError',
  );
  assert.equal(closed, 1);
});
