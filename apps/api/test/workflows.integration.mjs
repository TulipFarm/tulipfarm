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

test(
  'HTTP authoring, history, manual execution, bearer webhook and scheduled reconciliation use real restricted storage',
  { timeout: 120000 },
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
      app = Fastify();
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
      const base = `/workspaces/${w.id}/workflows`,
        id = randomUUID(),
        revision = randomUUID();
      const headers = { origin: 'http://localhost:5173', cookie: 'test-session=admin' };
      const definition = {
        version: 1,
        name: 'HTTP example',
        trigger: { kind: 'webhook' },
        steps: [{ id: 'copy', kind: 'transform', fields: { event: { kind: 'input', path: [] } } }],
      };
      assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 401);
      const invalidOutput = await app.inject({
        method: 'PUT',
        url: `${base}/${randomUUID()}`,
        headers,
        payload: {
          revision: randomUUID(),
          expectedRevision: null,
          definition: {
            version: 1,
            name: 'Bad output',
            trigger: { kind: 'manual' },
            steps: [
              { id: 'source', kind: 'transform', fields: { total: { kind: 'literal', value: 12 } } },
              {
                id: 'copy',
                kind: 'transform',
                fields: { total: { kind: 'step', step: 'source', path: ['nonsense'] } },
              },
            ],
          },
        },
      });
      assert.equal(invalidOutput.statusCode, 400, invalidOutput.body);
      assert.equal(invalidOutput.json().error, 'invalid-output-path');
      assert.match(invalidOutput.json().issues[0].message, /copy.*source.*nonsense/);
      assert.deepEqual(invalidOutput.json().issues[0].path, ['definition', 'steps', 1, 'fields', 'total', 'path']);
      const saved = await app.inject({
        method: 'PUT',
        url: `${base}/${id}`,
        headers,
        payload: { revision, expectedRevision: null, definition },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.deepEqual(saved.json().definition, definition);
      const detail = await app.inject({ method: 'GET', url: `${base}/${id}`, headers });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.deepEqual(detail.json().definition, definition);
      assert.equal(detail.headers['cache-control'], 'no-store');
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/${id}?revision=invalid`, headers })).statusCode,
        400,
      );
      assert.equal((await app.inject({ method: 'GET', url: `${base}/${id}` })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `${base}/${id}`,
            headers: { cookie: headers.cookie },
            payload: { revision, expectedRevision: null, definition },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `${base}/${id}/sponsorship`,
            headers,
            payload: { sponsorMembershipId: w.membershipId, historyAudience: [w.membershipId] },
          })
        ).statusCode,
        200,
      );
      const enable = { commandId: randomUUID(), expectedGeneration: 2, revision, enabled: true };
      assert.equal(
        (await app.inject({ method: 'POST', url: `${base}/${id}/activation`, headers, payload: enable })).statusCode,
        200,
      );
      const firstKey = { commandId: randomUUID(), expectedGeneration: 3, mode: 'bearer', graceSeconds: 0 };
      const issued = await app.inject({ method: 'PUT', url: `${base}/${id}/webhook-key`, headers, payload: firstKey });
      assert.equal(issued.statusCode, 200, issued.body);
      const { key } = issued.json();
      const payload = { requestId: randomUUID(), input: { z: 1, a: 2 } };
      assert.equal((await app.inject({ method: 'POST', url: `${base}/${id}/webhook`, payload })).statusCode, 404);
      const hook = await app.inject({
        method: 'POST',
        url: `${base}/${id}/webhook`,
        headers: { authorization: `Bearer ${key}` },
        payload,
      });
      assert.equal(hook.statusCode, 200, hook.body);
      assert.deepEqual(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/webhook`,
            headers: { authorization: `Bearer ${key}` },
            payload,
          })
        ).json(),
        hook.json(),
      );
      const manual = await app.inject({ method: 'POST', url: `${base}/${id}/runs`, headers, payload });
      assert.equal(manual.statusCode, 200, manual.body);
      assert.notEqual(manual.json().runId, hook.json().runId);
      for (const work of await service.due(w.id)) {
        await service.advance(work);
        await service.advance(work);
      }
      const history = await app.inject({ method: 'GET', url: `${base}/${id}/runs`, headers });
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.json().nextCursor, null);
      assert.deepEqual(
        history.json().runs.map(run => run.status),
        ['completed', 'completed'],
      );
      assert.deepEqual(
        history
          .json()
          .runs.map(run => run.source)
          .sort(),
        ['manual', 'webhook'],
      );
      assert.deepEqual(history.json().runs[0].steps[0].output, { event: { z: 1, a: 2 } });
      const runDetail = await app.inject({ method: 'GET', url: `${base}/${id}/runs/${manual.json().runId}`, headers });
      assert.equal(runDetail.statusCode, 200, runDetail.body);
      assert.equal(runDetail.headers['cache-control'], 'no-store');
      assert.deepEqual(runDetail.json().definition, definition);
      assert.equal(runDetail.json().actor.id, w.membershipId);
      assert.deepEqual(
        runDetail.json().run,
        history.json().runs.find(run => run.id === manual.json().runId),
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/${randomUUID()}/runs/${manual.json().runId}`, headers }))
          .statusCode,
        404,
      );
      const newest = (
        await db.platform.query(
          `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || id AS cursor FROM "${w.names.schema}".tf_workflow_runs WHERE id=$1`,
          [history.json().runs[0].id],
        )
      ).rows[0].cursor;
      const manualRun = await app.inject({
        method: 'GET',
        url: `${base}/${id}/runs?status=completed&before=${encodeURIComponent(newest)}`,
        headers,
      });
      assert.equal(manualRun.statusCode, 200, manualRun.body);
      assert.deepEqual(
        manualRun.json(),
        { runs: [history.json().runs[1]], nextCursor: null },
        'the cursor and status filter pass through the query string',
      );
      for (const query of ['status=finished', 'before=yesterday', 'limit=10'])
        assert.deepEqual((await app.inject({ method: 'GET', url: `${base}/${id}/runs?${query}`, headers })).json(), {
          error: 'invalid-request',
        });
      const scheduled = randomUUID(),
        onceRevision = randomUUID();
      await service.save(w.id, w.userId, scheduled, {
        revision: onceRevision,
        expectedRevision: null,
        definition: { ...definition, trigger: { kind: 'once', at: '2099-01-01T00:00:00Z' } },
      });
      await service.sponsorship(w.id, w.userId, scheduled, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      const activation = { commandId: randomUUID(), expectedGeneration: 2, revision: onceRevision, enabled: true };
      assert.equal(
        (await service.activate(w.id, w.userId, scheduled, activation)).nextRunAt,
        '2099-01-01T00:00:00.000Z',
      );
      await db.platform.query(
        `UPDATE "${w.names.schema}".tf_workflows SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [scheduled],
      );
      await Promise.all([service.due(w.id), service.due(w.id)]);
      assert.deepEqual(
        (await service.history(w.id, w.userId, scheduled).then(page => page.runs)).map(run => run.source),
        ['schedule'],
      );
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === scheduled)?.nextRunAt, null);
      await service.activate(w.id, w.userId, scheduled, activation);
      await service.due(w.id);
      assert.equal((await service.history(w.id, w.userId, scheduled).then(page => page.runs)).length, 1);
      const eventId = randomUUID(),
        eventRevision = randomUUID();
      await service.save(w.id, w.userId, eventId, {
        revision: eventRevision,
        expectedRevision: null,
        definition: { ...definition, trigger: { kind: 'event', name: 'form_submitted' } },
      });
      await service.activate(w.id, w.userId, eventId, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision: eventRevision,
        enabled: true,
      });
      const emitted = await app.inject({
        method: 'POST',
        url: `${base}/${eventId}/events`,
        headers,
        payload: { ...payload, name: 'form_submitted' },
      });
      assert.equal(emitted.statusCode, 200, emitted.body);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${eventId}/events`,
            headers,
            payload: { ...payload, name: 'wrong_event' },
          })
        ).statusCode,
        404,
      );
      assert.deepEqual(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${eventId}/events`,
            headers,
            payload: { ...payload, name: 'form_submitted' },
          })
        ).json(),
        emitted.json(),
      );
      const { key: changedKey } = await service.webhookKey(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 4,
        mode: 'bearer',
        graceSeconds: 0,
      });
      assert.deepEqual(
        (await app.inject({ method: 'PUT', url: `${base}/${id}/webhook-key`, headers, payload: firstKey })).json()
          .workflow.generation,
        5,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/webhook`,
            headers: { authorization: `Bearer ${key}` },
            payload,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/webhook`,
            headers: { authorization: `Bearer ${changedKey}` },
            payload,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `${base}/${id}/webhook-key`,
            headers,
            payload: { ...firstKey, graceSeconds: 60 },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/activation`,
            headers,
            payload: { commandId: randomUUID(), expectedGeneration: 5, revision, enabled: false },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${base}/${id}/activation`, headers, payload: enable })).json()
          .enabled,
        false,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/activation`,
            headers,
            payload: { ...enable, commandId: randomUUID() },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/activation`,
            headers,
            payload: { revision, enabled: true },
          })
        ).statusCode,
        400,
      );
      const archive = { commandId: randomUUID(), expectedGeneration: 6 };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/archive`,
            headers,
            payload: { commandId: archive.commandId },
          })
        ).statusCode,
        400,
      );
      assert.deepEqual(
        (await app.inject({ method: 'POST', url: `${base}/${id}/archive`, headers, payload: archive })).json(),
        { archived: true },
      );
      assert.deepEqual(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/${id}/archive`,
            headers,
            payload: { commandId: randomUUID(), expectedGeneration: 7 },
          })
        ).json(),
        { error: 'workflow-archived' },
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: base, headers })).json().some(item => item.id === id),
        false,
      );
      assert.equal((await app.inject({ method: 'GET', url: `${base}/${id}/runs`, headers })).statusCode, 200);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
