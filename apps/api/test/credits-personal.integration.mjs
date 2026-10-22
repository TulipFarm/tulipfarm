import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { reserveCredits, settleCredits } from '@tulipfarm/workspace-storage/credits';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { registerCredits } from '../src/credits.ts';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';

// These tests assert workspace balances, so they fund work from the credit account as a billing extension would.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

test("personal credit usage covers only the caller's own flows on shared agents", { timeout: 60000 }, async () => {
  const db = await fixture();
  let runtime, app;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    const w = await db.create(stream);
    const table = name => `"${w.names.schema}".${name}`;
    const admin = { id: w.userId, membershipId: w.membershipId };
    const alice = { id: randomUUID(), membershipId: randomUUID() };
    const bob = { id: randomUUID(), membershipId: randomUUID() };
    for (const person of [alice, bob])
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        person.membershipId,
        person.id,
      ]);
    const agent = async (name, readers) => {
      const id = randomUUID(),
        revision = randomUUID().replaceAll('-', '').repeat(2),
        activation = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_agents')} (id,display_name) VALUES ($1,$2)`, [id, name]);
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,'{}')`,
        [id, revision],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_activations')} (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,'[]')`,
        [activation, id, revision],
      );
      for (const reader of readers)
        await db.platform.query(
          `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'read')`,
          [id, reader.membershipId],
        );
      return { id, revision, activation };
    };
    const shared = await agent('Shared helper', [alice, bob]);
    const revoked = await agent('Revoked helper', []);
    const chat = async person => {
      const id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id) VALUES ($1,$2,$3)`,
        [id, person.id, person.membershipId],
      );
      return id;
    };
    const delegated = async (person, on) => {
      const id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope) VALUES ($1,$2,$3,$4,'delegated',$5,$6,'[]')`,
        [id, on.id, on.activation, on.revision, person.id, person.membershipId],
      );
      return id;
    };
    const task = async person => {
      const id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id) VALUES ($1,$2,$3,$4,$5,$6,'[]','[]','{}',$1)`,
        [id, person.id, person.membershipId, shared.id, shared.activation, shared.revision],
      );
      return id;
    };
    const scheduled = async person => {
      const schedule = randomUUID(),
        id = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_schedules')} (id,activation_id,scope,sponsor_membership_id) VALUES ($1,$2,'[]',$3)`,
        [schedule, shared.activation, person.membershipId],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_runs')} (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,sponsor_membership_id) VALUES ($1,$2,$3,$4,'scheduled',$5,'[]',$6)`,
        [id, shared.id, shared.activation, shared.revision, schedule, person.membershipId],
      );
      return id;
    };
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      connectionsPerPool: 3,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    // Each call costs $0.001: 0.1 credit at the default price, with no rounding.
    const spend = async (flowId, activity, agentId, settle = true) => {
      const id = randomUUID();
      await runtime.transaction(w.id, { minimum: 1, maximum: stream.length }, tx =>
        reserveCredits(tx, {
          id,
          flowId,
          modelId: 'fixture-model',
          agentId,
          activity,
          providerPicoUsd: '1000000000',
          pricingRevision: 'fixture-v1',
        }),
      );
      if (settle)
        await runtime.transaction(w.id, { minimum: 1, maximum: stream.length }, tx =>
          settleCredits(tx, id, '1000000000'),
        );
    };
    for (const person of [alice, bob]) {
      await spend(await chat(person), 'chat', null);
      await spend(await delegated(person, shared), 'agent', shared.id);
      await spend(await task(person), 'agent', shared.id);
      await spend(await scheduled(person), 'agent', shared.id);
    }
    await spend(await delegated(alice, revoked), 'agent', revoked.id, false);
    await spend(randomUUID(), 'other', null);
    const auth = {
      api: {
        getSession: async ({ headers }) => {
          const id = headers.get('x-test-user');
          return id ? { user: { id } } : null;
        },
      },
    };
    app = Fastify();
    registerCredits(app, { runtime, auth });
    const read = async who => {
      const response = await app.inject({
        method: 'GET',
        url: `/workspaces/${w.id}/credits`,
        headers: { 'x-test-user': who.id },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const rows = summary =>
      summary.breakdown
        .map(({ agentId, agentName, activity, calls, credits }) => ({ agentId, agentName, activity, calls, credits }))
        .sort((a, b) => `${a.activity}${a.agentName}`.localeCompare(`${b.activity}${b.agentName}`));
    const mine = await read(alice);
    assert.equal(mine.scope, 'personal');
    assert.deepEqual(rows(mine), [
      { agentId: null, agentName: null, activity: 'agent', calls: 1, credits: 0 },
      { agentId: shared.id, agentName: 'Shared helper', activity: 'agent', calls: 3, credits: 0.3 },
      { agentId: null, agentName: null, activity: 'chat', calls: 1, credits: 0.1 },
    ]);
    assert.deepEqual(
      { used: mine.used, held: mine.held, unfunded: mine.unfunded },
      { used: 0.4, held: 0.1, unfunded: undefined },
    );
    assert.equal(JSON.stringify(mine).includes(revoked.id), false);
    const theirs = await read(bob);
    assert.deepEqual(rows(theirs), [
      { agentId: shared.id, agentName: 'Shared helper', activity: 'agent', calls: 3, credits: 0.3 },
      { agentId: null, agentName: null, activity: 'chat', calls: 1, credits: 0.1 },
    ]);
    assert.deepEqual({ used: theirs.used, held: theirs.held }, { used: 0.4, held: 0 });
    const workspace = await read(admin);
    assert.equal(workspace.scope, 'workspace');
    assert.deepEqual(
      { used: workspace.used, held: workspace.held, unfunded: workspace.unfunded },
      { used: 0.9, held: 0.1, unfunded: 0 },
    );
    assert.equal(
      workspace.breakdown.every(row => row.agentId === null),
      true,
    );
    assert.equal(mine.available, workspace.available);
    assert.equal(theirs.granted, workspace.granted);
  } finally {
    await app?.close();
    await runtime?.close();
    await db.close();
  }
});
