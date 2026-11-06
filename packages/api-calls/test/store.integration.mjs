import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { setup as secretsSetup } from '../../secrets/test/fixture.mjs';
import { createConversations } from '../../conversations/dist/index.js';
import {
  API_CALL_LIMITS,
  ApiCallDecisionConflict,
  apiCallLedger,
  decideApiCall,
  listTaskApiCalls,
  proposeApiCall,
  resumeApiCall,
  sendApiCall,
  viewApiCall,
} from '../dist/index.js';
import { routes, secretPort, server } from './https-fixture.mjs';

async function setup(t) {
  const f = await secretsSetup();
  t.after(() => f.close());
  const ws = f.workspace.id;
  const [member, other] = f.members;
  const api = await server(t, routes);
  const uses = [];
  const stored = {
    STRIPE: {
      name: 'Stripe',
      placement: { kind: 'bearer' },
      value: { value: 'sk-live-0123456789' },
      host: 'api.example.test',
    },
  };
  const secrets = secretPort(stored, uses);
  const read = action => f.runtime.transaction(ws, commonCompatibility, action);
  const confirm = action =>
    withMaintenanceTransaction({
      workspaceId: ws,
      connectionString: f.db.login(f.workspace, 'confirmation'),
      capability: 'confirmation',
      operation: action,
    });
  const chats = createConversations(f.runtime);
  async function waitingTurn(actor = member) {
    const conversationId = randomUUID();
    await chats.create(ws, actor.userId, { chatId: conversationId, commandId: randomUUID() });
    await chats.send(ws, actor.userId, conversationId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: 'Create the customer' }],
    });
    const turn = (
      await f.db.platform.query(
        `SELECT id, generation FROM ${f.table('tf_conversation_turns')} WHERE conversation_id=$1`,
        [conversationId],
      )
    ).rows[0];
    await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET status='waiting' WHERE id=$1`, [turn.id]);
    return { kind: 'chat', conversationId, turnId: turn.id, generation: turn.generation };
  }
  const call = (path = '/created', extra = {}) => ({
    tool: 'api.request',
    method: 'POST',
    url: `https://api.example.test${path}`,
    body: { kind: 'json', value: { email: 'ana@example.test' } },
    secrets: [{ variable: 'STRIPE' }],
    purpose: 'Create the customer',
    ...extra,
  });
  async function propose(origin, extra = {}) {
    const callId = randomUUID();
    const waiting = await proposeApiCall(f.runtime, {
      workspaceId: ws,
      membershipId: member.membershipId,
      origin,
      callId,
      call: call(),
      secrets,
      ...extra,
    });
    return { callId, waiting };
  }
  const view = (actor, callId) => read(tx => viewApiCall(tx, actor, callId));
  const decide = (actor, callId, input) => confirm(tx => decideApiCall(tx, actor, callId, input));
  const approve = async (callId, extra = {}) => {
    const current = await view(member, callId);
    return decide(member, callId, { commandId: randomUUID(), decision: 'approve', digest: current.digest, ...extra });
  };
  const resume = (callId, extra = {}) =>
    resumeApiCall(f.runtime, ws, callId, { secrets, dependencies: api.options().dependencies, ...extra });
  // Moves a row past a time without the transition trigger, as the clock would.
  const bypass = sql =>
    f.db.platform.query(
      `BEGIN; ALTER TABLE ${f.table('tf_api_calls')} DISABLE TRIGGER tf_api_call_transition; ${sql}; ALTER TABLE ${f.table('tf_api_calls')} ENABLE TRIGGER tf_api_call_transition; COMMIT`,
    );
  const backdate = (callId, column) =>
    bypass(
      `UPDATE ${f.table('tf_api_calls')} SET ${column} = clock_timestamp() - interval '1 hour' WHERE id = '${callId}'`,
    );
  return {
    ...f,
    ws,
    member,
    other,
    api,
    uses,
    stored,
    secrets,
    read,
    confirm,
    waitingTurn,
    call,
    propose,
    view,
    decide,
    approve,
    resume,
    bypass,
    backdate,
  };
}

const rejects = (promise, expected) =>
  assert.rejects(promise, expected instanceof RegExp ? expected : error => error instanceof expected);

test('a change waits for its member, who alone sees it and decides it', async t => {
  const f = await setup(t);
  const origin = await f.waitingTurn();
  const { callId, waiting } = await f.propose(origin);
  assert.deepEqual(waiting, { provider: 'api-call', kind: 'waiting', callId });
  assert.deepEqual(await f.propose(origin, { callId }).then(r => r.waiting), waiting);
  assert.equal(f.api.received.length, 0);

  const seen = await f.view(f.member, callId);
  assert.equal(seen.status, 'awaiting-approval');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, 'https://api.example.test/created');
  assert.deepEqual(seen.secrets, [{ name: 'Stripe', placement: { kind: 'bearer' } }]);
  assert.equal(seen.body.preview, '{"email":"ana@example.test"}');
  assert.equal(seen.purpose, 'Create the customer');
  assert.ok(!JSON.stringify(seen).includes('sk-live'));
  assert.equal(await f.view(f.other, callId), undefined);
  assert.deepEqual(await f.resume(callId), { state: 'waiting' });

  await rejects(
    f.decide(f.other, callId, { commandId: randomUUID(), decision: 'approve', digest: seen.digest }),
    AccessDenied,
  );
  await rejects(
    f.decide(f.member, callId, { commandId: randomUUID(), decision: 'approve', digest: 'a'.repeat(64) }),
    ApiCallDecisionConflict,
  );
  const commandId = randomUUID();
  const decided = await f.decide(f.member, callId, { commandId, decision: 'approve', digest: seen.digest });
  assert.equal(decided.view.status, 'sending');
  assert.deepEqual(decided.origin, origin);
  const replay = await f.decide(f.member, callId, { commandId, decision: 'approve', digest: seen.digest });
  assert.equal(replay.view.id, callId);
  await rejects(
    f.decide(f.member, callId, { commandId: randomUUID(), decision: 'reject', digest: seen.digest }),
    ApiCallDecisionConflict,
  );
  await rejects(
    f.read(tx =>
      tx.client.query(
        `INSERT INTO "${tx.schema}".tf_api_call_decisions (call_id, membership_id, command_id, digest, decision) VALUES ($1,$2,$3,$4,'approve')`,
        [randomUUID(), f.member.membershipId, randomUUID(), seen.digest],
      ),
    ),
    /permission denied/,
  );
});

test('an approved change is sent once with its secret, and a second resume does not send again', async t => {
  const f = await setup(t);
  const { callId } = await f.propose(await f.waitingTurn());
  await f.approve(callId);
  const done = await f.resume(callId);
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'sent');
  assert.equal(done.result.response.status, 204);
  assert.equal(f.api.received.length, 1);
  assert.equal(f.api.received[0].method, 'POST');
  assert.equal(f.api.received[0].headers.authorization, 'Bearer sk-live-0123456789');
  assert.equal(f.api.received[0].body, '{"email":"ana@example.test"}');
  assert.equal(f.uses.length, 1);

  const again = await f.resume(callId);
  assert.equal(again.result.status, 'sent');
  assert.equal(again.result.response.status, 204);
  assert.equal(f.api.received.length, 1);
  const seen = await f.view(f.member, callId);
  assert.equal(seen.status, 'sent');
  assert.equal(seen.responseStatus, 204);
  const row = (await f.db.platform.query(`SELECT request FROM ${f.table('tf_api_calls')} WHERE id=$1`, [callId]))
    .rows[0];
  assert.equal(row.request, null);
  await rejects(
    f.db.platform.query(`UPDATE ${f.table('tf_api_calls')} SET status='failed' WHERE id=$1`, [callId]),
    /final/,
  );
});

test('an approved JSON body whose keys storage reorders is still sent', async t => {
  const f = await setup(t);
  const body = { kind: 'json', value: { name: 'Ana', email: 'ana@example.test', tags: [{ z: 1, a: 2 }] } };
  const { callId } = await f.propose(await f.waitingTurn(), { call: f.call('/created', { body }) });
  await f.approve(callId);
  const done = await f.resume(callId);
  assert.equal(done.result.status, 'sent');
  assert.equal(f.api.received[0].body, '{"email":"ana@example.test","name":"Ana","tags":[{"a":2,"z":1}]}');
});

test('a secret changed after approval is a conflict and nothing is sent', async t => {
  const f = await setup(t);
  const { callId } = await f.propose(await f.waitingTurn());
  await f.approve(callId);
  f.stored.STRIPE.version = 2;
  const done = await f.resume(callId);
  assert.equal(done.result.status, 'failed');
  assert.equal(done.result.code, 'conflict');
  assert.equal(f.api.received.length, 0);
  assert.equal((await f.view(f.member, callId)).status, 'conflict');

  f.stored.STRIPE.version = 1;
  const moved = await f.propose(await f.waitingTurn());
  await f.approve(moved.callId);
  f.stored.STRIPE.placement = { kind: 'header', name: 'x-api-key' };
  assert.equal((await f.resume(moved.callId)).result.code, 'conflict');
  assert.equal(f.api.received.length, 0);
});

test('a rejected change is not sent', async t => {
  const f = await setup(t);
  const { callId } = await f.propose(await f.waitingTurn());
  const seen = await f.view(f.member, callId);
  const decided = await f.decide(f.member, callId, {
    commandId: randomUUID(),
    decision: 'reject',
    digest: seen.digest,
    reason: 'Wrong account',
  });
  assert.equal(decided.view.status, 'rejected');
  const done = await f.resume(callId);
  assert.equal(done.result.status, 'failed');
  assert.equal(done.result.code, 'rejected');
  assert.equal(f.api.received.length, 0);
  assert.equal((await f.view(f.member, callId)).status, 'rejected');
});

test('an unanswered change expires and can no longer be approved', async t => {
  const f = await setup(t);
  const { callId } = await f.propose(await f.waitingTurn());
  const seen = await f.view(f.member, callId);
  await f.backdate(callId, 'expires_at');
  assert.equal((await f.view(f.member, callId)).status, 'expired');
  await rejects(
    f.decide(f.member, callId, { commandId: randomUUID(), decision: 'approve', digest: seen.digest }),
    ApiCallDecisionConflict,
  );
  const done = await f.resume(callId);
  assert.equal(done.result.code, 'expired');
  assert.equal(f.api.received.length, 0);
});

test('a change whose chat stopped waiting cannot be approved', async t => {
  const f = await setup(t);
  const origin = await f.waitingTurn();
  const { callId } = await f.propose(origin);
  await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET status='cancelled' WHERE id=$1`, [
    origin.turnId,
  ]);
  await rejects(f.approve(callId), ApiCallDecisionConflict);
});

test('a change that may have arrived is outcome-unknown and never retried', async t => {
  const f = await setup(t);
  const origin = await f.waitingTurn();
  const dropped = await f.propose(origin, { call: f.call('/drop') });
  await f.approve(dropped.callId);
  const done = await f.resume(dropped.callId);
  assert.equal(done.result.code, 'outcome-unknown');
  assert.equal(f.api.received.length, 1);
  assert.equal((await f.resume(dropped.callId)).result.code, 'outcome-unknown');
  assert.equal(f.api.received.length, 1);
  assert.equal((await f.view(f.member, dropped.callId)).status, 'outcome-unknown');

  const stuck = await f.propose(await f.waitingTurn());
  await f.approve(stuck.callId);
  await f.bypass(
    `UPDATE ${f.table('tf_api_calls')} SET status='sending', claimed_at=clock_timestamp(), deadline_at=clock_timestamp() + interval '1 hour' WHERE id='${stuck.callId}'`,
  );
  assert.deepEqual(await f.resume(stuck.callId), { state: 'waiting' });
  await f.backdate(stuck.callId, 'deadline_at');
  assert.equal((await f.resume(stuck.callId)).result.code, 'outcome-unknown');
  assert.equal(f.api.received.length, 1);
});

test('reads are not proposed, and task changes are listed for their member', async t => {
  const f = await setup(t);
  const origin = { kind: 'task', taskId: randomUUID(), runId: randomUUID() };
  const read = await f.propose(origin, { call: f.call('/json', { method: 'GET', body: undefined }) });
  assert.equal(read.waiting.code, 'invalid-request');
  const first = await f.propose(origin);
  const second = await f.propose(origin);
  const listed = await f.read(tx => listTaskApiCalls(tx, f.member, origin.taskId));
  assert.deepEqual(
    listed.map(call => call.id),
    [second.callId, first.callId],
  );
  assert.deepEqual(listed[0].origin, { kind: 'task', taskId: origin.taskId });
  assert.deepEqual(await f.read(tx => listTaskApiCalls(tx, f.other, origin.taskId)), []);
  await rejects(f.approve(first.callId), ApiCallDecisionConflict);
});

test('call limits are kept in the database across processes', async t => {
  const f = await setup(t);
  const origin = { kind: 'task', taskId: randomUUID(), runId: randomUUID() };
  const ledger = () => apiCallLedger(f.runtime, { workspaceId: f.ws, membershipId: f.member.membershipId, origin });
  const get = { tool: 'api.request', method: 'GET', url: 'https://api.example.test/json' };
  const options = () => ({ ...f.api.options({ workspaceId: f.ws }), calls: ledger() });
  for (let index = 0; index < API_CALL_LIMITS.callsPerScope - 1; index++)
    assert.equal((await sendApiCall(get, options())).status, 'sent');
  assert.equal((await f.propose(origin)).waiting.kind, 'waiting');
  assert.equal((await sendApiCall(get, options())).code, 'call-limit');
  assert.equal((await f.propose(origin)).waiting.code, 'call-limit');

  const busy = { kind: 'task', taskId: randomUUID(), runId: randomUUID() };
  const busyLedger = apiCallLedger(f.runtime, { workspaceId: f.ws, membershipId: f.member.membershipId, origin: busy });
  const held = [];
  for (let index = 0; index < API_CALL_LIMITS.inFlightPerWorkspace; index++)
    held.push(
      await busyLedger.start(
        { method: 'GET', redactedUrl: 'https://api.example.test/', host: 'api.example.test', timeoutMs: 30_000 },
        Date.now() + 30_000,
      ),
    );
  const timedOut = await sendApiCall(
    { ...get, timeoutSeconds: 1 },
    { ...f.api.options({ workspaceId: f.ws }), calls: busyLedger },
  );
  assert.equal(timedOut.code, 'timeout');
  await held[0].finish({ status: 'sent', responseStatus: 200, durationMs: 1 });
  assert.equal((await sendApiCall(get, { ...f.api.options({ workspaceId: f.ws }), calls: busyLedger })).status, 'sent');
});
