import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { escapeIdentifier } from 'pg';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { registerWorkflows } from '../src/workflows.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { registerSecurity, securityServerOptions } from '../src/security.ts';
import { createAbuseLimiter, registerAbuseHooks } from '../src/abuse.ts';

const steps = [{ id: 'copy', kind: 'transform', fields: { event: { kind: 'input', path: [] } } }];
const definition = trigger => ({ version: 1, name: 'Webhook proof', trigger, steps });
const key = () => randomBytes(32).toString('hex');

test(
  'webhook trigger rejects every non-admissible request and forgets its key when a non-webhook revision activates',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      app = Fastify({ ...securityServerOptions(), logger: false });
      registerSecurity(app, 'http://localhost:5173');
      app.register(
        async v1 => {
          protectBusinessRequests(v1);
          registerWorkflows(v1, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) =>
                  headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.ready();

      const base = `/v1/workspaces/${w.id}/workflows`,
        id = randomUUID();
      const headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const memberships = `${escapeIdentifier(w.names.schema)}.tf_memberships`;
      const operator = { id: 'workflow-webhook-operator', membershipId: randomUUID() };
      await db.databaseAdmin.query(`INSERT INTO ${memberships} (id,user_id,role) VALUES ($1,$2,'member')`, [
        operator.membershipId,
        operator.id,
      ]);
      const read = async () =>
        (await app.inject({ method: 'GET', url: base, headers })).json().find(item => item.id === id);
      async function save(trigger) {
        const revision = randomUUID(),
          current = await read();
        const saved = await app.inject({
          method: 'PUT',
          url: `${base}/${id}`,
          headers,
          payload: { revision, expectedRevision: current?.revision ?? null, definition: definition(trigger) },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        return revision;
      }
      async function activate(revision, enabled = true) {
        // Webhook runs are unattended, so each activated revision needs an explicit sponsor and history audience.
        if (enabled)
          await service.sponsorship(w.id, w.userId, id, {
            sponsorMembershipId: w.membershipId,
            historyAudience: [w.membershipId],
          });
        const response = await app.inject({
          method: 'POST',
          url: `${base}/${id}/activation`,
          headers,
          payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation, revision, enabled },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      async function setKey() {
        const response = await app.inject({
          method: 'PUT',
          url: `${base}/${id}/webhook-key`,
          headers,
          payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation, mode: 'bearer' },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      const send = (payload, authorization) =>
        app.inject({
          method: 'POST',
          url: `${base}/${id}/webhook`,
          headers: authorization === undefined ? {} : { authorization },
          payload,
        });
      const event = (input = { order: 1 }) => ({ requestId: randomUUID(), input });
      const runCount = async () => (await service.history(w.id, w.userId, id).then(page => page.runs)).length;

      const webhookRevision = await save({ kind: 'webhook' });
      const saved = await read();
      assert.equal(saved.webhookConfigured, false);
      assert.equal(saved.activeTrigger, null);
      assert.equal((await activate(webhookRevision)).activeTrigger?.kind, 'webhook');
      const chosen = await app.inject({
        method: 'PUT',
        url: `${base}/${id}/webhook-key`,
        headers,
        payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation, mode: 'bearer', key: key() },
      });
      assert.deepEqual(
        [chosen.statusCode, chosen.json()],
        [400, { error: 'invalid-request' }],
        'The server generates every key',
      );
      const { workflow: keyed, key: firstKey } = await setKey();
      assert.equal(keyed.webhookConfigured, true);
      const bearer = `Bearer ${firstKey}`;
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: `${base}/${id}/webhook`,
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      assert.equal(preflight.statusCode, 204, preflight.body);
      assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
      assert.match(preflight.headers['access-control-allow-headers'], /authorization/);
      assert.match(preflight.headers['access-control-allow-headers'], /content-type/);
      const accepted = await send(event(), bearer);
      assert.equal(accepted.statusCode, 200, accepted.body);
      const uppercase = await send({ requestId: randomUUID().toUpperCase(), input: null }, bearer);
      assert.equal(uppercase.statusCode, 200, `macOS uuidgen prints uppercase request IDs: ${uppercase.body}`);

      for (const authorization of [
        undefined,
        `Bearer ${firstKey.toUpperCase()}`,
        `Bearer ${firstKey.slice(1)}`,
        `Bearer  ${firstKey}`,
        `Basic ${firstKey}`,
        firstKey,
        `Bearer ${firstKey}x`,
        `Bearer ${key()}`,
      ]) {
        const response = await send(event(), authorization);
        assert.equal(response.statusCode, 404, `${authorization}: ${response.body}`);
        assert.deepEqual(response.json(), { error: 'workflow-not-found' });
      }

      const original = event({ order: 2 });
      const first = await send(original, bearer);
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual((await send(original, bearer)).json(), first.json());
      const conflict = await send({ ...original, input: { order: 3 } }, bearer);
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.deepEqual(conflict.json(), { error: 'request-conflict' });

      const oversized = await send(event({ blob: 'x'.repeat(65536) }), bearer);
      assert.equal(oversized.statusCode, 413, oversized.body);
      assert.deepEqual(oversized.json(), { error: 'request-too-large' });

      for (const payload of [
        { requestId: 'not-a-uuid', input: {} },
        { requestId: randomUUID() },
        { ...event(), extra: true },
        [],
      ]) {
        const response = await send(payload, bearer);
        assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`);
        assert.deepEqual(response.json(), { error: 'invalid-request' });
      }
      assert.equal(await runCount(), 3);

      const revokedId = randomUUID(),
        revokedRevision = randomUUID();
      const revokedSave = await app.inject({
        method: 'PUT',
        url: `${base}/${revokedId}`,
        headers,
        payload: { revision: revokedRevision, expectedRevision: null, definition: definition({ kind: 'webhook' }) },
      });
      assert.equal(revokedSave.statusCode, 200, revokedSave.body);
      const revokedGrant = await app.inject({
        method: 'PUT',
        url: `${base}/${revokedId}/grants`,
        headers,
        payload: { principal: { kind: 'person', id: operator.membershipId }, permissions: ['read', 'invoke'] },
      });
      assert.equal(revokedGrant.statusCode, 200, revokedGrant.body);
      await service.sponsorship(w.id, w.userId, revokedId, {
        sponsorMembershipId: operator.membershipId,
        historyAudience: [w.membershipId],
      });
      const sponsored = (await app.inject({ method: 'GET', url: base, headers }))
        .json()
        .find(item => item.id === revokedId);
      await service.acceptSponsorship(w.id, operator.id, revokedId, { expectedGeneration: sponsored.generation });
      const revokedCurrent = (await app.inject({ method: 'GET', url: base, headers }))
        .json()
        .find(item => item.id === revokedId);
      const revokedActivate = await app.inject({
        method: 'POST',
        url: `${base}/${revokedId}/activation`,
        headers,
        payload: {
          commandId: randomUUID(),
          expectedGeneration: revokedCurrent.generation,
          revision: revokedRevision,
          enabled: true,
        },
      });
      assert.equal(revokedActivate.statusCode, 200, revokedActivate.body);
      const revokedKeySave = await app.inject({
        method: 'PUT',
        url: `${base}/${revokedId}/webhook-key`,
        headers,
        payload: { commandId: randomUUID(), expectedGeneration: revokedActivate.json().generation, mode: 'bearer' },
      });
      assert.equal(revokedKeySave.statusCode, 200, revokedKeySave.body);
      const revokedKey = revokedKeySave.json().key;
      await db.databaseAdmin.query(`UPDATE ${memberships} SET removed_at=clock_timestamp() WHERE id=$1`, [
        operator.membershipId,
      ]);
      const revokedAccepted = await app.inject({
        method: 'POST',
        url: `${base}/${revokedId}/webhook`,
        headers: { authorization: `Bearer ${revokedKey}` },
        payload: event({ revoked: true }),
      });
      assert.equal(revokedAccepted.statusCode, 200, revokedAccepted.body);
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: revokedAccepted.json().runId }), {
        kind: 'done',
      });
      assert.deepEqual(
        (await service.history(w.id, w.userId, revokedId).then(page => page.runs)).map(run => [
          run.source,
          run.status,
          run.error,
        ]),
        [['webhook', 'blocked', 'authority-revoked']],
      );

      await activate(webhookRevision, false);
      assert.equal((await read()).webhookConfigured, true);
      const disabled = await send(event(), bearer);
      assert.equal(disabled.statusCode, 404, disabled.body);
      assert.deepEqual((await send(original, bearer)).statusCode, 404);
      await activate(webhookRevision, true);
      assert.equal((await send(event(), bearer)).statusCode, 200);

      const manualRevision = await save({ kind: 'manual' });
      const pending = await read();
      assert.equal(pending.definition.trigger.kind, 'manual');
      assert.equal(pending.activeTrigger?.kind, 'webhook');
      assert.equal(pending.webhookConfigured, true);
      assert.equal(
        (await send(event(), bearer)).statusCode,
        200,
        'The active webhook revision keeps receiving events while a different trigger is only saved',
      );
      const rotated = await setKey();
      assert.equal(
        (await send(event(), bearer)).statusCode,
        200,
        'The previous key keeps working during its grace period',
      );
      const switched = await activate(manualRevision);
      assert.equal(switched.activeTrigger?.kind, 'manual');
      assert.equal(switched.webhookConfigured, false);
      assert.equal((await send(event(), bearer)).statusCode, 404);

      const strayKey = key();
      const manualKey = await app.inject({
        method: 'PUT',
        url: `${base}/${id}/webhook-key`,
        headers,
        payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation, mode: 'bearer' },
      });
      assert.equal(manualKey.statusCode, 409, manualKey.body);
      assert.deepEqual(manualKey.json(), { error: 'trigger-not-webhook' });
      const wrongTrigger = await send(event(), `Bearer ${strayKey}`);
      assert.equal(
        wrongTrigger.statusCode,
        404,
        'A key cannot be configured or used for a workflow whose saved and active triggers are not webhook',
      );

      assert.equal(
        (await activate(manualRevision, false)).webhookConfigured,
        false,
        'Disabling a non-webhook revision also clears the key',
      );
      const returned = await save({ kind: 'webhook' });
      const revived = await activate(returned);
      assert.equal(revived.activeTrigger?.kind, 'webhook');
      assert.equal(revived.webhookConfigured, false);
      for (const stale of [firstKey, rotated.key, strayKey])
        assert.equal(
          (await send(event(), `Bearer ${stale}`)).statusCode,
          404,
          'Switching back to webhook must not revive an earlier or previous key',
        );
      const { key: freshKey } = await setKey();
      assert.equal((await send(event(), `Bearer ${freshKey}`)).statusCode, 200);

      const unfinished = async () =>
        (await service.history(w.id, w.userId, id).then(page => page.runs)).filter(run =>
          ['queued', 'running', 'waiting'].includes(run.status),
        ).length;
      const before = await unfinished();
      assert.ok(before > 0 && before < 25);
      while ((await unfinished()) < 25) await service.start(w.id, w.userId, id, event());
      const full = await send(event(), `Bearer ${freshKey}`);
      assert.equal(full.statusCode, 409, full.body);
      assert.deepEqual(full.json(), { error: 'limit-reached' });
      assert.equal(await unfinished(), 25);
      assert.deepEqual(
        [...new Set((await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => run.source))].sort(),
        ['manual', 'webhook'],
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'raw webhook triggers accept provider payloads as sent and deduplicate by header, body path, or body hash',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      app = Fastify({ ...securityServerOptions(), logger: false });
      registerSecurity(app, 'http://localhost:5173');
      app.register(
        async v1 => {
          protectBusinessRequests(v1);
          registerWorkflows(v1, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) =>
                  headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.ready();
      const base = `/v1/workspaces/${w.id}/workflows`,
        headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const read = async id =>
        (await app.inject({ method: 'GET', url: base, headers })).json().find(item => item.id === id);

      async function receiver(payload, mode = 'bearer', signingSecret) {
        const id = randomUUID(),
          revision = randomUUID();
        const saved = await app.inject({
          method: 'PUT',
          url: `${base}/${id}`,
          headers,
          payload: { revision, expectedRevision: null, definition: definition({ kind: 'webhook', payload }) },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        const activated = await app.inject({
          method: 'POST',
          url: `${base}/${id}/activation`,
          headers,
          payload: {
            commandId: randomUUID(),
            expectedGeneration: (await read(id)).generation,
            revision,
            enabled: true,
          },
        });
        assert.equal(activated.statusCode, 200, activated.body);
        const keyed = await app.inject({
          method: 'PUT',
          url: `${base}/${id}/webhook-key`,
          headers,
          payload: {
            commandId: randomUUID(),
            expectedGeneration: activated.json().generation,
            mode,
            ...(signingSecret ? { secret: signingSecret } : {}),
          },
        });
        assert.equal(keyed.statusCode, 200, keyed.body);
        const secret = signingSecret ?? keyed.json().key;
        const proof = raw =>
          mode === 'github'
            ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }
            : mode === 'stripe'
              ? (() => {
                  const timestamp = Math.floor(Date.now() / 1000);
                  return {
                    'stripe-signature': `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`,
                  };
                })()
              : { authorization: ['Bear', 'er', secret].join(' ') };
        const send = (body, extra = {}) => {
          const raw = typeof body === 'string' ? body : JSON.stringify(body);
          return app.inject({
            method: 'POST',
            url: `${base}/${id}/webhook`,
            headers: { 'content-type': 'application/json', ...proof(raw), ...extra },
            payload: raw,
          });
        };
        const runs = async () =>
          (await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => ({
            id: run.id,
            source: run.source,
            input: run.input,
          }));
        async function reconfigure(next) {
          const nextRevision = randomUUID();
          const resaved = await app.inject({
            method: 'PUT',
            url: `${base}/${id}`,
            headers,
            payload: {
              revision: nextRevision,
              expectedRevision: (await read(id)).revision,
              definition: definition({ kind: 'webhook', payload: next }),
            },
          });
          assert.equal(resaved.statusCode, 200, resaved.body);
          await service.sponsorship(w.id, w.userId, id, {
            sponsorMembershipId: w.membershipId,
            historyAudience: [w.membershipId],
          });
          const reactivated = await app.inject({
            method: 'POST',
            url: `${base}/${id}/activation`,
            headers,
            payload: {
              commandId: randomUUID(),
              expectedGeneration: (await read(id)).generation,
              revision: nextRevision,
              enabled: true,
            },
          });
          assert.equal(reactivated.statusCode, 200, reactivated.body);
        }
        return { id, send, runs, reconfigure, secret };
      }

      const credentialCopy = await app.inject({
        method: 'PUT',
        url: `${base}/${randomUUID()}`,
        headers,
        payload: {
          revision: randomUUID(),
          expectedRevision: null,
          definition: definition({
            kind: 'webhook',
            payload: { mode: 'raw', dedupe: { source: 'hash' }, headers: ['authorization'] },
          }),
        },
      });
      assert.equal(credentialCopy.statusCode, 400, 'A trigger cannot copy the bearer key into run input');
      for (const header of ['x-hub-signature-256', 'stripe-signature', 'x-tulipfarm-signature', 'x-webhook-secret']) {
        const signatureCopy = await app.inject({
          method: 'PUT',
          url: `${base}/${randomUUID()}`,
          headers,
          payload: {
            revision: randomUUID(),
            expectedRevision: null,
            definition: definition({
              kind: 'webhook',
              payload: { mode: 'raw', dedupe: { source: 'hash' }, headers: ['x-github-event', header] },
            }),
          },
        });
        assert.equal(
          signatureCopy.statusCode,
          400,
          `A trigger cannot copy ${header}, which history readers could replay`,
        );
      }

      const stripe = await receiver({ mode: 'raw', dedupe: { source: 'body', path: ['id'] }, headers: ['x-attempt'] });
      const stripeEvent = {
        id: 'evt_1PqR',
        object: 'event',
        type: 'payment_intent.succeeded',
        created: 1759900000,
        livemode: false,
        data: {
          object: { id: 'pi_3Mt', object: 'payment_intent', amount: 2000, currency: 'usd', status: 'succeeded' },
        },
      };
      const delivered = await stripe.send(stripeEvent, { 'x-attempt': '1' });
      assert.equal(delivered.statusCode, 200, delivered.body);
      const retried = await stripe.send(stripeEvent, { 'x-attempt': '2' });
      assert.deepEqual(
        retried.json(),
        delivered.json(),
        'A Stripe retry with a new attempt header returns the original run',
      );
      const reused = await stripe.send({ ...stripeEvent, type: 'payment_intent.canceled' }, { 'x-attempt': '3' });
      assert.equal(reused.statusCode, 409, reused.body);
      assert.deepEqual(reused.json(), { error: 'request-conflict' });
      for (const body of [{ object: 'event' }, { id: { nested: true } }, { id: '' }, [stripeEvent]]) {
        const response = await stripe.send(body);
        assert.equal(response.statusCode, 400, `${JSON.stringify(body)}: ${response.body}`);
        assert.deepEqual(response.json(), { error: 'invalid-request' });
      }
      assert.deepEqual(await stripe.runs(), [
        { id: delivered.json().runId, source: 'webhook', input: { body: stripeEvent, headers: { 'x-attempt': '1' } } },
      ]);
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: delivered.json().runId }), {
        kind: 'continue',
      });
      assert.deepEqual(await service.advance({ workspaceId: w.id, runId: delivered.json().runId }), { kind: 'done' });
      const [stripeRun] = await service.history(w.id, w.userId, stripe.id).then(page => page.runs);
      assert.equal(stripeRun.status, 'completed');
      assert.deepEqual(stripeRun.steps[0].output, { event: { body: stripeEvent, headers: { 'x-attempt': '1' } } });

      await stripe.reconfigure({ mode: 'raw', dedupe: { source: 'body', path: ['id'] } });
      assert.deepEqual(
        (await stripe.send(stripeEvent, { 'x-attempt': '4' })).json(),
        delivered.json(),
        'A retry still replays after the next revision stops copying headers',
      );
      const plainEvent = { ...stripeEvent, id: 'evt_2AbC' };
      const plain = await stripe.send(plainEvent);
      assert.equal(plain.statusCode, 200, plain.body);
      await stripe.reconfigure({ mode: 'raw', dedupe: { source: 'body', path: ['id'] }, headers: ['x-attempt'] });
      assert.deepEqual(
        (await stripe.send(plainEvent, { 'x-attempt': '5' })).json(),
        plain.json(),
        'A retry still replays after the next revision starts copying headers',
      );
      assert.equal((await stripe.send({ ...plainEvent, type: 'charge.refunded' })).statusCode, 409);

      const github = await receiver({
        mode: 'raw',
        dedupe: { source: 'header', name: 'x-github-delivery' },
        headers: ['x-github-event', 'x-github-hook-id'],
      });
      const push = {
        ref: 'refs/heads/main',
        before: '6113728f27ae82c7b1a177c8d03f9e96e0adf246',
        after: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
        repository: { id: 1296269, full_name: 'octocat/Hello-World', private: false },
        pusher: { name: 'octocat' },
        commits: [
          {
            id: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
            message: 'Update README',
            added: [],
            removed: [],
            modified: ['README.md'],
          },
        ],
      };
      const delivery = randomUUID();
      const pushed = await github.send(push, {
        'x-github-delivery': delivery,
        'x-github-event': 'push',
        'user-agent': 'GitHub-Hookshot/abc',
      });
      assert.equal(pushed.statusCode, 200, pushed.body);
      assert.deepEqual(
        (await github.send(push, { 'x-github-delivery': delivery, 'x-github-event': 'push' })).json(),
        pushed.json(),
        'A GitHub redelivery reuses its delivery ID',
      );
      const second = await github.send(push, { 'x-github-delivery': randomUUID(), 'x-github-event': 'push' });
      assert.equal(second.statusCode, 200, second.body);
      assert.notEqual(
        second.json().runId,
        pushed.json().runId,
        'Each new delivery ID starts a run even when the body repeats',
      );
      const undelivered = await github.send(push, { 'x-github-event': 'push' });
      assert.equal(undelivered.statusCode, 400, undelivered.body);
      assert.deepEqual(undelivered.json(), { error: 'invalid-request' });
      const formBody = 'state=paid&tag=first&tag=second',
        formId = randomUUID();
      const form = await github.send(formBody, {
        'content-type': 'application/x-www-form-urlencoded',
        'x-github-delivery': formId,
      });
      assert.equal(form.statusCode, 200, form.body);
      const githubRuns = await github.runs();
      assert.equal(githubRuns.length, 2);
      assert.deepEqual(
        githubRuns.find(run => run.id === pushed.json().runId).input,
        { body: push, headers: { 'x-github-event': 'push' } },
        'Only allowlisted headers that were sent are copied',
      );
      assert.deepEqual(githubRuns.find(run => run.id === form.json().runId).input, {
        body: { state: 'paid', tag: ['first', 'second'] },
        headers: {},
      });

      const legacy = await receiver(
        { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' }, headers: ['x-github-event'] },
        'github',
      );
      await db.databaseAdmin.query(
        `UPDATE ${escapeIdentifier(w.names.schema)}.tf_workflow_revisions SET definition=jsonb_set(definition,'{trigger,payload,headers}','["x-github-event","x-hub-signature-256","x-hub-signature"]') WHERE workflow_id=$1`,
        [legacy.id],
      );
      const legacyPush = await legacy.send(push, {
        'x-github-delivery': randomUUID(),
        'x-github-event': 'push',
        'x-hub-signature': 'sha1=0000',
      });
      assert.equal(legacyPush.statusCode, 200, legacyPush.body);
      assert.deepEqual(
        (await legacy.runs()).map(run => run.input),
        [{ body: push, headers: { 'x-github-event': 'push' } }],
        'A revision saved before the rule still never copies signature headers',
      );

      const githubSigned = await receiver(
        { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' } },
        'github',
      );
      const signedDeliveryId = randomUUID();
      const signedPush = await githubSigned.send(push, { 'x-github-delivery': signedDeliveryId });
      assert.equal(signedPush.statusCode, 200, signedPush.body);
      assert.equal((await read(githubSigned.id)).webhookMode, 'github');
      assert.equal(
        (
          await githubSigned.send(push, {
            'x-github-delivery': randomUUID(),
            'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
          })
        ).statusCode,
        404,
        'An invalid GitHub signature is rejected',
      );

      const stripeSecret = 'whsec_local_fixture_signing_secret_123456';
      const stripeSigned = await receiver(
        { mode: 'raw', dedupe: { source: 'body', path: ['id'] } },
        'stripe',
        stripeSecret,
      );
      const signedStripeEvent = { id: 'evt_native_123', object: 'event', type: 'payment_intent.succeeded' };
      const signedStripe = await stripeSigned.send(signedStripeEvent);
      assert.equal(signedStripe.statusCode, 200, signedStripe.body);
      assert.equal((await read(stripeSigned.id)).webhookMode, 'stripe');
      assert.deepEqual(
        (await stripeSigned.send(signedStripeEvent)).json(),
        signedStripe.json(),
        'A fresh Stripe signature for the same event returns the existing run',
      );
      const staleTimestamp = Math.floor(Date.now() / 1000) - 301,
        staleBody = JSON.stringify({ id: 'evt_stale' });
      const staleSignature = createHmac('sha256', stripeSecret).update(`${staleTimestamp}.${staleBody}`).digest('hex');
      const stale = await stripeSigned.send(staleBody, {
        'stripe-signature': `t=${staleTimestamp},v1=${staleSignature}`,
      });
      assert.deepEqual([stale.statusCode, stale.json()], [409, { error: 'webhook-signature-expired' }]);

      const keyed = await receiver({ mode: 'raw', dedupe: { source: 'header', name: 'idempotency-key' } });
      const created = await keyed.send('order created', { 'idempotency-key': 'order-42' });
      assert.equal(created.statusCode, 200, created.body);
      assert.deepEqual((await keyed.send('order created', { 'idempotency-key': 'order-42' })).json(), created.json());
      assert.equal((await keyed.send('order changed', { 'idempotency-key': 'order-42' })).statusCode, 409);
      assert.deepEqual(
        await keyed.runs(),
        [{ id: created.json().runId, source: 'webhook', input: 'order created' }],
        'Without copied headers the body is the run input as sent',
      );

      const hashed = await receiver({ mode: 'raw', dedupe: { source: 'hash' } });
      const typeform = {
        event_id: '01HXYZ',
        event_type: 'form_response',
        form_response: { form_id: 'lT4Z3j', answers: [{ type: 'text', text: 'Ada' }] },
      };
      const answered = await hashed.send(typeform);
      assert.equal(answered.statusCode, 200, answered.body);
      const reordered = {
        form_response: { answers: [{ text: 'Ada', type: 'text' }], form_id: 'lT4Z3j' },
        event_type: 'form_response',
        event_id: '01HXYZ',
      };
      assert.deepEqual(
        (await hashed.send(reordered)).json(),
        answered.json(),
        'Key order does not change the body hash',
      );
      const list = await hashed.send([1, 2, 3]);
      assert.equal(list.statusCode, 200, list.body);
      assert.notEqual(list.json().runId, answered.json().runId);
      const oversized = await hashed.send({ blob: 'x'.repeat(40000) });
      assert.equal(oversized.statusCode, 413, `Run input stays within its 32 KiB limit: ${oversized.body}`);
      assert.deepEqual(oversized.json(), { error: 'run-input-too-large' });
      const text = await app.inject({
        method: 'POST',
        url: `${base}/${hashed.id}/webhook`,
        headers: { 'content-type': 'text/plain' },
        payload: 'not json',
      });
      assert.deepEqual(
        [text.statusCode, text.json()],
        [415, { error: 'unsupported-media-type' }],
        'A text body is not silently stored as a string input',
      );
      assert.deepEqual(
        (await hashed.runs()).map(run => run.input).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [typeform, [1, 2, 3]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      );
      assert.equal(
        (await hashed.send(typeform, { authorization: `Bearer ${key()}` })).statusCode,
        404,
        'Raw mode still requires the bearer key',
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  "webhook floods are rate limited per workflow across replicas and cannot take another workflow's run capacity",
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime;
    const apps = [];
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      const auth = {
        api: {
          getSession: async ({ headers }) =>
            headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
        },
      };
      const limiter = createAbuseLimiter(db.platform, 'workflow-webhook-limit');
      for (let replica = 0; replica < 2; replica++) {
        const app = Fastify({ ...securityServerOptions(), logger: false });
        registerSecurity(app, 'http://localhost:5173');
        app.register(
          async v1 => {
            registerAbuseHooks(v1, limiter, auth);
            v1.register(async business => {
              protectBusinessRequests(business);
              registerWorkflows(business, { service, auth });
            });
          },
          { prefix: '/v1' },
        );
        await app.ready();
        apps.push(app);
      }
      const [app] = apps;
      const base = `/v1/workspaces/${w.id}/workflows`,
        headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const read = async id =>
        (await app.inject({ method: 'GET', url: base, headers })).json().find(item => item.id === id);
      let sent = 0;
      async function receiver() {
        const id = randomUUID(),
          revision = randomUUID();
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `${base}/${id}`,
              headers,
              payload: { revision, expectedRevision: null, definition: definition({ kind: 'webhook' }) },
            })
          ).statusCode,
          200,
        );
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        const activated = await app.inject({
          method: 'POST',
          url: `${base}/${id}/activation`,
          headers,
          payload: {
            commandId: randomUUID(),
            expectedGeneration: (await read(id)).generation,
            revision,
            enabled: true,
          },
        });
        assert.equal(activated.statusCode, 200, activated.body);
        const keyed = await app.inject({
          method: 'PUT',
          url: `${base}/${id}/webhook-key`,
          headers,
          payload: { commandId: randomUUID(), expectedGeneration: activated.json().generation, mode: 'bearer' },
        });
        assert.equal(keyed.statusCode, 200, keyed.body);
        const secret = keyed.json().key;
        const send = (
          authorization = `Bearer ${secret}`,
          url = `${base}/${id}/webhook`,
          remoteAddress = `203.0.113.${(sent % 250) + 1}`,
        ) =>
          apps[sent++ % 2].inject({
            method: 'POST',
            url,
            remoteAddress,
            headers: { authorization },
            payload: { requestId: randomUUID(), input: null },
          });
        const runs = async () => (await service.history(w.id, w.userId, id).then(page => page.runs)).length;
        return { id, send, runs };
      }
      const noisy = await receiver(),
        quiet = await receiver();

      for (let n = 0; n < 10; n++) {
        const accepted = await noisy.send();
        assert.equal(accepted.statusCode, 200, accepted.body);
      }
      const capped = await noisy.send();
      assert.equal(capped.statusCode, 409, capped.body);
      assert.deepEqual(capped.json(), { error: 'limit-reached' });
      assert.equal(await noisy.runs(), 10);
      assert.equal(
        (await quiet.send()).statusCode,
        200,
        "A workflow at its unattended run cap leaves capacity for the same sponsor's other workflows",
      );
      assert.ok(
        await service.start(w.id, w.userId, noisy.id, { requestId: randomUUID(), input: null }),
        'People can still start the capped workflow by hand',
      );

      const attacker = '198.51.100.7',
        flood = [];
      for (let n = 0; n < 200 && flood.at(-1) !== 429; n++)
        flood.push((await noisy.send(`Bearer ${key()}`, undefined, attacker)).statusCode);
      assert.deepEqual(
        [flood.length, [...new Set(flood)]],
        [61, [404, 429]],
        'A source presenting bad keys spends its own budget',
      );
      assert.equal(
        (await quiet.send(`Bearer ${key()}`, `${base}/${randomUUID()}/webhook`, attacker)).statusCode,
        429,
        'Guessed workflow identifiers spend the same source budget',
      );
      assert.equal((await noisy.send()).statusCode, 409, "Bad keys leave the real sender's workflow budget untouched");
      assert.equal(
        (await quiet.send(undefined, undefined, attacker)).statusCode,
        429,
        'A source over its bad-key budget is refused before the authorization lock',
      );
      assert.equal(
        (await quiet.send()).statusCode,
        200,
        'Valid deliveries from other sources still arrive during the flood',
      );

      const scattered = [];
      for (let n = 0; n < 650; n++)
        scattered.push((await quiet.send(`Bearer ${key()}`, `${base}/${randomUUID()}/webhook`)).statusCode);
      assert.deepEqual(
        [...new Set(scattered)],
        [404],
        'Guesses spread across sources never reach a workspace or workflow limit',
      );
      assert.equal(
        (await quiet.send()).statusCode,
        200,
        'A bad-key flood larger than the workspace budget leaves valid deliveries working',
      );

      const statuses = [];
      for (let n = 0; n < 200 && statuses.at(-1) !== 429; n++) statuses.push((await noisy.send()).statusCode);
      assert.deepEqual(
        [statuses.length, [...new Set(statuses)]],
        [109, [409, 429]],
        'Authorized deliveries spend the per-workflow budget',
      );
      const limited = await noisy.send();
      assert.equal(limited.statusCode, 429, limited.body);
      assert.deepEqual(limited.json(), { error: 'rate-limit-exceeded' });
      const retryAfter = Number(limited.headers['retry-after']);
      assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After ${limited.headers['retry-after']}`);
      assert.equal((await noisy.send()).statusCode, 429, 'The other replica shares the same budget');
      assert.equal(
        (
          await noisy.send(
            undefined,
            `/v1/workspaces/${w.id.toUpperCase()}/workflows/${noisy.id.toUpperCase()}/webhook`,
          )
        ).statusCode,
        429,
        'Uppercase identifiers address the same budget',
      );
      assert.equal((await quiet.send()).statusCode, 200, 'Another workflow keeps its own budget');

      await db.platform.query("UPDATE app.api_rate_limits SET expires_at = now() - interval '1 second'");
      await service.cancel(
        w.id,
        w.userId,
        noisy.id,
        (await service.history(w.id, w.userId, noisy.id).then(page => page.runs)).find(
          run => run.source === 'webhook' && run.status === 'queued',
        ).id,
      );
      assert.equal(
        (await noisy.send()).statusCode,
        200,
        'The webhook recovers once the window expires and a run finishes',
      );
    } finally {
      await Promise.all(apps.map(app => app.close()));
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'signed webhooks verify an HMAC over the exact bytes sent and the previous key can be revoked over HTTP',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime, {
        keyring: { activeKeyId: 'fixture', keys: { fixture: '3c'.repeat(32) } },
      });
      const auth = {
        api: {
          getSession: async ({ headers }) =>
            headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
        },
      };
      app = Fastify({ ...securityServerOptions(), logger: false });
      registerSecurity(app, 'http://localhost:5173');
      app.register(
        async v1 => {
          registerAbuseHooks(v1, createAbuseLimiter(db.platform, 'signed-webhook-limit'), auth);
          v1.register(async business => {
            protectBusinessRequests(business);
            registerWorkflows(business, { service, auth });
          });
        },
        { prefix: '/v1' },
      );
      await app.ready();
      const base = `/v1/workspaces/${w.id}/workflows`,
        headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' },
        id = randomUUID(),
        revision = randomUUID();
      const read = async () =>
        (await app.inject({ method: 'GET', url: base, headers })).json().find(item => item.id === id);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `${base}/${id}`,
            headers,
            payload: {
              revision,
              expectedRevision: null,
              definition: definition({ kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'hash' } } }),
            },
          })
        ).statusCode,
        200,
      );
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/activation`,
            headers,
            payload: {
              commandId: randomUUID(),
              expectedGeneration: (await read()).generation,
              revision,
              enabled: true,
            },
          })
        ).statusCode,
        200,
      );
      async function rotate(mode) {
        const response = await app.inject({
          method: 'PUT',
          url: `${base}/${id}/webhook-key`,
          headers,
          payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation, mode },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      let source = 0;
      const send = (raw, extra, remoteAddress = `192.0.${2 + Math.floor(source / 250)}.${(source++ % 250) + 1}`) =>
        app.inject({
          method: 'POST',
          url: `${base}/${id}/webhook`,
          remoteAddress,
          headers: { 'content-type': 'application/json', ...extra },
          payload: raw,
        });
      const signature = (secret, timestamp, raw) => ({
        'x-tulipfarm-timestamp': String(timestamp),
        'x-tulipfarm-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`,
      });
      const now = () => Math.floor(Date.now() / 1000);

      const old = await rotate('bearer');
      const current = await rotate('signed');
      assert.equal(current.workflow.webhookMode, 'signed');
      assert.equal(current.workflow.webhookPrevious.mode, 'bearer');
      const raw = '{ "order" :  42,\n "note": "caf\u00e9" }';
      const accepted = await send(raw, signature(current.key, now() - 10, raw));
      assert.equal(
        accepted.statusCode,
        200,
        `The signature covers the raw body, not a re-serialized one: ${accepted.body}`,
      );
      const sent = signature(current.key, now(), raw);
      assert.deepEqual(
        (await send(raw, sent)).json(),
        accepted.json(),
        'A fresh signature over the same body is a retry of the same event',
      );
      const replayed = await send(raw, sent);
      assert.deepEqual([replayed.statusCode, replayed.json()], [409, { error: 'webhook-signature-replayed' }]);
      const tampered = await send(raw.replace('42', '43'), signature(current.key, now(), raw));
      assert.deepEqual([tampered.statusCode, tampered.json()], [404, { error: 'workflow-not-found' }]);
      const stale = await send(raw, signature(current.key, now() - 600, raw));
      assert.deepEqual([stale.statusCode, stale.json()], [409, { error: 'webhook-signature-expired' }]);
      const expired = signature(current.key, now() - 600, raw),
        resent = [];
      for (let n = 0; n < 700; n++) resent.push((await send(raw, n % 2 ? expired : sent)).statusCode);
      assert.deepEqual(
        [...new Set(resent)],
        [409],
        'Resent expired or replayed requests past the workspace limit never reach a workflow or workspace budget',
      );
      const fresh = '{"order":9}';
      assert.equal(
        (await send(fresh, signature(current.key, now(), fresh))).statusCode,
        200,
        'A valid delivery still arrives after the resends',
      );
      const replayer = [];
      for (let n = 0; n < 100 && replayer.at(-1) !== 429; n++)
        replayer.push((await send(raw, sent, '198.51.100.9')).statusCode);
      assert.deepEqual(
        [replayer.length, [...new Set(replayer)]],
        [61, [409, 429]],
        'A replaying source spends its own budget',
      );
      assert.equal(
        (await send('{"order":7}', { authorization: `Bearer ${old.key}` })).statusCode,
        200,
        'The previous bearer key works during its grace period',
      );

      const revoked = await app.inject({
        method: 'POST',
        url: `${base}/${id}/webhook-key/revoke-previous`,
        headers,
        payload: { commandId: randomUUID(), expectedGeneration: (await read()).generation },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal(revoked.json().webhookPrevious, null);
      assert.equal(
        (await send('{"order":8}', { authorization: `Bearer ${old.key}` })).statusCode,
        404,
        'A revoked previous key stops at once',
      );
      assert.deepEqual(
        (await service.history(w.id, w.userId, id).then(page => page.runs))
          .map(run => run.input)
          .sort((a, b) => a.order - b.order),
        [{ order: 7 }, { order: 9 }, { order: 42, note: 'café' }],
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'the delivery log records every webhook outcome without the body or key, stays bounded, and a test send starts a run',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      const operator = { id: 'webhook-log-operator', membershipId: randomUUID() };
      await db.databaseAdmin.query(
        `INSERT INTO ${escapeIdentifier(w.names.schema)}.tf_memberships (id,user_id,role) VALUES ($1,$2,'member')`,
        [operator.membershipId, operator.id],
      );
      const users = { 'test-session=admin': w.userId, 'test-session=operator': operator.id };
      const auth = {
        api: {
          getSession: async ({ headers }) =>
            users[headers.get('cookie')] ? { user: { id: users[headers.get('cookie')] } } : null,
        },
      };
      app = Fastify({ ...securityServerOptions(), logger: false });
      registerSecurity(app, 'http://localhost:5173');
      app.register(
        async v1 => {
          registerAbuseHooks(v1, createAbuseLimiter(db.platform, 'webhook-log'), auth);
          v1.register(async business => {
            protectBusinessRequests(business);
            registerWorkflows(business, { service, auth });
          });
        },
        { prefix: '/v1' },
      );
      await app.ready();
      const base = `/v1/workspaces/${w.id}/workflows`,
        headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const read = async id =>
        (await app.inject({ method: 'GET', url: base, headers })).json().find(item => item.id === id);
      async function receiver(payload) {
        const id = randomUUID(),
          revision = randomUUID();
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: `${base}/${id}`,
              headers,
              payload: {
                revision,
                expectedRevision: null,
                definition: definition({ kind: 'webhook', ...(payload ? { payload } : {}) }),
              },
            })
          ).statusCode,
          200,
        );
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        const activated = await app.inject({
          method: 'POST',
          url: `${base}/${id}/activation`,
          headers,
          payload: {
            commandId: randomUUID(),
            expectedGeneration: (await read(id)).generation,
            revision,
            enabled: true,
          },
        });
        assert.equal(activated.statusCode, 200, activated.body);
        const keyed = await app.inject({
          method: 'PUT',
          url: `${base}/${id}/webhook-key`,
          headers,
          payload: { commandId: randomUUID(), expectedGeneration: activated.json().generation, mode: 'bearer' },
        });
        assert.equal(keyed.statusCode, 200, keyed.body);
        return { id, revision, secret: keyed.json().key };
      }
      const send = (id, body, extra = {}, remoteAddress = '192.0.2.10') =>
        app.inject({
          method: 'POST',
          url: `${base}/${id}/webhook`,
          remoteAddress,
          headers: { 'content-type': 'application/json', ...extra },
          payload: typeof body === 'string' ? body : JSON.stringify(body),
        });
      const deliveries = async (id, cookie = headers.cookie) => {
        const response = await app.inject({
          method: 'GET',
          url: `${base}/${id}/webhook-deliveries`,
          headers: { ...headers, cookie },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().available, true);
        return response.json().deliveries;
      };
      const brief = list => list.map(({ status, outcome, requestId, test }) => [status, outcome, requestId, test]);

      const orders = await receiver();
      assert.deepEqual(await deliveries(orders.id), [], 'A new webhook has an empty log');
      const bearer = { authorization: `Bearer ${orders.secret}` };
      const event = { requestId: randomUUID(), input: { order: 'ORD-1' } };
      assert.equal((await send(orders.id, event)).statusCode, 404);
      assert.equal((await send(orders.id, event, { authorization: `Bearer ${key()}` })).statusCode, 404);
      const accepted = await send(orders.id, event, bearer);
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.deepEqual((await send(orders.id, event, bearer)).json(), accepted.json());
      assert.equal((await send(orders.id, { ...event, input: { order: 'ORD-2' } }, bearer)).statusCode, 409);
      assert.equal((await send(orders.id, { requestId: 'not-a-uuid', input: {} }, bearer)).statusCode, 400);
      assert.equal((await send(orders.id, '{"requestId":', bearer)).statusCode, 400);
      const oversized = JSON.stringify({ requestId: randomUUID(), input: { blob: 'x'.repeat(70000) } });
      assert.equal((await send(orders.id, oversized, bearer)).statusCode, 413);
      const runOversized = JSON.stringify({ requestId: randomUUID(), input: { blob: 'x'.repeat(40000) } });
      assert.deepEqual(
        [(await send(orders.id, runOversized, bearer)).statusCode, (await deliveries(orders.id)).length],
        [413, 9],
      );

      const log = await deliveries(orders.id);
      assert.deepEqual(brief(log), [
        [413, 'run-input-too-large', null, false],
        [413, 'request-too-large', null, false],
        [400, 'invalid-request', null, false],
        [400, 'invalid-request', 'not-a-uuid', false],
        [409, 'request-conflict', event.requestId, false],
        [200, 'duplicate', event.requestId, false],
        [200, 'accepted', event.requestId, false],
        [404, 'key-rejected', event.requestId, false],
        [404, 'key-missing', event.requestId, false],
      ]);
      const runId = accepted.json().runId;
      assert.deepEqual(
        log.map(entry => [entry.runStarted, entry.runId]),
        [
          [false, null],
          [false, null],
          [false, null],
          [false, null],
          [true, runId],
          [true, runId],
          [false, null],
          [false, null],
        ],
      );
      assert.equal(log[0].bodyBytes, Buffer.byteLength(runOversized));
      assert.equal(log[1].bodyBytes, Buffer.byteLength(oversized));
      assert.equal(log.at(-3).bodyBytes, Buffer.byteLength(JSON.stringify(event)));
      assert.ok(log.every(entry => !Number.isNaN(Date.parse(entry.receivedAt))));
      const rows = (
        await db.databaseAdmin.query(
          `SELECT row_to_json(d)::text AS row FROM ${escapeIdentifier(w.names.schema)}.tf_workflow_webhook_deliveries d`,
        )
      ).rows
        .map(row => row.row)
        .join('\n');
      for (const secret of [orders.secret, 'ORD-1', 'xxxxxxxx'])
        assert.equal(
          rows.includes(secret),
          false,
          `The log never stores ${secret === orders.secret ? 'the key' : 'the body'}`,
        );

      const sampleId = randomUUID();
      const sent = await app.inject({
        method: 'POST',
        url: `${base}/${orders.id}/webhook-test`,
        headers,
        payload: { requestId: sampleId },
      });
      assert.equal(sent.statusCode, 200, sent.body);
      assert.deepEqual(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${orders.id}/webhook-test`,
            headers,
            payload: { requestId: sampleId },
          })
        ).json(),
        sent.json(),
        'Retrying a test send returns its run',
      );
      const tested = (await service.history(w.id, w.userId, orders.id).then(page => page.runs)).find(
        run => run.id === sent.json().runId,
      );
      assert.deepEqual([tested.source, tested.input], ['webhook', { test: true }]);
      const afterTest = await deliveries(orders.id);
      assert.deepEqual(brief(afterTest.slice(0, 2)), [
        [200, 'duplicate', sampleId, true],
        [200, 'accepted', sampleId, true],
      ]);
      assert.deepEqual([afterTest[1].runId, afterTest[1].bodyBytes], [sent.json().runId, null]);

      const grant = await app.inject({
        method: 'PUT',
        url: `${base}/${orders.id}/grants`,
        headers,
        payload: { principal: { kind: 'person', id: operator.membershipId }, permissions: ['read', 'invoke'] },
      });
      assert.equal(grant.statusCode, 200, grant.body);
      const unmanaged = await app.inject({
        method: 'GET',
        url: `${base}/${orders.id}/webhook-deliveries`,
        headers: { ...headers, cookie: 'test-session=operator' },
      });
      assert.equal(unmanaged.statusCode, 404, 'Only managers read the delivery log');
      const unmanagedTest = await app.inject({
        method: 'POST',
        url: `${base}/${orders.id}/webhook-test`,
        headers: { ...headers, cookie: 'test-session=operator' },
        payload: { requestId: randomUUID() },
      });
      assert.equal(unmanagedTest.statusCode, 404, 'Only managers send test events');
      await app.inject({
        method: 'PUT',
        url: `${base}/${orders.id}/grants`,
        headers,
        payload: {
          principal: { kind: 'person', id: operator.membershipId },
          permissions: ['read', 'invoke', 'manage'],
        },
      });
      const managerView = await deliveries(orders.id, 'test-session=operator');
      assert.equal(managerView.length, afterTest.length, 'A refused test send leaves no entry');
      assert.deepEqual(
        managerView.filter(entry => entry.runStarted).map(entry => [entry.runId, entry.requestId]),
        [
          [null, null],
          [null, null],
          [null, null],
          [null, null],
        ],
        'A manager outside the history audience sees that a run started, but not which run or the identifier its sender chose',
      );
      assert.equal(managerView.find(entry => entry.outcome === 'request-conflict').requestId, event.requestId);

      await app.inject({
        method: 'POST',
        url: `${base}/${orders.id}/activation`,
        headers,
        payload: {
          commandId: randomUUID(),
          expectedGeneration: (await read(orders.id)).generation,
          revision: orders.revision,
          enabled: false,
        },
      });
      assert.equal((await send(orders.id, { requestId: randomUUID(), input: null }, bearer)).statusCode, 404);
      const inactiveTest = await app.inject({
        method: 'POST',
        url: `${base}/${orders.id}/webhook-test`,
        headers,
        payload: { requestId: randomUUID() },
      });
      assert.deepEqual([inactiveTest.statusCode, inactiveTest.json()], [409, { error: 'workflow-inactive' }]);
      assert.deepEqual(
        brief(await deliveries(orders.id))
          .slice(0, 2)
          .map(([status, outcome, , test]) => [status, outcome, test]),
        [
          [409, 'workflow-inactive', true],
          [404, 'workflow-inactive', false],
        ],
      );

      const github = await receiver({ mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' } });
      const delivery = randomUUID();
      assert.equal(
        (
          await send(
            github.id,
            { zen: 'Keep it simple' },
            { authorization: `Bearer ${github.secret}`, 'x-github-delivery': delivery },
          )
        ).statusCode,
        200,
      );
      const githubTest = await app.inject({
        method: 'POST',
        url: `${base}/${github.id}/webhook-test`,
        headers,
        payload: { requestId: sampleId },
      });
      assert.equal(githubTest.statusCode, 200, githubTest.body);
      assert.deepEqual(
        brief(await deliveries(github.id)),
        [
          [200, 'accepted', sampleId, true],
          [200, 'accepted', delivery, false],
        ],
        'A raw trigger logs the header it deduplicates by',
      );
      const stripe = await receiver({ mode: 'raw', dedupe: { source: 'body', path: ['data', 'id'] } });
      const stripeTest = await app.inject({
        method: 'POST',
        url: `${base}/${stripe.id}/webhook-test`,
        headers,
        payload: { requestId: sampleId },
      });
      assert.equal(stripeTest.statusCode, 200, stripeTest.body);
      assert.deepEqual(
        (await service.history(w.id, w.userId, stripe.id).then(page => page.runs))[0].input,
        { test: true, data: { id: sampleId } },
        'The sample carries its identifier where the trigger reads it',
      );

      const stored = async workflowId =>
        (
          await db.databaseAdmin.query(
            `SELECT count(*)::integer AS n FROM ${escapeIdentifier(w.names.schema)}.tf_workflow_webhook_deliveries WHERE workflow_id=$1`,
            [workflowId],
          )
        ).rows[0].n;
      const flooded = await receiver(),
        attacker = '198.51.100.9',
        statuses = [];
      for (let n = 0; n < 70 && statuses.at(-1) !== 429; n++)
        statuses.push(
          (
            await send(
              flooded.id,
              { requestId: randomUUID(), input: null },
              { authorization: `Bearer ${key()}` },
              attacker,
            )
          ).statusCode,
        );
      assert.deepEqual([statuses.length, statuses.at(-1)], [61, 429]);
      const total = async () =>
        (
          await db.databaseAdmin.query(
            `SELECT count(*)::integer AS n FROM ${escapeIdentifier(w.names.schema)}.tf_workflow_webhook_deliveries`,
          )
        ).rows[0].n;
      const before = await total();
      for (const target of [flooded.id, randomUUID(), randomUUID()])
        assert.equal(
          (
            await send(
              target,
              { requestId: randomUUID(), input: null },
              { authorization: `Bearer ${flooded.secret}` },
              attacker,
            )
          ).statusCode,
          429,
        );
      assert.equal(await total(), before, 'A sender over its source budget writes nothing, whatever workflow it names');
      const unverified = await deliveries(flooded.id);
      assert.deepEqual(
        [unverified.length, [...new Set(unverified.map(entry => entry.outcome))]],
        [50, ['key-rejected']],
        'The log keeps the newest 50 deliveries',
      );
      assert.equal(await stored(flooded.id), 50, 'Older entries are deleted, not only hidden');

      const verified = [];
      for (let n = 0; n < 200 && verified.at(-1) !== 429; n++)
        verified.push(
          (
            await send(
              flooded.id,
              { requestId: randomUUID(), input: null },
              { authorization: `Bearer ${flooded.secret}` },
              `203.0.113.${(n % 250) + 1}`,
            )
          ).statusCode,
        );
      assert.deepEqual([...new Set(verified)], [200, 409, 429]);
      for (let n = 0; n < 3; n++)
        assert.equal(
          (
            await send(
              flooded.id,
              { requestId: randomUUID(), input: null },
              { authorization: `Bearer ${flooded.secret}` },
              '203.0.113.251',
            )
          ).statusCode,
          429,
        );
      const floodLog = await deliveries(flooded.id);
      assert.deepEqual(
        [floodLog[0].status, floodLog[0].outcome],
        [429, 'rate-limit-exceeded'],
        'The workflow budget refusing verified deliveries is logged',
      );
      assert.equal(
        floodLog.filter(entry => entry.status === 429).length,
        1,
        'Further 429 answers within a minute are not logged again',
      );

      await db.databaseAdmin.query(
        `UPDATE ${escapeIdentifier(w.names.schema)}.tf_workflow_webhook_deliveries SET received_at=received_at-interval '31 days' WHERE workflow_id=$1`,
        [github.id],
      );
      assert.deepEqual(await deliveries(github.id), [], 'Entries older than 30 days are not shown');
      assert.equal(
        (
          await send(
            github.id,
            { zen: 'Again' },
            { authorization: `Bearer ${github.secret}`, 'x-github-delivery': randomUUID() },
          )
        ).statusCode,
        200,
      );
      assert.equal(await stored(github.id), 1, 'The next delivery deletes entries older than 30 days');
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
