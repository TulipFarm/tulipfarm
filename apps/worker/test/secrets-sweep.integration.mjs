import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';
import { secretsServices } from '../src/secrets-composition.ts';
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

test('the secrets sweep ends the forms and temporary secrets of a deleted chat', { timeout: 60000 }, async t => {
  const f = await requestFixture();
  t.after(() => f.close());
  const { db, table, workspace: w } = f;
  const services = secretsServices(f.runtime, env);
  const fence = await f.start();
  const chat = { kind: 'chat', conversationId: fence.origin.conversationId, turnId: fence.origin.turnId };
  const request = {
    purpose: 'Read the forecast',
    fields: [{ id: 'key', label: 'API key', kind: 'api-key', placement: { kind: 'header', name: 'X-Api-Key' } }],
    destinations: [{ kind: 'host', host: 'api.weather.example' }],
  };
  const answered = randomUUID();
  const item = await f.requests.create(fence, {
    producerId: randomUUID(),
    prompt: request.purpose,
    answerSchema: { kind: 'secrets', secretRequestId: answered },
  });
  await services.secrets.transaction(w.id, tx =>
    services.requests.create(tx, {
      id: answered,
      membershipId: w.membershipId,
      origin: { ...chat, conversationRequestId: item.requestId },
      request,
    }),
  );
  const provided = await services.requests.submit(w.id, w.userId, answered, {
    requestId: randomUUID(),
    expectedRevision: 1,
    fields: [{ fieldId: 'key', value: { value: `sk-${randomUUID()}` }, lifetime: 'conversation' }],
  });
  assert.equal(provided.status, 'provided');
  const waiting = randomUUID();
  await services.secrets.transaction(w.id, tx =>
    services.requests.create(tx, {
      id: waiting,
      membershipId: w.membershipId,
      origin: { ...chat, conversationRequestId: randomUUID() },
      request,
    }),
  );
  const sweep = createSecretsSweep(f.runtime, async after => (after ? [] : [w.id]), env);
  const failures = [];
  await sweep((workspaceId, error) => failures.push({ workspaceId, error }));
  const active = `SELECT count(*)::int AS n FROM ${table('tf_secrets')} WHERE status = 'active' AND lifetime = 'conversation'`;
  assert.equal((await db.platform.query(active)).rows[0].n, 1, 'a live chat keeps its temporary secret');

  await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at = clock_timestamp() WHERE id = $1`, [
    chat.conversationId,
  ]);
  await sweep((workspaceId, error) => failures.push({ workspaceId, error }));
  assert.deepEqual(failures, []);
  assert.equal((await db.platform.query(active)).rows[0].n, 0);
  const status = await db.platform.query(`SELECT status FROM ${table('tf_secret_requests')} WHERE id = $1`, [waiting]);
  assert.equal(status.rows[0].status, 'cancelled');
});
