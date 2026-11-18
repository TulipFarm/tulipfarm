import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createSubscriptions, SubscriptionError } from '../dist/subscriptions.js';
import { fixture } from './fixture.mjs';

test('only a plan owner turns its models off, and everyone who uses it follows', { timeout: 300000 }, async () => {
  const db = await fixture();
  try {
    const subscriptions = createSubscriptions({ runtime: db.runtime });
    const connectionId = randomUUID();
    const models = [
      { slug: 'gpt-sol', label: 'GPT Sol' },
      { slug: 'gpt-luna', label: 'GPT Luna' },
    ];
    await db.owner.query(
      `INSERT INTO ${db.table('tf_subscription_connections')}
         (id, provider, owner_membership_id, state, client_id, subject, credential, expires_at, models)
       VALUES ($1, 'chatgpt', $2, 'connected', 'client', 'subject', '{}', now() + interval '1 hour', $3)`,
      [connectionId, db.actor.membershipId, JSON.stringify(models)],
    );
    await db.owner.query(
      `INSERT INTO ${db.table('tf_subscription_grants')} (connection_id, grantee, role, granted_by)
       VALUES ($1, 'workspace', 'use', $2)`,
      [connectionId, db.actor.membershipId],
    );

    await assert.rejects(
      subscriptions.setDisabledModels(db.workspaceId, db.member.userId, connectionId, ['gpt-sol']),
      AccessDenied,
    );
    await assert.rejects(
      subscriptions.setDisabledModels(db.workspaceId, db.actor.userId, connectionId, ['gpt-unknown']),
      error => error instanceof SubscriptionError && error.code === 'invalid-model',
    );

    await subscriptions.setDisabledModels(db.workspaceId, db.actor.userId, connectionId, ['gpt-sol']);
    const [shared] = await subscriptions.list(db.workspaceId, db.member.userId);
    assert.equal(shared.mine, false);
    assert.deepEqual(shared.disabledModels, ['gpt-sol']);
    const [candidate] = await subscriptions.eligible(db.workspaceId, 'chatgpt', db.member.membershipId);
    assert.deepEqual(candidate.models, ['gpt-luna']);
    assert.deepEqual(candidate.disabled, ['gpt-sol']);

    await subscriptions.setDisabledModels(db.workspaceId, db.actor.userId, connectionId, ['gpt-sol', 'gpt-luna']);
    assert.deepEqual(await subscriptions.eligible(db.workspaceId, 'chatgpt', db.member.membershipId), []);
  } finally {
    await db.close();
  }
});

test('a sign-in attempt stores its callback or device page address', { timeout: 300000 }, async () => {
  const db = await fixture();
  try {
    const insert = (redirect, state) =>
      db.owner.query(
        `INSERT INTO ${db.table('tf_subscription_connection_attempts')}
           (id, provider, membership_id, state_hash, mode, client_id, redirect_uri, secret, status, expires_at)
         VALUES ($1, 'copilot', $2, $3, 'connect', 'client', $4, '{}', 'pending', now() + interval '10 minutes')`,
        [randomUUID(), db.actor.membershipId, state.repeat(64), redirect],
      );
    await insert('https://github.com/login/device', 'a');
    await insert('http://127.0.0.1:1455/auth/callback', 'b');
    await assert.rejects(insert(`https://${'x'.repeat(501)}`, 'c'), /redirect_uri_check/);
    await assert.rejects(insert('http://example.com/auth/callback', 'd'), /redirect_uri_check/);
  } finally {
    await db.close();
  }
});

test(
  'a plan that reports its usage limit stays listed as limited until it answers again',
  { timeout: 300000 },
  async () => {
    const db = await fixture();
    try {
      const subscriptions = createSubscriptions({ runtime: db.runtime });
      const own = randomUUID();
      const shared = randomUUID();
      const insert = (id, owner, models) =>
        db.owner.query(
          `INSERT INTO ${db.table('tf_subscription_connections')}
           (id, provider, owner_membership_id, state, client_id, subject, credential, expires_at, models)
         VALUES ($1, 'chatgpt', $2, 'connected', 'client', $4, '{}', now() + interval '1 hour', $3)`,
          [id, owner, JSON.stringify(models), id],
        );
      await insert(own, db.member.membershipId, [{ slug: 'gpt-sol', label: 'GPT Sol' }]);
      await insert(shared, db.actor.membershipId, [
        { slug: 'gpt-sol', label: 'GPT Sol' },
        { slug: 'gpt-luna', label: 'GPT Luna' },
      ]);
      await db.owner.query(
        `INSERT INTO ${db.table('tf_subscription_grants')} (connection_id, grantee, role, granted_by)
       VALUES ($1, 'workspace', 'use', $2)`,
        [shared, db.actor.membershipId],
      );
      const plans = async () =>
        Object.fromEntries(
          (await subscriptions.models(db.workspaceId, db.member.userId, 'chatgpt')).map(({ slug, plan }) => [
            slug,
            { id: plan.connectionId, own: plan.own, limited: plan.limitedAt !== null },
          ]),
        );
      assert.deepEqual(await plans(), {
        'gpt-sol': { id: own, own: true, limited: false },
        'gpt-luna': { id: shared, own: false, limited: false },
      });

      await subscriptions.coolDown(db.workspaceId, own, undefined, true);
      // Runs skip the plan while it cools down; the picker still offers its models, on a plan that is not limited.
      assert.deepEqual(
        (await subscriptions.eligible(db.workspaceId, 'chatgpt', db.member.membershipId)).map(
          plan => plan.connectionId,
        ),
        [shared],
      );
      assert.deepEqual(await plans(), {
        'gpt-sol': { id: shared, own: false, limited: false },
        'gpt-luna': { id: shared, own: false, limited: false },
      });
      await subscriptions.coolDown(db.workspaceId, shared, undefined, true);
      assert.deepEqual(await plans(), {
        'gpt-sol': { id: own, own: true, limited: true },
        'gpt-luna': { id: shared, own: false, limited: true },
      });
      // A refusal for another reason cools the plan down without calling it limited.
      await subscriptions.answered(db.workspaceId, shared);
      await subscriptions.coolDown(db.workspaceId, shared);
      assert.equal((await plans())['gpt-luna'].limited, false);
      await subscriptions.answered(db.workspaceId, own);
      assert.equal((await plans())['gpt-sol'].limited, false);

      // A workspace still below the usage-limit migration neither records nor reports the limit.
      const older = createSubscriptions({
        runtime: {
          ...db.runtime,
          transaction: (id, range, operation) =>
            db.runtime.transaction(id, range, tx => operation({ ...tx, commonVersion: 84 })),
        },
      });
      const limitedAt = async () =>
        (
          await db.owner.query(
            `SELECT usage_limited_at FROM ${db.table('tf_subscription_connections')} WHERE id = $1`,
            [own],
          )
        ).rows[0].usage_limited_at;
      await older.coolDown(db.workspaceId, own, undefined, true);
      assert.equal(await limitedAt(), null);
      await subscriptions.coolDown(db.workspaceId, own, undefined, true);
      assert.equal(
        (await older.models(db.workspaceId, db.member.userId, 'chatgpt')).every(model => model.plan.limitedAt === null),
        true,
      );
      await older.answered(db.workspaceId, own);
      assert.notEqual(await limitedAt(), null);
    } finally {
      await db.close();
    }
  },
);

test(
  'any number of plan accounts can be on for chats or coding, and the picked one is tried first',
  { timeout: 300000 },
  async () => {
    const db = await fixture();
    try {
      const subscriptions = createSubscriptions({ runtime: db.runtime });
      const [first, second, off, shared] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const insert = (id, owner, at) =>
        db.owner.query(
          `INSERT INTO ${db.table('tf_subscription_connections')}
           (id, provider, owner_membership_id, state, client_id, subject, credential, expires_at, models, created_at)
         VALUES ($1, 'claude', $2, 'connected', 'client', $4, '{}', now() + interval '1 hour', '[]', now() - $3::interval)`,
          [id, owner, at, id],
        );
      await insert(first, db.member.membershipId, '3 hours');
      await insert(second, db.member.membershipId, '2 hours');
      await insert(off, db.member.membershipId, '1 hour');
      await insert(shared, db.actor.membershipId, '4 hours');
      await db.owner.query(
        `INSERT INTO ${db.table('tf_subscription_grants')} (connection_id, grantee, role, granted_by)
       VALUES ($1, 'workspace', 'use', $2)`,
        [shared, db.actor.membershipId],
      );
      const eligible = (use, preferred) =>
        subscriptions
          .eligible(db.workspaceId, 'claude', db.member.membershipId, use, preferred)
          .then(plans => plans.map(plan => plan.connectionId));

      await assert.rejects(subscriptions.setUses(db.workspaceId, db.actor.userId, off, { chat: false }), AccessDenied);
      await subscriptions.setUses(db.workspaceId, db.member.userId, off, { chat: false, coding: false });
      await subscriptions.setUses(db.workspaceId, db.actor.userId, shared, { coding: false });

      assert.deepEqual(await eligible('chat'), [first, second, shared]);
      assert.deepEqual(await eligible('chat', second), [second, first, shared]);
      // A picked account that is off for the use, or not one the member may use, changes nothing.
      assert.deepEqual(await eligible('chat', off), [first, second, shared]);
      assert.deepEqual(await eligible('coding', shared), [first, second]);

      const listed = Object.fromEntries(
        (await subscriptions.list(db.workspaceId, db.member.userId)).map(row => [
          row.connectionId,
          [row.useForChat, row.useForCoding],
        ]),
      );
      assert.deepEqual(listed[off], [false, false]);
      assert.deepEqual(listed[first], [true, true]);
      assert.deepEqual(listed[shared], [true, false]);

      await db.owner.query(
        `UPDATE ${db.table('tf_subscription_connections')} SET state = 'signed-out', credential = NULL WHERE id = $1`,
        [second],
      );
      await assert.rejects(
        subscriptions.setUses(db.workspaceId, db.member.userId, second, { chat: false }),
        error => error instanceof SubscriptionError && error.code === 'not-connected',
      );
      assert.deepEqual(await eligible('chat', second), [first, shared]);
    } finally {
      await db.close();
    }
  },
);
