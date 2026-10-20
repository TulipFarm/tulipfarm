import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createAgentStore } from '../src/store.ts';
import { provisionTestPgvector } from '../../workspace-storage/test/integration/pgvector.fixture.mjs';
import { loadPlatformBaseline, registerPlatformWorkspace } from '../../workspace-storage/test/integration/fixture.mjs';

test(
  'agent store operations on an unsaved agent deny everyone, including admins without agent grants',
  { timeout: 60000 },
  async () => {
    const workspaceId = randomUUID();
    const membershipId = randomUUID();
    const database = `agents_${randomUUID().replaceAll('-', '')}`;
    const databaseURL = new URL(
      process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-postgres@127.0.0.1:5432/postgres',
    );
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseURL.hostname));
    const admin = new Client({ connectionString: databaseURL.href });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await provisionTestPgvector(admin, database);
    databaseURL.pathname = `/${database}`;
    const connectionString = databaseURL.href;
    const login = capability => {
      const url = new URL(connectionString);
      url.username = names[capability];
      url.password = passwords[capability];
      return url.href;
    };
    const owner = new Client({ connectionString });
    await owner.connect();
    const passwords = { runtime: randomUUID(), migration: randomUUID(), confirmation: randomUUID() };
    let runtime;
    let names;
    try {
      await loadPlatformBaseline(owner);
      names = await provisionWorkspace({
        connectionString,
        workspaceId,
        passwords,
        initialAdmin: { userId: 'admin', membershipId },
        migrations: await workspaceTableMigrations(),
      });
      await registerPlatformWorkspace(owner, workspaceId);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: login('runtime') }),
      });
      const store = createAgentStore(runtime);
      const actor = { kind: 'human', userId: 'admin', membershipId };
      const teamId = randomUUID(),
        agentId = randomUUID(),
        revision = 'a'.repeat(64),
        activationId = randomUUID(),
        scheduleId = randomUUID();
      const scope = [{ assetId: teamId, permissions: ['table.create'] }];
      await owner.query(`INSERT INTO "${names.schema}".tf_teams (id, name) VALUES ($1, 'Billing')`, [teamId]);
      await owner.query(`INSERT INTO "${names.schema}".tf_agents (id) VALUES ($1)`, [agentId]);
      await owner.query(
        `INSERT INTO "${names.schema}".tf_agent_definitions (agent_id,revision,definition) VALUES ($1,$2,$3)`,
        [agentId, revision, { name: 'Billing', instructions: 'Create invoices', tools: ['schema.status'] }],
      );
      await owner.query(
        `INSERT INTO "${names.schema}".tf_agent_activations (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
        [activationId, agentId, revision, JSON.stringify(scope)],
      );
      await owner.query(`INSERT INTO "${names.schema}".tf_agent_schedules (id,activation_id,scope) VALUES ($1,$2,$3)`, [
        scheduleId,
        activationId,
        JSON.stringify(scope),
      ]);
      const denied = error => error?.message === 'Resource not found';
      await assert.rejects(
        store.saveDefinition(workspaceId, actor, agentId, {
          name: 'Billing',
          instructions: 'Changed',
          tools: ['schema.status'],
        }),
        denied,
      );
      await assert.rejects(store.activate(workspaceId, actor, { agentId, revision, scope }), denied);
      await assert.rejects(
        store.configure(workspaceId, actor, { agentId, version: 0, enabled: true, teamIds: [teamId], limits: scope }),
        denied,
      );
      await assert.rejects(store.authorizeSchedule(workspaceId, actor, { activationId, scope }), denied);
      await assert.rejects(store.revoke(workspaceId, actor, { kind: 'schedule', id: scheduleId }), denied);
      await assert.rejects(store.startScheduled(workspaceId, { scheduleId, runId: randomUUID() }), denied);
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS count FROM "${names.schema}".tf_agent_runs`)).rows[0].count,
        0,
      );
      assert.equal(
        (await owner.query(`SELECT revoked_at FROM "${names.schema}".tf_agent_schedules WHERE id=$1`, [scheduleId]))
          .rows[0].revoked_at,
        null,
      );
      for (const statement of [
        `UPDATE "${names.schema}".tf_agent_definitions SET definition = '{}' WHERE agent_id = '${agentId}'`,
        `UPDATE "${names.schema}".tf_agent_activations SET scope = '[]' WHERE id = '${activationId}'`,
      ])
        await assert.rejects(
          runtime.transaction(workspaceId, commonCompatibility, transaction => transaction.client.query(statement)),
          error => error.code === '42501',
        );
    } finally {
      await runtime?.close();
      await owner.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (names)
        for (const name of [names.runtime, names.migration, names.confirmation, names.customOwner])
          await admin.query(`DROP ROLE "${name}"`);
      await admin.end();
    }
  },
);
