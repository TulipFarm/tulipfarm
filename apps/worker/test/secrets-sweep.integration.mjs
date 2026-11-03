import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';
import { createSecretsSweep } from '../src/secrets-sweep.ts';

const env = {
  SECRETS_ENABLED: 'true',
  INTEGRATION_CREDENTIAL_KEY_ID: 'test',
  INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
};

test('the secrets sweep expires an overdue form and resumes its chat', { timeout: 60000 }, async t => {
  const f = await requestFixture();
  t.after(() => f.close());
  const { db, table, workspace: w } = f;
  const fence = await f.start();
  const secretRequestId = randomUUID();
  const item = await f.requests.create(fence, {
    producerId: randomUUID(),
    prompt: 'Weather API key',
    answerSchema: { kind: 'secrets', secretRequestId },
  });
  await db.platform.query(
    `INSERT INTO ${table('tf_secret_requests')} (id, membership_id, origin, purpose, fields, destinations, status, expires_at)
     VALUES ($1, $2, $3, 'Read the forecast', $4, $5, 'waiting', clock_timestamp() - interval '1 minute')`,
    [
      secretRequestId,
      w.membershipId,
      {
        kind: 'chat',
        conversationId: fence.origin.conversationId,
        turnId: fence.origin.turnId,
        conversationRequestId: item.requestId,
      },
      JSON.stringify([{ id: 'key', label: 'API key', kind: 'api-key' }]),
      JSON.stringify([{ kind: 'host', value: 'api.weather.example' }]),
    ],
  );
  const failures = [];
  const sweep = createSecretsSweep(f.runtime, async after => (after ? [] : [w.id]), env);
  await sweep((workspaceId, error) => failures.push({ workspaceId, error }));
  assert.deepEqual(failures, []);
  const row = await db.platform.query(
    `SELECT s.status, r.status AS request, t.status AS turn FROM ${table('tf_secret_requests')} s
       JOIN ${table('tf_conversation_requests')} r ON r.id = $2
       JOIN ${table('tf_conversation_turns')} t ON t.id = r.turn_id WHERE s.id = $1`,
    [secretRequestId, item.requestId],
  );
  assert.deepEqual(row.rows[0], { status: 'expired', request: 'expired', turn: 'queued' });
});
