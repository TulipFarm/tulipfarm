import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createTokenPlan, TokenPlanError } from '../dist/token-plans.js';
import { fixture } from './fixture.mjs';

const token = `sk-ant-oat01-${'a1B2_c3-'.repeat(8)}`;
const models = [
  { slug: 'claude-sonnet-5', label: 'Claude Sonnet' },
  { slug: 'claude-haiku-4-5', label: 'Claude Haiku' },
];

function claudePlan(db, verify) {
  return createTokenPlan({ provider: 'claude', runtime: db.runtime, keyring: db.keyring, verify });
}

const connections = db =>
  db.owner
    .query(`SELECT owner_membership_id, state, credential FROM ${db.table('tf_subscription_connections')}`)
    .then(result => result.rows);

test(
  'a verified Claude token is stored encrypted and lists only its own models to its owner',
  { timeout: 300000 },
  async () => {
    const db = await fixture();
    try {
      const checked = [];
      const plan = claudePlan(db, async value => {
        checked.push(value);
        return { models, account: 'owner@example.com' };
      });
      const status = await plan.connectToken(
        db.workspaceId,
        db.actor.userId,
        `${token.slice(0, 30)}\n  ${token.slice(30)}`,
      );
      assert.deepEqual(checked, [token]);
      const [{ connectionId, createdAt, ...connected }] = status.connections;
      assert.equal(status.connections.length, 1);
      assert.ok(createdAt);
      assert.deepEqual(connected, { state: 'connected', account: 'owner@example.com', planUsage: true, models });

      const [row] = await connections(db);
      assert.equal(row.owner_membership_id, db.actor.membershipId);
      assert.ok(row.credential.ciphertext);
      assert.ok(!JSON.stringify(row).includes(token.slice('sk-ant-oat01-'.length)));
      assert.equal(await plan.accessToken(db.workspaceId, connectionId), token);
      assert.deepEqual(await plan.memberModels(db.workspaceId, db.actor.userId), [
        'claude-sonnet-5',
        'claude-haiku-4-5',
      ]);

      assert.deepEqual(await plan.status(db.workspaceId, db.member.userId), { connections: [] });
      assert.deepEqual(await plan.memberModels(db.workspaceId, db.member.userId), []);
      await assert.rejects(plan.disconnect(db.workspaceId, db.member.userId, connectionId), AccessDenied);
      assert.equal(await plan.accessToken(db.workspaceId, connectionId), token);

      await plan.disconnect(db.workspaceId, db.actor.userId, connectionId);
      const [signedOut] = await connections(db);
      assert.equal(signedOut.state, 'signed-out');
      assert.equal(signedOut.credential, null);
      // A signed-out connection is no longer listed.
      assert.deepEqual(await plan.status(db.workspaceId, db.actor.userId), { connections: [] });
      await assert.rejects(
        plan.accessToken(db.workspaceId, connectionId),
        error => error instanceof TokenPlanError && error.code === 'not-connected',
      );
    } finally {
      await db.close();
    }
  },
);

test('a token the vendor refuses, or that is not a setup token, stores nothing', { timeout: 300000 }, async () => {
  const db = await fixture();
  try {
    const refusals = [new TokenPlanError('copilot', 'not-eligible'), new Error('socket hang up')];
    const plan = claudePlan(db, async () => {
      throw refusals.shift();
    });
    await assert.rejects(
      plan.connectToken(db.workspaceId, db.actor.userId, token),
      error => error instanceof TokenPlanError && error.provider === 'claude' && error.code === 'not-eligible',
    );
    await assert.rejects(
      plan.connectToken(db.workspaceId, db.actor.userId, token),
      error => error instanceof TokenPlanError && error.code === 'unavailable',
    );
    await assert.rejects(
      plan.connectToken(db.workspaceId, db.actor.userId, 'sk-ant-api03-not-a-plan-token-at-all'),
      error => error instanceof TokenPlanError && error.code === 'token-invalid',
    );
    assert.deepEqual(await connections(db), []);
    assert.deepEqual(await plan.status(db.workspaceId, db.actor.userId), { connections: [] });
  } finally {
    await db.close();
  }
});

test(
  "a plan that can't list its models keeps its last list and asks again within minutes",
  { timeout: 300000 },
  async () => {
    const db = await fixture();
    try {
      const fallbackModels = [{ slug: 'claude-sonnet-5', label: 'Claude Sonnet 5' }];
      const answers = [{ models }, { models: fallbackModels, fallback: true }];
      const plan = claudePlan(db, async () => answers.shift());
      const fetchedAgo = () =>
        db.owner
          .query(
            `SELECT EXTRACT(EPOCH FROM clock_timestamp()-models_fetched_at) AS seconds FROM ${db.table('tf_subscription_connections')} WHERE state='connected'`,
          )
          .then(result => Number(result.rows[0].seconds));
      const expire = () =>
        db.owner.query(
          `UPDATE ${db.table('tf_subscription_connections')} SET models_fetched_at=clock_timestamp()-interval '2 hours'`,
        );

      const [{ connectionId }] = (await plan.connectToken(db.workspaceId, db.actor.userId, token)).connections;
      assert.ok((await fetchedAgo()) < 60);

      await expire();
      assert.deepEqual((await plan.status(db.workspaceId, db.actor.userId)).connections[0].models, models);
      assert.ok((await fetchedAgo()) > 50 * 60);

      answers.push({ models: fallbackModels, fallback: true });
      await plan.disconnect(db.workspaceId, db.actor.userId, connectionId);
      const reconnected = await plan.connectToken(db.workspaceId, db.actor.userId, token);
      assert.deepEqual(reconnected.connections[0].models, fallbackModels);
      assert.ok((await fetchedAgo()) > 50 * 60);
    } finally {
      await db.close();
    }
  },
);
