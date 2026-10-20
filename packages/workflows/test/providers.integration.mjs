import assert from 'node:assert/strict';
import { activate } from './commands.fixture.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { providerServer, providerSetupResponse } from './provider-fixture.mjs';

test(
  'restricted provider inbox survives restart, HTTP retries, lease races, revocation and credential rotation',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, login;
    let rows = [['a', 'initial']],
      mode = 'normal',
      release,
      arrived;
    const server = await providerServer(async call => {
      const setup = providerSetupResponse(call.url);
      if (setup) return setup;
      if (mode === 'rate') return { status: 429, headers: { 'retry-after': '120' }, body: {} };
      if (mode === 'hold') {
        arrived();
        await new Promise(resolve => {
          release = resolve;
        });
      }
      return { body: { values: rows } };
    });
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const other = await db.create(await workspaceTableMigrations());
      const options = {
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({
          workspaceId: id,
          generation: 1,
          connectionString: db.login(id === w.id ? w : other),
        }),
      };
      runtime = createWorkspaceRuntime(options);
      const providerOptions = {
        keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
        providerFetch: server.fetch,
      };
      let service = createWorkflows(runtime, providerOptions);
      const integrationId = randomUUID(),
        id = randomUUID(),
        revision = randomUUID(),
        table = name => qualified(w.names.schema, name);
      const input = {
        id: integrationId,
        name: 'Orders',
        token: 'test-secret',
        source: { provider: 'sheets', spreadsheetId: 'orders', range: 'Orders!A2:B1000', keyColumn: 0 },
        consent: true,
      };
      await service.providers.create(w.id, w.userId, input);
      await service.providers.create(w.id, w.userId, input);
      await db.platform.query(
        `UPDATE ${table('tf_provider_integrations')} SET credential=credential->'envelope' WHERE id=$1`,
        [integrationId],
      );
      assert.equal((await service.providers.list(w.id, w.userId)).length, 1);
      assert.equal(JSON.stringify(await service.providers.list(w.id, w.userId)).includes('test-secret'), false);
      const definition = {
        version: 1,
        name: 'New orders',
        trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
        steps: [{ id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: [] } } }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      const due = () =>
        db.platform.query(
          `UPDATE ${table('tf_provider_polls')} SET next_poll=clock_timestamp()-interval '1 second' WHERE workflow_id=$1`,
          [id],
        );
      await service.providers.poll(w.id);
      assert.equal((await service.providers.status(w.id, w.userId, id)).pending, 0);
      rows.push(['b', 'new']);
      await due();
      const count = server.requests.length;
      await Promise.all([service.providers.poll(w.id), service.providers.poll(w.id)]);
      assert.equal(server.requests.length, count + 1, 'one durable lease across concurrent pollers');
      assert.equal((await service.providers.status(w.id, w.userId, id)).pending, 1);
      await runtime.close();
      runtime = createWorkspaceRuntime(options);
      service = createWorkflows(runtime, providerOptions);
      await Promise.all([service.due(w.id), service.due(w.id)]);
      let history = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(history.length, 1);
      assert.deepEqual(history[0].input.values, ['b', 'new']);
      for (const work of await service.due(w.id)) {
        await service.advance(work);
        await service.advance(work);
      }
      assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs))[0].status, 'completed');
      await due();
      await service.providers.poll(w.id);
      await service.due(w.id);
      assert.equal((await service.history(w.id, w.userId, id).then(page => page.runs)).length, 1);
      await db.platform.query(
        `CREATE FUNCTION ${table('reject_provider_cursor')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cursor failure'; END $$; CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON ${table('tf_provider_polls')} FOR EACH ROW EXECUTE FUNCTION ${table('reject_provider_cursor')}()`,
      );
      rows.push(['atomic', 'commit together']);
      await due();
      await service.providers.poll(w.id);
      assert.equal(
        (await service.providers.status(w.id, w.userId, id)).pending,
        0,
        'inbox insert rolls back when cursor commit fails',
      );
      await db.platform.query(`DROP TRIGGER reject_cursor ON ${table('tf_provider_polls')}`);
      rows.pop();
      await due();
      mode = 'hold';
      const leaseReady = new Promise(resolve => {
        arrived = resolve;
      });
      const abandoned = service.providers.poll(w.id);
      await leaseReady;
      mode = 'normal';
      await due();
      await createWorkflows(runtime, providerOptions).providers.poll(w.id);
      const recovered = (
        await db.platform.query(`SELECT cursor FROM ${table('tf_provider_polls')} WHERE workflow_id=$1`, [id])
      ).rows[0].cursor;
      release();
      await abandoned;
      assert.deepEqual(
        (await db.platform.query(`SELECT cursor FROM ${table('tf_provider_polls')} WHERE workflow_id=$1`, [id])).rows[0]
          .cursor,
        recovered,
        'expired lease response cannot overwrite restarted poll',
      );
      const before = (
        await db.platform.query(`SELECT cursor FROM ${table('tf_provider_polls')} WHERE workflow_id=$1`, [id])
      ).rows[0].cursor;
      mode = 'rate';
      await due();
      await service.providers.poll(w.id);
      assert.equal((await service.providers.status(w.id, w.userId, id)).error, 'rate-limited');
      assert.deepEqual(
        (await db.platform.query(`SELECT cursor FROM ${table('tf_provider_polls')} WHERE workflow_id=$1`, [id])).rows[0]
          .cursor,
        before,
      );
      mode = 'hold';
      rows.push(['c', 'fenced']);
      await due();
      const ready = new Promise(resolve => {
        arrived = resolve;
      });
      const inFlight = service.providers.poll(w.id);
      await ready;
      const rotate = { commandId: randomUUID(), expectedGeneration: 1, enabled: true, token: 'rotated-secret' };
      await service.providers.update(w.id, w.userId, integrationId, rotate);
      assert.deepEqual(await service.providers.update(w.id, w.userId, integrationId, rotate), { saved: true });
      release();
      await inFlight;
      assert.equal(
        (await service.providers.status(w.id, w.userId, id)).pending,
        0,
        'old credential response is fenced',
      );
      mode = 'normal';
      await service.providers.poll(w.id);
      await service.due(w.id);
      history = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(history.length, 2);
      assert.equal(server.requests.at(-1).headers.authorization, 'Bearer rotated-secret');
      const queued = history.find(run => run.status === 'queued');
      const noOldKey = createWorkflows(runtime, {
        ...providerOptions,
        keyring: { activeKeyId: 'new', keys: { new: 'cd'.repeat(32) } },
      });
      await noOldKey.providers.update(w.id, w.userId, integrationId, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        enabled: false,
      });
      assert.equal((await service.providers.list(w.id, w.userId))[0].enabled, false);
      assert.deepEqual(
        await service.history(w.id, w.userId, id).then(page => page.runs),
        [],
        'disabled source hides retained provider data',
      );
      await service.providers.update(w.id, w.userId, integrationId, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        enabled: true,
      });
      await service.advance({ workspaceId: w.id, runId: queued.id });
      assert.equal(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).find(run => run.id === queued.id).status,
        'blocked',
      );
      rows.push(['d', 'revoked']);
      await due();
      mode = 'hold';
      const ready2 = new Promise(resolve => {
        arrived = resolve;
      });
      const revokeFlight = service.providers.poll(w.id);
      await ready2;
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        w.membershipId,
      ]);
      release();
      await revokeFlight;
      await assert.rejects(service.providers.list(w.id, w.userId), AccessDenied);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int AS count FROM ${table('tf_provider_events')}`)).rows[0].count,
        2,
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL,role='member' WHERE id=$1`, [
        w.membershipId,
      ]);
      await assert.rejects(service.providers.create(w.id, other.userId, { ...input, id: randomUUID() }), AccessDenied);
      const otherWorkflow = randomUUID(),
        otherRevision = randomUUID();
      await assert.rejects(
        service.save(other.id, other.userId, otherWorkflow, {
          revision: otherRevision,
          expectedRevision: null,
          definition,
        }),
        AccessDenied,
      );
      login = await connect(db.login(w));
      await denied(login, `UPDATE ${table('tf_provider_integrations')} SET source='{}'`);
      await denied(login, `UPDATE ${table('tf_provider_integrations')} SET membership_id=$1`, [other.membershipId]);
      await denied(login, `UPDATE ${table('tf_provider_events')} SET payload='{}'`);
      await denied(login, `SELECT * FROM ${qualified(other.names.schema, 'tf_provider_integrations')}`);
    } finally {
      release?.();
      await login?.end();
      await runtime?.close();
      await server.close();
      await db.close();
    }
  },
);

test(
  'reactivating a workflow the provider backlog disabled starts from new events instead of disabling it again',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    const rows = [['a', 'initial']];
    const server = await providerServer(call => providerSetupResponse(call.url) ?? { body: { values: rows } });
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime, {
        keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
        providerFetch: server.fetch,
      });
      const integrationId = randomUUID(),
        id = randomUUID(),
        revision = randomUUID();
      await service.providers.create(w.id, w.userId, {
        id: integrationId,
        name: 'Orders',
        token: 'fixture',
        source: { provider: 'sheets', spreadsheetId: 'orders', range: 'Orders!A2:B1000', keyColumn: 0 },
        consent: true,
      });
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'New orders',
          trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
          steps: [{ id: 'copy', kind: 'transform', fields: {} }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      await db.platform.query(
        `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload) SELECT $1,$2,'backlog-'||n,'{}' FROM generate_series(1,1000) n`,
        [id, revision],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload,admitted) VALUES ($1,$2,'started','{}',true)`,
        [id, revision],
      );
      const admitted = async () =>
        (
          await db.platform.query(
            `SELECT event_key FROM ${table('tf_provider_events')} WHERE workflow_id=$1 AND admitted`,
            [id],
          )
        ).rows.map(row => row.event_key);
      const state = async () => {
        const item = (await service.list(w.id, w.userId)).find(workflow => workflow.id === id);
        return {
          enabled: item.enabled,
          disabledReason: item.disabledReason,
          pending: (await service.providers.status(w.id, w.userId, id)).pending,
        };
      };
      const due = () =>
        db.platform.query(
          `UPDATE ${table('tf_provider_polls')} SET next_poll=clock_timestamp()-interval '1 second' WHERE workflow_id=$1`,
          [id],
        );

      await service.providers.poll(w.id);
      assert.deepEqual(
        await state(),
        { enabled: false, disabledReason: 'provider-backlog', pending: 1000 },
        'a full inbox disables the workflow',
      );

      await activate(service, w.id, w.userId, id, revision, true);
      assert.deepEqual(
        await state(),
        { enabled: true, disabledReason: null, pending: 0 },
        'activation discards the events left by the earlier activation',
      );
      assert.deepEqual(await admitted(), ['started'], 'events that already started runs stay for deduplication');
      await service.providers.poll(w.id);
      rows.push(['b', 'new']);
      await due();
      await service.providers.poll(w.id);
      assert.deepEqual(
        await state(),
        { enabled: true, disabledReason: null, pending: 1 },
        'the next polls keep the workflow enabled and collect new events',
      );
      await service.due(w.id);
      assert.deepEqual(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => run.input.values),
        [['b', 'new']],
        'the new event starts a run',
      );
    } finally {
      await runtime?.close();
      await server.close();
      await db.close();
    }
  },
);

test(
  'Forms pages persist continuation and deduplicate replay after process replacement',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    let page2 = false;
    const server = await providerServer(
      call =>
        providerSetupResponse(call.url) ?? {
          body:
            page2 && call.url.searchParams.get('pageToken') === 'second'
              ? {
                  responses: [
                    {
                      responseId: 'two',
                      createTime: new Date().toISOString(),
                      lastSubmittedTime: new Date().toISOString(),
                    },
                  ],
                }
              : {
                  responses: [
                    {
                      responseId: 'one',
                      createTime: new Date().toISOString(),
                      lastSubmittedTime: new Date().toISOString(),
                    },
                  ],
                  nextPageToken: 'second',
                },
        },
    );
    try {
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const options = {
        keyring: { activeKeyId: 'fixture', keys: { fixture: 'ab'.repeat(32) } },
        providerFetch: server.fetch,
      };
      const service = createWorkflows(runtime, options),
        integrationId = randomUUID(),
        id = randomUUID(),
        revision = randomUUID();
      await service.providers.create(w.id, w.userId, {
        id: integrationId,
        name: 'Forms',
        token: 'token',
        source: { provider: 'forms', formId: 'form1' },
        consent: true,
      });
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Forms',
          trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
          steps: [{ id: 'copy', kind: 'transform', fields: {} }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      await service.providers.poll(w.id);
      const restarted = createWorkflows(runtime, options);
      page2 = true;
      await db.platform.query(
        `UPDATE ${qualified(w.names.schema, 'tf_provider_polls')} SET next_poll=clock_timestamp()`,
      );
      await restarted.providers.poll(w.id);
      await restarted.due(w.id);
      assert.deepEqual(
        (await restarted.history(w.id, w.userId, id).then(page => page.runs)).map(run => run.input.responseId).sort(),
        ['one', 'two'],
      );
      assert.equal(server.requests.at(-1).url.searchParams.get('pageToken'), 'second');
      await db.platform.query(
        `UPDATE ${qualified(w.names.schema, 'tf_provider_polls')} SET next_poll=clock_timestamp()`,
      );
      await restarted.providers.poll(w.id);
      await restarted.due(w.id);
      assert.equal((await restarted.history(w.id, w.userId, id).then(page => page.runs)).length, 2);
    } finally {
      await runtime?.close();
      await server.close();
      await db.close();
    }
  },
);

test(
  'oversized Forms events commit with the cursor, preserve overflow evidence and exclude historical resubmissions',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime, release, arrived;
    let responses = [],
      hold = false;
    const server = await providerServer(async call => {
      const setup = providerSetupResponse(call.url);
      if (setup) return setup;
      if (hold) {
        arrived();
        await new Promise(resolve => {
          release = resolve;
        });
      }
      return { body: { responses } };
    });
    try {
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const options = { keyring: { activeKeyId: 'old', keys: { old: 'ab'.repeat(32) } }, providerFetch: server.fetch };
      const service = createWorkflows(runtime, options),
        integrationId = randomUUID(),
        id = randomUUID(),
        revision = randomUUID();
      await service.providers.create(w.id, w.userId, {
        id: integrationId,
        name: 'Forms',
        token: 'fixture',
        source: { provider: 'forms', formId: 'form1' },
        consent: true,
      });
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Forms',
          trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
          steps: [{ id: 'copy', kind: 'transform', fields: {} }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      const cursor = async () =>
        (await db.platform.query(`SELECT cursor FROM ${table('tf_provider_polls')} WHERE workflow_id=$1`, [id])).rows[0]
          .cursor;
      const before = await cursor(),
        stamp = new Date().toISOString();
      responses = [
        { responseId: 'old-edited', createTime: '2020-01-01T00:00:00Z', lastSubmittedTime: stamp },
        { responseId: 'oversized', createTime: stamp, lastSubmittedTime: stamp, answers: { text: 'x'.repeat(40000) } },
        { responseId: 'valid', createTime: stamp, lastSubmittedTime: stamp, answers: { text: 'yes' } },
      ];
      await db.platform.query(
        `CREATE FUNCTION ${table('reject_cursor')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cursor failure'; END $$; CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON ${table('tf_provider_polls')} FOR EACH ROW EXECUTE FUNCTION ${table('reject_cursor')}()`,
      );
      await service.providers.poll(w.id);
      assert.deepEqual(await cursor(), before);
      assert.equal((await service.providers.status(w.id, w.userId, id)).pending, 0);
      await db.platform.query(`DROP TRIGGER reject_cursor ON ${table('tf_provider_polls')}`);
      const due = () =>
        db.platform.query(`UPDATE ${table('tf_provider_polls')} SET next_poll=clock_timestamp() WHERE workflow_id=$1`, [
          id,
        ]);
      for (let i = 0; i < 3; i++) {
        await due();
        await createWorkflows(runtime, options).providers.poll(w.id);
      }
      const after = await cursor();
      assert.equal(after.activationFloor, before.activationFloor);
      assert.equal(after.sequence, 3);
      assert.equal((await service.providers.status(w.id, w.userId, id)).error, null);
      assert.equal((await service.providers.status(w.id, w.userId, id)).pending, 2);
      await service.due(w.id);
      const history = await service.history(w.id, w.userId, id).then(page => page.runs);
      assert.equal(history.length, 2);
      assert.equal(history.find(run => run.input.responseId === 'valid').input.answers.text, 'yes');
      const overflow = history.find(run => run.input.overflow);
      assert.equal(overflow.input.overflow.reason, 'provider-payload-too-large');
      assert.equal(overflow.input.overflow.eventKeyPreview, 'oversized');
      assert.ok(Buffer.byteLength(JSON.stringify(overflow.input)) <= 32768);
      hold = true;
      await due();
      const ready = new Promise(resolve => {
        arrived = resolve;
      });
      const flight = service.providers.poll(w.id);
      await ready;
      const noKeys = createWorkflows(runtime, { ...options, keyring: { activeKeyId: 'missing', keys: {} } });
      const disable = { commandId: randomUUID(), expectedGeneration: 1, enabled: false };
      await noKeys.providers.update(w.id, w.userId, integrationId, disable);
      await noKeys.providers.update(w.id, w.userId, integrationId, disable);
      release();
      await flight;
      assert.deepEqual(await cursor(), after);
      assert.equal((await service.providers.list(w.id, w.userId))[0].enabled, false);
      assert.deepEqual(
        await service.history(w.id, w.userId, id).then(page => page.runs),
        [],
        'disabled integration blocks history reads',
      );
      await service.providers.update(w.id, w.userId, integrationId, {
        commandId: randomUUID(),
        expectedGeneration: 2,
        enabled: true,
      });
      hold = false;
      responses = [
        { responseId: 'reenabled', createTime: new Date().toISOString(), lastSubmittedTime: new Date().toISOString() },
      ];
      await service.providers.poll(w.id);
      await service.due(w.id);
      assert.equal(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).find(
          run => run.input.responseId === 'reenabled',
        ).status,
        'queued',
      );
      await db.platform.query(
        `UPDATE ${table('tf_provider_integrations')} SET credential='{"corrupted":true}' WHERE id=$1`,
        [integrationId],
      );
      await noKeys.providers.update(w.id, w.userId, integrationId, {
        commandId: randomUUID(),
        expectedGeneration: 3,
        enabled: false,
      });
      assert.equal((await service.providers.list(w.id, w.userId))[0].enabled, false);
      assert.deepEqual(
        await service.history(w.id, w.userId, id).then(page => page.runs),
        [],
        'disabled source remains inaccessible after credential corruption',
      );
      const newKey = createWorkflows(runtime, {
        ...options,
        keyring: { activeKeyId: 'new', keys: { new: 'cd'.repeat(32) } },
      });
      const rotateDisabled = {
        commandId: randomUUID(),
        expectedGeneration: 4,
        enabled: false,
        token: 'replacement-while-disabled',
      };
      await newKey.providers.update(w.id, w.userId, integrationId, rotateDisabled);
      await newKey.providers.update(w.id, w.userId, integrationId, rotateDisabled);
      assert.deepEqual(
        (await newKey.providers.list(w.id, w.userId)).map(row => [row.enabled, row.generation]),
        [[false, 5]],
      );
      await newKey.providers.update(w.id, w.userId, integrationId, {
        commandId: randomUUID(),
        expectedGeneration: 5,
        enabled: true,
      });
      responses = [
        {
          responseId: 'rotated-disabled',
          createTime: new Date().toISOString(),
          lastSubmittedTime: new Date().toISOString(),
        },
      ];
      await newKey.providers.poll(w.id);
      await newKey.due(w.id);
      assert.equal(server.requests.at(-1).headers.authorization, 'Bearer replacement-while-disabled');
      assert.equal(
        (await newKey.history(w.id, w.userId, id).then(page => page.runs)).find(
          run => run.input.responseId === 'rotated-disabled',
        ).status,
        'queued',
      );
    } finally {
      release?.();
      await runtime?.close();
      await server.close();
      await db.close();
    }
  },
);
