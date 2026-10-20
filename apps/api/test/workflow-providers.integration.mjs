import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '@tulipfarm/workflows';
import { registerWorkflows } from '../src/workflows.ts';
import { protectBusinessRequests } from '../src/business.ts';
import { providerServer, providerSetupResponse } from '../../../packages/workflows/test/provider-fixture.mjs';

test(
  'provider setup HTTP enforces origin, membership, consent, immutable source and replay-safe rotation',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    let providerError = false,
      holdProbe = false,
      releaseProbe,
      probeStarted;
    const logs = [];
    const server = await providerServer(async call => {
      if (holdProbe) {
        holdProbe = false;
        probeStarted();
        await new Promise(resolve => {
          releaseProbe = resolve;
        });
      }
      if (providerError) return { status: 401, body: { secret: 'synthetic-token' } };
      if (call.url.pathname === '/drive/v3/files')
        return { body: { files: [{ id: 'form1', name: 'Customer form', token: 'synthetic-token' }] } };
      return (
        providerSetupResponse(call.url) ?? {
          body: {
            responses: [
              {
                responseId: 'submitted',
                createTime: new Date().toISOString(),
                lastSubmittedTime: new Date().toISOString(),
                answers: { answer: { textAnswers: { answers: [{ value: 'yes' }] } } },
              },
            ],
          },
        }
      );
    });
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
        keyring: { activeKeyId: 'test', keys: { test: 'ab'.repeat(32) } },
        providerFetch: server.fetch,
      });
      app = Fastify({ logger: { stream: { write: line => logs.push(line) } } });
      protectBusinessRequests(app);
      registerWorkflows(app, {
        service,
        auth: {
          api: {
            getSession: async ({ headers }) =>
              headers.get('cookie') === 'test-session=admin' ? { user: { id: w.userId } } : null,
          },
        },
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address(),
        base = `http://127.0.0.1:${address.port}/workspaces/${w.id}/workflows`;
      const headers = {
        origin: 'http://localhost:5173',
        cookie: 'test-session=admin',
        'content-type': 'application/json',
      };
      const call = (path, method = 'GET', body, customHeaders = headers) =>
        fetch(`${base}${path}`, { method, headers: customHeaders, ...(body ? { body: JSON.stringify(body) } : {}) });
      const integrationId = randomUUID(),
        input = {
          id: integrationId,
          name: 'Submitted forms',
          source: { provider: 'forms', formId: 'form1' },
          token: 'synthetic-token',
          consent: true,
        };
      assert.equal((await call('/provider-integrations', 'GET', undefined, {})).status, 401);
      assert.equal(
        (await call('/provider-integrations', 'POST', input, { ...headers, origin: 'https://attacker.example' }))
          .status,
        403,
      );
      assert.equal((await call('/provider-integrations', 'POST', { ...input, consent: false })).status, 400);
      const probe = { source: input.source, token: input.token };
      assert.equal(
        (
          await call('/provider-integrations/test', 'POST', probe, {
            origin: headers.origin,
            'content-type': 'application/json',
          })
        ).status,
        401,
      );
      assert.equal(
        (await call('/provider-integrations/test', 'POST', probe, { ...headers, origin: 'https://attacker.example' }))
          .status,
        403,
      );
      const tested = await call('/provider-integrations/test', 'POST', probe);
      assert.equal(tested.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await tested.json(), { verified: true });
      const listed = await call('/provider-integrations/resources', 'POST', {
        provider: 'forms',
        resource: 'formId',
        token: input.token,
      });
      assert.equal(listed.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await listed.json(), { items: [{ value: 'form1', label: 'Customer form' }], nextCursor: null });
      assert.deepEqual(await (await call('/provider-integrations')).json(), []);
      providerError = true;
      for (const path of ['/provider-integrations/test', '/provider-integrations']) {
        const failed = await call(path, 'POST', path.endsWith('/test') ? probe : input);
        assert.equal(failed.status, 409);
        assert.deepEqual(await failed.json(), { error: 'credentials' });
      }
      const failedResources = await call('/provider-integrations/resources', 'POST', {
        provider: 'forms',
        resource: 'formId',
        token: input.token,
      });
      assert.equal(failedResources.status, 409);
      assert.deepEqual(await failedResources.json(), { error: 'credentials' });
      assert.deepEqual(await (await call('/provider-integrations')).json(), []);
      providerError = false;
      for (let replay = 0; replay < 2; replay++)
        assert.equal((await call('/provider-integrations', 'POST', input)).status, 200);
      const metadata = await (await call('/provider-integrations')).json();
      assert.equal(metadata.length, 1);
      assert.equal(JSON.stringify(metadata).includes('synthetic-token'), false);
      assert.equal(
        (await call('/provider-integrations', 'POST', { ...input, source: { provider: 'forms', formId: 'other' } }))
          .status,
        409,
      );
      const id = randomUUID(),
        revision = randomUUID();
      const definition = {
        version: 1,
        name: 'Submitted forms',
        trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
        steps: [{ id: 'result', kind: 'transform', fields: { data: { kind: 'input', path: [] } } }],
      };
      assert.equal((await call(`/${id}`, 'PUT', { revision, expectedRevision: null, definition })).status, 200);
      assert.equal(
        (
          await call(`/${id}/sponsorship`, 'PUT', {
            sponsorMembershipId: w.membershipId,
            historyAudience: [w.membershipId],
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(`/${id}/activation`, 'POST', {
            commandId: randomUUID(),
            expectedGeneration: 2,
            revision,
            enabled: true,
          })
        ).status,
        200,
      );
      await service.providers.poll(w.id);
      assert.equal((await (await call(`/${id}/provider-status`)).json()).pending, 1);
      for (const work of await service.due(w.id)) {
        await service.advance(work);
        await service.advance(work);
      }
      const { runs: history } = await (await call(`/${id}/runs`)).json();
      assert.equal(history[0].status, 'completed');
      assert.equal(history[0].steps[0].output.data.responseId, 'submitted');
      const rotation = { commandId: randomUUID(), expectedGeneration: 1, enabled: true, token: 'new-token' };
      providerError = true;
      assert.equal((await call(`/provider-integrations/${integrationId}`, 'PATCH', rotation)).status, 409);
      assert.equal((await (await call('/provider-integrations')).json())[0].generation, 1);
      providerError = false;
      for (let replay = 0; replay < 2; replay++)
        assert.equal((await call(`/provider-integrations/${integrationId}`, 'PATCH', rotation)).status, 200);
      assert.equal((await (await call('/provider-integrations')).json())[0].generation, 2);
      assert.equal(
        (await call(`/provider-integrations/${integrationId}`, 'PATCH', { ...rotation, token: 'different' })).status,
        409,
      );
      holdProbe = true;
      const started = new Promise(resolve => {
        probeStarted = resolve;
      });
      const staleRotation = call(`/provider-integrations/${integrationId}`, 'PATCH', {
        ...rotation,
        commandId: randomUUID(),
        expectedGeneration: 2,
        token: 'held-token',
      });
      await started;
      assert.equal(
        (
          await call(`/provider-integrations/${integrationId}`, 'PATCH', {
            commandId: randomUUID(),
            expectedGeneration: 2,
            enabled: false,
          })
        ).status,
        200,
      );
      releaseProbe();
      const staleResult = await staleRotation;
      assert.equal(staleResult.status, 409);
      assert.deepEqual(await staleResult.json(), { error: 'stale-generation' });
      providerError = true;
      assert.equal((await call(`/provider-integrations/${integrationId}`, 'PATCH', rotation)).status, 200);
      assert.equal((await call('/provider-integrations', 'POST', input)).status, 200);
      const disabled = (await (await call('/provider-integrations')).json())[0];
      assert.equal(disabled.generation, 3);
      assert.equal(disabled.enabled, false);
      assert.equal(
        (await call(`/provider-integrations/${integrationId}`, 'PATCH', { ...rotation, commandId: randomUUID() }))
          .status,
        409,
      );
      providerError = false;
      holdProbe = true;
      const revoking = new Promise(resolve => {
        probeStarted = resolve;
      });
      const staleTest = call('/provider-integrations/test', 'POST', probe);
      await revoking;
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`,
        [w.membershipId],
      );
      releaseProbe();
      assert.equal((await staleTest).status, 404);
      assert.equal((await call('/provider-integrations')).status, 404);
      assert.equal((await call(`/${id}/provider-status`)).status, 404);
      const requestsBeforeDenied = server.requests.length;
      assert.equal((await call('/provider-integrations/test', 'POST', probe)).status, 404);
      assert.equal(
        (
          await call('/provider-integrations/resources', 'POST', {
            provider: 'forms',
            resource: 'formId',
            token: input.token,
          })
        ).status,
        404,
      );
      assert.equal(server.requests.length, requestsBeforeDenied);
      for (const secret of ['synthetic-token', 'new-token', 'held-token'])
        assert.equal(logs.join('').includes(secret), false, 'tokens never appear in API logs');
    } finally {
      releaseProbe?.();
      await app?.close();
      await runtime?.close();
      await server.close();
      await db.close();
    }
  },
);
