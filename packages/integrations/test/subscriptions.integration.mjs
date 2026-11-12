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
