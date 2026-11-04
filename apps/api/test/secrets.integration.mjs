import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerSecrets } from '../src/secrets.ts';
import { secretsServices } from '../src/secrets-composition.ts';
import { requestFixture } from '../../../packages/conversations/test/request-fixture.mjs';

const env = {
  INTEGRATION_CREDENTIAL_KEY_ID: 'test',
  INTEGRATION_CREDENTIAL_KEY: '33'.repeat(32),
};

test('a submitted secrets form answers the chat request without exposing the value', { timeout: 60000 }, async () => {
  let authenticated;
  const f = await requestFixture(undefined, async db => {
      authenticated = await authenticatedFixture(db);
      return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
    }),
    app = Fastify();
  try {
    const { db, table, workspace: w } = f;
    await authenticated.addAdmin(w);
    const { auth, owner, admin } = authenticated;
    const services = secretsServices(f.runtime, env);
    registerSecrets(app, auth, services);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    async function http(path, method = 'GET', body, human = owner) {
      const response = await fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: {
          cookie: human.cookie,
          origin: 'http://localhost:5173',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, body: await response.json() };
    }

    assert.deepEqual((await http('/secrets/capabilities')).body, { enabled: true });
    const fence = await f.start();
    const secretRequestId = randomUUID();
    const item = await f.requests.create(fence, {
      producerId: randomUUID(),
      prompt: 'Weather API key',
      answerSchema: { kind: 'secrets', secretRequestId },
    });
    await services.secrets.transaction(w.id, tx =>
      services.requests.create(tx, {
        id: secretRequestId,
        membershipId: w.membershipId,
        origin: {
          kind: 'chat',
          conversationId: fence.origin.conversationId,
          turnId: fence.origin.turnId,
          conversationRequestId: item.requestId,
        },
        request: {
          purpose: 'Read the forecast',
          fields: [{ id: 'key', label: 'API key', kind: 'api-key', placement: { kind: 'bearer' } }],
          destinations: [{ kind: 'host', host: 'api.weather.example' }],
        },
      }),
    );
    const form = `/secret-requests/${secretRequestId}`;
    const view = await http(form);
    assert.equal(view.status, 200);
    assert.equal(view.body.status, 'waiting');
    assert.equal((await http(form, 'GET', undefined, admin)).status, 404);

    await assert.rejects(
      f.requests.answer(w.id, owner.id, fence.origin.conversationId, item.requestId, randomUUID(), {
        commandId: randomUUID(),
        expectedRevision: 1,
        answer: { kind: 'text', text: 'typed into the chat' },
      }),
      { message: 'request-conflict' },
    );

    const value = 'sk-weather-0123456789';
    const invalid = await http(`${form}/submit`, 'POST', {
      requestId: randomUUID(),
      expectedRevision: 1,
      fields: [{ fieldId: 'key', value: { value }, lifetime: 'forever' }],
    });
    assert.deepEqual(invalid, { status: 400, body: { error: 'invalid-secret' } });
    const submit = {
      requestId: randomUUID(),
      expectedRevision: 1,
      fields: [{ fieldId: 'key', value: { value }, lifetime: 'conversation' }],
    };
    const provided = await http(`${form}/submit`, 'POST', submit);
    assert.equal(provided.status, 200, JSON.stringify(provided.body));
    assert.equal(provided.body.status, 'provided');
    assert.equal(JSON.stringify(provided.body).includes(value), false);
    assert.deepEqual(await http(`${form}/submit`, 'POST', submit), provided);
    assert.equal((await http(`${form}/submit`, 'POST', { ...submit, requestId: randomUUID() })).status, 409);

    const conversation = await db.platform.query(
      `SELECT r.status, s.answer, t.status AS turn FROM ${table('tf_conversation_requests')} r
         JOIN ${table('tf_conversation_responses')} s ON s.request_id = r.id
         JOIN ${table('tf_conversation_turns')} t ON t.id = r.turn_id WHERE r.id = $1`,
      [item.requestId],
    );
    assert.equal(conversation.rows[0].status, 'answered');
    assert.equal(conversation.rows[0].turn, 'queued');
    assert.equal(conversation.rows[0].answer.kind, 'secrets');
    assert.equal(conversation.rows[0].answer.references[0].referenceId, provided.body.references[0].referenceId);
    assert.equal(JSON.stringify(conversation.rows).includes(value), false);

    const listed = await http('/secrets');
    assert.equal(listed.body.secrets.length, 1);
    assert.equal(listed.body.secrets[0].lifetime, 'conversation');
    assert.equal(JSON.stringify(listed.body).includes(value), false);
    const created = await http('/secrets', 'POST', {
      requestId: randomUUID(),
      name: 'Billing',
      kind: 'api-key',
      value: { value: 'sk-billing-0123456789' },
      placement: { kind: 'bearer' },
      destinations: [{ kind: 'host', host: 'billing.example' }],
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.lifetime, 'saved');
    assert.equal('credential' in created.body, false);
    assert.equal((await http(`/secrets/${created.body.id}/history`, 'GET', undefined, admin)).status, 404);
    assert.equal(listed.body.secrets[0].variableName, 'API_KEY');
    assert.equal(created.body.variableName, 'BILLING_KEY');
    const names = `/secrets/${created.body.id}/names`;
    assert.deepEqual(await http(names, 'PUT', { variableName: 'api_key' }), {
      status: 409,
      body: { error: 'secret-variable-name-taken' },
    });
    assert.deepEqual(await http(names, 'PUT', {}), { status: 400, body: { error: 'invalid-secret' } });
    assert.deepEqual(await http(names, 'PUT', { variableName: '1-key' }), {
      status: 400,
      body: { error: 'invalid-secret' },
    });
    assert.equal((await http(names, 'PUT', { name: 'Mine' }, admin)).status, 404);
    const renamed = await http(names, 'PUT', { name: 'Billing live', variableName: 'billing_live_key' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, 'Billing live');
    assert.equal(renamed.body.variableName, 'BILLING_LIVE_KEY');
    const deleted = await http(`/secrets/${created.body.id}`, 'DELETE', {
      requestId: randomUUID(),
      expectedVersion: 1,
    });
    assert.deepEqual(deleted.body, { deleted: true });
  } finally {
    await app.close();
    await f.close();
  }
});

test('secrets routes report disabled without the encryption key', { timeout: 60000 }, async () => {
  let authenticated;
  const f = await requestFixture(undefined, async db => {
      authenticated = await authenticatedFixture(db);
      return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
    }),
    app = Fastify();
  try {
    registerSecrets(app, authenticated.auth, secretsServices(f.runtime, {}));
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const call = (path, method = 'GET', body) =>
      fetch(`${url}/workspaces/${f.workspace.id}${path}`, {
        method,
        headers: {
          cookie: authenticated.owner.cookie,
          origin: 'http://localhost:5173',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.deepEqual((await call('/secrets/capabilities')).body, { enabled: false });
    const created = await call('/secrets', 'POST', {
      requestId: randomUUID(),
      name: 'Billing',
      kind: 'api-key',
      value: { value: 'sk-billing-0123456789' },
      placement: { kind: 'bearer' },
      destinations: [{ kind: 'host', host: 'billing.example' }],
    });
    assert.deepEqual(created, { status: 503, body: { error: 'secrets-disabled' } });
  } finally {
    await app.close();
    await f.close();
  }
});

test('answering a task’s secrets form wakes the task, and only its owner can', { timeout: 60000 }, async () => {
  let authenticated;
  const f = await requestFixture(undefined, async db => {
      authenticated = await authenticatedFixture(db);
      return { userId: authenticated.owner.id, close: () => authenticated.identity.end() };
    }),
    app = Fastify();
  try {
    const { workspace: w } = f;
    await authenticated.addAdmin(w);
    const { auth, owner, admin } = authenticated;
    const services = secretsServices(f.runtime, env);
    const woken = [];
    registerSecrets(app, auth, services, async (workspaceId, taskId) => void woken.push([workspaceId, taskId]));
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const http = (path, method = 'GET', body, human = owner) =>
      fetch(`${url}/workspaces/${w.id}${path}`, {
        method,
        headers: {
          cookie: human.cookie,
          origin: 'http://localhost:5173',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }).then(async response => ({ status: response.status, body: await response.json() }));
    const taskId = randomUUID(),
      ids = [randomUUID(), randomUUID()];
    for (const id of ids)
      await services.secrets.transaction(w.id, tx =>
        services.requests.create(tx, {
          id,
          membershipId: w.membershipId,
          origin: { kind: 'task', taskId, runId: randomUUID() },
          request: {
            purpose: 'Read the billing invoices',
            fields: [{ id: 'key', label: 'Billing token', kind: 'token', placement: { kind: 'bearer' } }],
            destinations: [{ kind: 'host', host: 'billing.example' }],
          },
        }),
      );
    assert.deepEqual(await http(`/agent-tasks/${taskId}/secret-requests`), { status: 200, body: { requests: [] } });

    const submit = {
      requestId: randomUUID(),
      expectedRevision: 1,
      fields: [{ fieldId: 'key', value: { value: 'billing-token-0123' }, lifetime: 'conversation' }],
    };
    assert.equal((await http(`/secret-requests/${ids[0]}/submit`, 'POST', submit, admin)).status, 404);
    assert.deepEqual(woken, []);
    const provided = await http(`/secret-requests/${ids[0]}/submit`, 'POST', submit);
    assert.equal(provided.status, 200, JSON.stringify(provided.body));
    assert.deepEqual(woken, [[w.id, taskId]]);
    const declined = await http(`/secret-requests/${ids[1]}/decline`, 'POST', {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.deepEqual(woken, [
      [w.id, taskId],
      [w.id, taskId],
    ]);
  } finally {
    await app.close();
    await f.close();
  }
});
