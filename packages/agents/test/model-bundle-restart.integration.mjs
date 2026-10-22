import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { escapeIdentifier } from 'pg';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { provisionTableRegistry } from '@tulipfarm/workspaces/table-registry';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { savedTaskAgent } from './task-fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createAgentExecutor } from '../src/executor.ts';

const catalog = name => fileURLToPath(new URL(`../../config/test/fixtures/${name}`, import.meta.url));
const run = promisify(execFile);

async function setup(t) {
  const db = await fixture();
  let runtime;
  const role = `registry_${randomUUID().replaceAll('-', '')}`,
    password = randomBytes(32).toString('hex');
  t.after(async () => {
    await runtime?.close();
    try {
      await db.databaseAdmin.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
      await db.admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    } finally {
      await db.close();
    }
  });
  await loadPlatformBaseline(db.platform);
  await db.platform.query(
    await readFile(new URL('../../../apps/database/migrations/0002_model_bundles.sql', import.meta.url), 'utf8'),
  );
  // The worker reaches the bundles through its authoring registry login, which the privilege check confines to the routines.
  await provisionTableRegistry(db.platform, { capability: 'authoring', role, password });
  const registry = new URL(db.connectionString);
  registry.username = role;
  registry.password = password;
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member,
    user,
  ]);
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], []);
  await createAgentExecutor({ runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(runtime);
  const task = await tasks.start(w.id, user, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    scope: [],
    text: 'Say hello.',
    limits: { toolCalls: 10, credits: 1000, activeMilliseconds: 600000 },
  });
  const worker = async (file, input) =>
    JSON.parse(
      (
        await run(process.execPath, [fileURLToPath(new URL('./model-bundle-restart-process.mjs', import.meta.url))], {
          env: {
            ...process.env,
            MODEL_CATALOG_FILE: catalog(file),
            MODEL_CATALOG: '',
            MODEL_BUNDLE_RESTART_INPUT: JSON.stringify({
              workspaceId: w.id,
              taskId: task.id,
              connectionString: db.login(w),
              registry: registry.href,
              health: db.connectionString,
              register: true,
              store: true,
              ...input,
            }),
          },
        })
      ).stdout
        .split('\n')
        .find(line => line.startsWith('model-bundle-restart '))
        .slice('model-bundle-restart '.length),
    );
  const generations = async () =>
    (
      await db.platform.query(
        `SELECT binding->>'bundleId' AS "bundleId", status FROM ${table('tf_model_generations')} ORDER BY generation`,
      )
    ).rows;
  return { db, task, worker, generations, read: () => tasks.read(w.id, user, task.id) };
}

test('a task admitted before a model catalog change finishes after restart at the original rates', async t => {
  const { db, task, worker, generations, read } = await setup(t);
  const before = await worker('model-catalog-acme.json', { outcome: 'unavailable', steps: 1 });
  assert.equal((await read()).status, 'pending');
  assert.deepEqual(await generations(), [{ bundleId: before.bundleId, status: 'pending' }]);

  const after = await worker('model-catalog-repriced.json', { outcome: 'success', steps: 4 });
  assert.notEqual(after.bundleId, before.bundleId);
  const completed = await read();
  assert.equal(completed.status, 'completed');
  assert.deepEqual(await generations(), [{ bundleId: before.bundleId, status: 'committed' }]);
  assert.equal(
    completed.cost.chargedCreditUnits,
    '200000000000',
    'two tenths of a cent at the original rates of 0.5 and 1.5 USD per million tokens',
  );
  assert.deepEqual(
    (await db.platform.query('SELECT id FROM model_lifecycle.bundles ORDER BY id')).rows.map(row => row.id),
    [before.bundleId, after.bundleId].sort(),
  );
  assert.equal(completed.id, task.id);
});

for (const [name, prepare] of Object.entries({
  'was never registered': { input: { register: false } },
  'was altered in the database': {
    input: {},
    tamper: async (db, bundleId) => {
      await assert.rejects(
        db.platform.query(
          `UPDATE model_lifecycle.bundles SET payload = jsonb_set(payload, '{models,0,rates,0,usdPerMillionTokens,input}', '0') WHERE id = $1`,
          [bundleId],
        ),
        /history is immutable/,
      );
      await db.platform.query(`ALTER TABLE model_lifecycle.bundles DISABLE TRIGGER USER;
      UPDATE model_lifecycle.bundles SET payload = jsonb_set(payload, '{routes,0,maxOutputTokens}', '1') WHERE id = '${bundleId}';
      ALTER TABLE model_lifecycle.bundles ENABLE TRIGGER USER`);
    },
  },
}))
  test(`a task whose original bundle ${name} does not run under the new configuration`, async t => {
    const { db, worker, generations, read } = await setup(t);
    const before = await worker('model-catalog-acme.json', { outcome: 'unavailable', steps: 1, ...prepare.input });
    await prepare.tamper?.(db, before.bundleId);
    await assert.rejects(
      worker('model-catalog-repriced.json', { outcome: 'success', steps: 2 }),
      /Model configuration changed|Untrusted model bundle/,
    );
    const stopped = await read();
    assert.notEqual(stopped.status, 'completed');
    assert.equal(stopped.cost.chargedCreditUnits, '0');
    assert.deepEqual(await generations(), [{ bundleId: before.bundleId, status: 'pending' }]);
  });
