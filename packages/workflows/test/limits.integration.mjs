import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';
import { providerSetupFetch } from './provider-fixture.mjs';

const limited = { message: 'limit-reached' };

test(
  'members have their own workflow, run and provider quotas under a hidden workspace cap',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      const person = async () => {
        const userId = randomUUID(),
          membershipId = randomUUID();
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          membershipId,
          userId,
        ]);
        return { userId, membershipId };
      };
      const alice = await person(),
        bob = await person(),
        carol = await person();
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime, {
        keyring: { activeKeyId: 'test', keys: { test: '07'.repeat(32) } },
        providerFetch: providerSetupFetch,
      });
      const definition = {
        version: 1,
        name: 'Review',
        trigger: { kind: 'manual' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Decide', timeoutSeconds: 60 }],
      };
      const save = (who, id = randomUUID(), revision = randomUUID()) =>
        service.save(w.id, who.userId, id, { revision, expectedRevision: null, definition });

      // Workflows: 25 per creator.
      const aliceFirst = randomUUID(),
        aliceRevision = randomUUID();
      await save(alice, aliceFirst, aliceRevision);
      for (let n = 1; n < 25; n++) await save(alice);
      await assert.rejects(save(alice), limited);
      await save(bob);

      // Active runs: 25 per requester, counted separately for each person.
      await activate(service, w.id, alice.userId, aliceFirst, aliceRevision, true);
      await service.share(w.id, alice.userId, aliceFirst, {
        principal: { kind: 'person', id: bob.membershipId },
        permissions: ['invoke'],
      });
      const start = who => service.start(w.id, who.userId, aliceFirst, { requestId: randomUUID(), input: 'review' });
      for (let n = 0; n < 25; n++) await start(alice);
      await assert.rejects(start(alice), limited);
      await start(bob);

      // Providers: 25 per member.
      const provider = who =>
        service.providers.create(w.id, who.userId, {
          id: randomUUID(),
          name: 'Forms',
          token: 'fixture',
          source: { provider: 'forms', formId: 'form1' },
          consent: true,
        });
      for (let n = 0; n < 25; n++) await provider(alice);
      await assert.rejects(provider(alice), limited);
      await provider(bob);

      // The workspace cap reports the same error, revealing nothing about others' activity.
      const existing = (await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_workflows')}`))
        .rows[0].count;
      for (let n = existing; n < 100; n++) {
        const id = randomUUID(),
          revision = randomUUID();
        await db.platform.query('BEGIN');
        await db.platform.query(`INSERT INTO ${table('tf_workflows')} (id,revision) VALUES ($1,$2)`, [id, revision]);
        await db.platform.query(
          `INSERT INTO ${table('tf_workflow_revisions')} (workflow_id,id,definition,author_membership_id) VALUES ($1,$2,$3,$4)`,
          [id, revision, JSON.stringify(definition), bob.membershipId],
        );
        await db.platform.query('COMMIT');
      }
      await assert.rejects(save(carol), limited);
      assert.equal((await service.list(w.id, carol.userId)).length, 0);
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'a webhook workflow parked in long waits keeps accepting events up to its own parked cap',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    let runtime;
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
        keyring: { activeKeyId: 'test', keys: { test: '07'.repeat(32) } },
        providerFetch: providerSetupFetch,
      });
      const keys = new Map();
      async function webhookWorkflow(steps) {
        const id = randomUUID(),
          revision = randomUUID();
        await service.save(w.id, w.userId, id, {
          revision,
          expectedRevision: null,
          definition: { version: 1, name: 'Follow up', trigger: { kind: 'webhook' }, steps },
        });
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        await activate(service, w.id, w.userId, id, revision, true);
        const current = (await service.list(w.id, w.userId)).find(item => item.id === id);
        keys.set(
          id,
          (
            await service.webhookKey(w.id, w.userId, id, {
              commandId: randomUUID(),
              expectedGeneration: current.generation,
              mode: 'bearer',
            })
          ).key,
        );
        return { id, revision };
      }
      const send = id =>
        service.webhook(w.id, id, {
          body: { requestId: randomUUID(), input: null },
          headers: { authorization: `Bearer ${keys.get(id)}` },
        });
      const park = async id => {
        const { runId } = await send(id);
        return service.advance({ workspaceId: w.id, runId });
      };

      const longWait = await webhookWorkflow([{ id: 'later', kind: 'delay', seconds: 366 * 86400 }]);
      const deadline = await webhookWorkflow([
        {
          id: 'deadline',
          kind: 'wait-until',
          at: { kind: 'literal', value: new Date(Date.now() + 300 * 86400000).toISOString() },
        },
      ]);
      for (let n = 0; n < 20; n++)
        assert.deepEqual(await park(longWait.id), { kind: 'wait', seconds: 366 * 86400 }, 'A delay parks its run');
      for (let n = 0; n < 15; n++) assert.equal((await park(deadline.id)).kind, 'wait', 'A wait-until parks its run');
      assert.equal(
        (await service.history(w.id, w.userId, longWait.id).then(page => page.runs)).filter(
          run => run.status === 'waiting',
        ).length,
        20,
        'Parked runs stay above the workflow and sponsor caps',
      );

      const approval = await webhookWorkflow([
        { id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 86400 },
      ]);
      for (let n = 0; n < 10; n++) await park(approval.id);
      await assert.rejects(
        send(approval.id),
        { message: 'limit-reached', scope: 'workflow' },
        'Unanswered human steps still count toward the workflow cap',
      );

      const manual = async () => {
        const { runId } = await service.start(w.id, w.userId, longWait.id, { requestId: randomUUID(), input: null });
        return service.advance({ workspaceId: w.id, runId });
      };
      for (let n = 0; n < 15; n++) assert.equal((await manual()).kind, 'wait', 'A manual run parks in the delay');
      await assert.rejects(
        service.start(w.id, w.userId, longWait.id, { requestId: randomUUID(), input: null }),
        { message: 'limit-reached', scope: 'member' },
        "Parked manual runs still count toward their requester's quota",
      );
      for (const run of (await service.history(w.id, w.userId, longWait.id).then(page => page.runs)).filter(
        item => item.source === 'manual',
      ))
        await service.cancel(w.id, w.userId, longWait.id, run.id);

      const parked = (
        await db.platform.query(
          `SELECT count(*)::integer AS count FROM ${table('tf_workflow_runs')} WHERE workflow_id=$1 AND status='waiting'`,
          [longWait.id],
        )
      ).rows[0].count;
      for (let n = parked; n < 100; n++) {
        const runId = randomUUID();
        await db.platform.query(
          `INSERT INTO ${table('tf_workflow_runs')} (id,workflow_id,revision,request_key,membership_id,input,sponsorship_id,status) SELECT $1,id,active_revision,$2,sponsor_membership_id,'null'::jsonb,sponsorship_id,'waiting' FROM ${table('tf_workflows')} WHERE id=$3`,
          [runId, `webhook:${runId}`, longWait.id],
        );
        await db.platform.query(
          `INSERT INTO ${table('tf_workflow_steps')} (run_id,step_id,ordinal,status,due_at) VALUES ($1,'later',0,'waiting',clock_timestamp()+interval '300 days')`,
          [runId],
        );
      }
      await assert.rejects(
        send(longWait.id),
        { message: 'limit-reached', scope: 'parked' },
        "The parked cap bounds one workflow's waiting runs",
      );
      assert.equal((await park(deadline.id)).kind, 'wait', 'A sibling workflow keeps its own parked capacity');

      await db.platform.query(
        `UPDATE ${table('tf_workflow_steps')} s SET due_at=clock_timestamp()-interval '1 second' FROM ${table('tf_workflow_runs')} r WHERE r.id=s.run_id AND r.workflow_id=$1`,
        [deadline.id],
      );
      await assert.rejects(
        send(deadline.id),
        { message: 'limit-reached', scope: 'workflow' },
        'Runs whose wait has elapsed count as unfinished again',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  "a provider backlog at its workflow run cap leaves later sweeps to the sponsor's other workflows",
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
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
        keyring: { activeKeyId: 'test', keys: { test: '07'.repeat(32) } },
        providerFetch: providerSetupFetch,
      });
      const integrationId = randomUUID();
      await service.providers.create(w.id, w.userId, {
        id: integrationId,
        name: 'Orders',
        token: 'fixture',
        source: { provider: 'sheets', spreadsheetId: 'orders', range: 'Orders!A2:B1000', keyColumn: 0 },
        consent: true,
      });
      const definition = {
        version: 1,
        name: 'New orders',
        trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
        steps: [{ id: 'copy', kind: 'transform', fields: { order: { kind: 'input', path: [] } } }],
      };
      async function workflow(events) {
        const id = randomUUID(),
          revision = randomUUID();
        await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
        await service.sponsorship(w.id, w.userId, id, {
          sponsorMembershipId: w.membershipId,
          historyAudience: [w.membershipId],
        });
        await activate(service, w.id, w.userId, id, revision, true);
        for (let n = 0; n < events; n++)
          await db.platform.query(
            `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload) VALUES ($1,$2,$3,$4)`,
            [id, revision, `row-${n}`, JSON.stringify({ values: [String(n)] })],
          );
        return id;
      }
      const busy = await workflow(35),
        quiet = await workflow(1);
      const runs = async id => (await service.history(w.id, w.userId, id).then(page => page.runs)).length;
      const pending = async id =>
        (
          await db.platform.query(
            `SELECT count(*)::integer AS count FROM ${table('tf_provider_events')} WHERE workflow_id=$1 AND NOT admitted`,
            [id],
          )
        ).rows[0].count;

      await service.due(w.id);
      assert.deepEqual(
        [await runs(busy), await pending(busy), await runs(quiet)],
        [10, 25, 0],
        "The first sweep reaches only the busy workflow's oldest events",
      );
      await service.due(w.id);
      assert.deepEqual(
        [await runs(busy), await pending(busy), await runs(quiet), await pending(quiet)],
        [10, 25, 1, 0],
        'The next sweep passes over the capped workflow',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'provider sweeps keep admitting events while earlier runs sleep in a long delay',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    let runtime;
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
        keyring: { activeKeyId: 'test', keys: { test: '07'.repeat(32) } },
        providerFetch: providerSetupFetch,
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
          name: 'Order follow-up',
          trigger: { kind: 'provider', integrationId, event: 'created', minutes: 1 },
          steps: [{ id: 'later', kind: 'delay', seconds: 30 * 86400 }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await activate(service, w.id, w.userId, id, revision, true);
      for (let n = 0; n < 30; n++)
        await db.platform.query(
          `INSERT INTO ${table('tf_provider_events')} (workflow_id,revision,event_key,payload) VALUES ($1,$2,$3,$4)`,
          [id, revision, `row-${n}`, JSON.stringify({ values: [String(n)] })],
        );
      for (let sweep = 0; sweep < 3; sweep++) for (const work of await service.due(w.id)) await service.advance(work);
      assert.deepEqual(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => run.status),
        Array(30).fill('waiting'),
        'Every event is admitted and parked',
      );
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
