import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied, canAccessTable } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createGeneration, activateGeneration } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { createSystemPackages } from '../src/system-packages.ts';
import { packageCompiler } from '../src/system-package-compiler.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { memorySkillBytes } from './skill-draft-fixture.mjs';

async function packageFixture(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
  });
  const options = {
    runtime,
    identity: db.platform,
    objects: memorySkillBytes(),
    resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
  };
  const service = createSystemPackages(options);
  const team = randomUUID();
  const schema = `"${w.names.schema}"`;
  await db.platform.query(`INSERT INTO ${schema}.tf_teams(id,name) VALUES($1,'Package owners')`, [team]);
  await db.platform.query(`INSERT INTO ${schema}.tf_member_teams(team_id,membership_id,role) VALUES($1,$2,'manager')`, [
    team,
    w.membershipId,
  ]);
  const bindings = {
    'owning-team': { kind: 'team', id: team },
    'package-manager': { kind: 'member', id: w.membershipId },
  };
  const example = async name =>
    JSON.parse(await readFile(new URL(`../../config/examples/system-packages/${name}.json`, import.meta.url)));
  const resume = view => service.resume(w.id, w.userId, view.id, { expectedVersion: view.version });
  const approve = (view, node = view.nodes.find(node => node.state === 'waiting-review')) =>
    service.review(w.id, w.userId, view.id, {
      requestId: randomUUID(),
      expectedVersion: view.version,
      key: node.key,
      digest: node.review.digest,
      decision: 'approve',
    });
  const prepared = async (view, node) =>
    (
      await db.platform.query(
        `SELECT command_id,receipt FROM ${schema}.tf_system_package_operations WHERE installation_id=$1 AND resource_key=$2 AND attempt=$3 AND operation='prepare'`,
        [view.id, node.key, node.attempt],
      )
    ).rows[0];
  return { db, w, runtime, options, service, team, schema, bindings, example, resume, approve, prepared };
}

test('durable installation honors retries and review versions; readback drift cannot complete verification', async t => {
  const { w, runtime, options, service, bindings, example } = await packageFixture(t);
  const skills = createWorkspaceSkills(runtime);
  const pkg = await example('leave-management');
  const skill = pkg.resources.find(resource => resource.kind === 'skill');
  skill.requestedState = 'saved';
  pkg.resources = [skill, { ...structuredClone(skill), key: 'second-procedure' }];
  pkg.inputs = pkg.inputs.filter(input => ['owning-team', 'package-manager'].includes(input.key));
  pkg.outputs = [];
  pkg.requires.capabilities = ['skills'];
  const input = { requestId: randomUUID(), package: pkg, bindings };
  const [created, concurrentReplay] = await Promise.all([
    service.create(w.id, w.userId, input),
    service.create(w.id, w.userId, input),
  ]);
  assert.deepEqual(created, concurrentReplay);
  let view = created;
  const identities = view.nodes.map(node => node.resourceId);
  assert.deepEqual(await service.create(w.id, w.userId, input), view);
  await assert.rejects(
    service.create(w.id, w.userId, {
      ...input,
      package: { ...pkg, package: { ...pkg.package, title: 'Different intent' } },
    }),
    /idempotency-conflict/,
  );
  view = await service.resume(w.id, w.userId, view.id, { expectedVersion: view.version });
  assert.equal(view.nodes[0].state, 'waiting-review');
  await assert.rejects(skills.read(w.id, w.userId, view.nodes[0].resourceId));
  await assert.rejects(
    service.resume(w.id, w.userId, view.id, { expectedVersion: 0 }),
    /installation-version-conflict/,
  );
  const review = {
    requestId: randomUUID(),
    expectedVersion: view.version,
    key: view.nodes[0].key,
    digest: view.nodes[0].review.digest,
    decision: 'approve',
  };
  await assert.rejects(
    service.review(w.id, w.userId, view.id, { ...review, digest: '0'.repeat(64) }),
    /review-digest-conflict/,
  );
  await assert.rejects(service.review(w.id, w.userId, view.id, { ...review, key: '$verify' }));
  view = await service.review(w.id, w.userId, view.id, review);
  assert.deepEqual(await service.review(w.id, w.userId, view.id, review), view);
  await assert.rejects(
    service.review(w.id, w.userId, view.id, { ...review, decision: 'reject' }),
    /review-idempotency-conflict/,
  );
  view = await service.resume(w.id, w.userId, view.id, { expectedVersion: view.version });
  assert.equal(view.nodes[0].state, 'completed');
  assert.equal(view.nodes[1].state, 'waiting-review');
  assert.deepEqual(
    view.nodes.map(node => node.resourceId),
    identities,
  );
  assert.deepEqual(await createSystemPackages(options).read(w.id, w.userId, view.id), view);
  const saved = await skills.read(w.id, w.userId, view.nodes[0].resourceId);
  const sharing = await skills.sharing(w.id, w.userId, saved.id);
  assert.deepEqual(sharing.personGrants, [{ membershipId: w.membershipId, permissions: ['manage', 'read', 'use'] }]);
  assert.deepEqual(sharing.grants, [{ teamId: bindings['owning-team'].id, permissions: ['read', 'use'] }]);
  await skills.save(w.id, w.userId, saved.id, {
    requestId: randomUUID(),
    expectedVersion: saved.management.version,
    definition: {
      name: saved.definition.name,
      description: 'Changed by its owner after installation.',
      instructions: 'These are different instructions.',
    },
  });
  view = await service.review(w.id, w.userId, view.id, {
    requestId: randomUUID(),
    expectedVersion: view.version,
    key: view.nodes[1].key,
    digest: view.nodes[1].review.digest,
    decision: 'approve',
  });
  view = await service.resume(w.id, w.userId, view.id, { expectedVersion: view.version });
  assert.equal(view.nodes[1].state, 'completed');
  assert.equal(view.status, 'blocked');
  assert.equal(view.nodes.at(-1).kind, 'verify');
  assert.equal(view.nodes.at(-1).state, 'blocked');
  assert.match(view.nodes.at(-1).error, /^verification-drift:/);
  assert.deepEqual(
    view.nodes.map(node => node.resourceId),
    identities,
  );
  view = await service.resume(w.id, w.userId, view.id, { expectedVersion: view.version });
  assert.equal(view.status, 'blocked');
  assert.equal(view.nodes.at(-1).state, 'blocked');
  const freshInput = { ...input, requestId: randomUUID(), package: { ...pkg, resources: [skill] } };
  let fresh = await service.create(w.id, w.userId, freshInput);
  assert.notEqual(fresh.nodes[0].resourceId, identities[0]);
  fresh = await service.resume(w.id, w.userId, fresh.id, { expectedVersion: fresh.version });
  fresh = await service.review(w.id, w.userId, fresh.id, {
    requestId: randomUUID(),
    expectedVersion: fresh.version,
    key: fresh.nodes[0].key,
    digest: fresh.nodes[0].review.digest,
    decision: 'approve',
  });
  fresh = await service.resume(w.id, w.userId, fresh.id, { expectedVersion: fresh.version });
  assert.equal(fresh.status, 'completed');
  assert.equal(fresh.nodes.at(-1).state, 'completed');
  assert.deepEqual(await service.resume(w.id, w.userId, fresh.id, { expectedVersion: fresh.version }), fresh);
  assert.deepEqual(await createSystemPackages(options).read(w.id, w.userId, fresh.id), fresh);
});

test('expired and confirmed-stale unapplied proposals require new reviews without changing identities or losing decisions', async t => {
  const f = await packageFixture(t);
  const pkg = await f.example('leave-management');
  pkg.resources = [
    pkg.resources.find(
      resource => resource.kind === 'table' && resource.fields.every(field => field.kind !== 'relationship'),
    ),
  ];
  pkg.inputs = pkg.inputs.filter(input => input.key === 'owning-team');
  pkg.outputs = [];
  pkg.assets = [];
  pkg.requires.capabilities = ['tables'];
  const bindings = { 'owning-team': f.bindings['owning-team'] };
  let view = await f.service.create(f.w.id, f.w.userId, { requestId: randomUUID(), package: pkg, bindings });
  view = await f.resume(view);
  const initial = structuredClone(view.nodes[0]);
  const originalDigest = view.inputDigest;
  const first = await f.prepared(view, initial);
  const firstReview = {
    requestId: randomUUID(),
    expectedVersion: view.version,
    key: initial.key,
    digest: initial.review.digest,
    decision: 'approve',
  };
  view = await f.service.review(f.w.id, f.w.userId, view.id, firstReview);
  await f.db.platform.query(
    `UPDATE ${f.schema}.tf_table_proposals SET created_at=statement_timestamp()-interval '2 seconds',expires_at=statement_timestamp()-interval '1 second' WHERE id=$1`,
    [first.receipt.id],
  );
  view = await f.resume(view);
  assert.equal(view.nodes[0].state, 'waiting-review');
  assert.equal(view.nodes[0].attempt, 1);
  assert.equal(view.nodes[0].resourceId, initial.resourceId);
  assert.equal(view.inputDigest, originalDigest);
  assert.notEqual(view.nodes[0].review.digest, initial.review.digest);
  await assert.rejects(f.service.review(f.w.id, f.w.userId, view.id, firstReview), /review-digest-conflict/);
  await assert.rejects(
    f.service.review(f.w.id, f.w.userId, view.id, {
      ...firstReview,
      expectedVersion: view.version,
      digest: view.nodes[0].review.digest,
    }),
    /review-idempotency-conflict/,
  );
  const second = await f.prepared(view, view.nodes[0]);
  assert.notEqual(second.command_id, first.command_id);
  assert.notEqual(second.receipt.id, first.receipt.id);
  const digest = view.nodes[0].review.digest;
  view = await f.resume(view);
  assert.equal(view.nodes[0].attempt, 1);
  assert.equal(view.nodes[0].review.digest, digest);
  view = await f.approve(view);
  view = await f.resume(view);
  assert.equal(view.nodes[0].state, 'running');

  // Persist the native worker's confirmed-unapplied stale outcome; no publication or generation exists.
  const failedExecution = randomUUID();
  await f.db.platform.query(
    `INSERT INTO ${f.schema}.tf_table_executions(proposal_id,table_id,id,publication_id,phase,error_code) VALUES($1,$2,$3,$4,'blocked','proposal-stale')`,
    [second.receipt.id, initial.resourceId, failedExecution, randomUUID()],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.schema}.tf_table_proposal_receipts(proposal_id,table_id,attempt,receipt) VALUES($1,$2,0,$3)`,
    [second.receipt.id, initial.resourceId, { status: 'failed', executionId: failedExecution, code: 'proposal-stale' }],
  );
  view = await f.resume(view);
  assert.equal(view.nodes[0].state, 'waiting-review');
  assert.equal(view.nodes[0].attempt, 2);
  assert.equal(view.nodes[0].resourceId, initial.resourceId);
  assert.notEqual(view.nodes[0].review.digest, digest);
  assert.equal(view.inputDigest, originalDigest);
  const third = await f.prepared(view, view.nodes[0]);
  assert.equal(new Set([first.command_id, second.command_id, third.command_id]).size, 3);
  assert.deepEqual(
    (
      await f.db.platform.query(
        `SELECT attempt,digest,decision FROM ${f.schema}.tf_system_package_reviews WHERE installation_id=$1 ORDER BY attempt`,
        [view.id],
      )
    ).rows,
    [
      { attempt: 0, digest: initial.review.digest, decision: 'approve' },
      { attempt: 1, digest, decision: 'approve' },
    ],
  );
  assert.equal(
    (
      await f.db.platform.query(
        `SELECT count(*)::int AS count FROM ${f.schema}.tf_table_proposal_controls WHERE proposal_id=ANY($1::uuid[]) AND operation='cancel'`,
        [[first.receipt.id, second.receipt.id]],
      )
    ).rows[0].count,
    2,
  );

  // An expired dispatch with no terminal receipt is unknown, not permission to refresh.
  view = await f.approve(view);
  view = await f.resume(view);
  await f.db.platform.query(
    `INSERT INTO ${f.schema}.tf_table_executions(proposal_id,table_id,id,publication_id,phase) VALUES($1,$2,$3,$4,'publishing')`,
    [third.receipt.id, initial.resourceId, randomUUID(), randomUUID()],
  );
  await f.db.platform.query(
    `UPDATE ${f.schema}.tf_table_proposals SET created_at=statement_timestamp()-interval '2 seconds',expires_at=statement_timestamp()-interval '1 second' WHERE id=$1`,
    [third.receipt.id],
  );
  view = await f.resume(view);
  assert.equal(view.nodes[0].state, 'blocked');
  assert.equal(view.nodes[0].error, 'table-recovery-outcome-unknown');
  assert.equal(view.nodes[0].attempt, 2);
  assert.equal(view.nodes[0].resourceId, initial.resourceId);
  view = await f.resume(view);
  assert.equal(view.nodes[0].attempt, 2);
  assert.equal(view.nodes.at(-1).state, 'pending');
  assert.deepEqual(await createSystemPackages(f.options).read(f.w.id, f.w.userId, view.id), view);
});

test('a reconciled SCC shell stays saved and blocks administrator row writes until the full schema is applied', async t => {
  const f = await packageFixture(t);
  const pkg = await f.example('linked-records');
  pkg.resources = pkg.resources.filter(resource => resource.kind === 'table');
  pkg.outputs = [];
  pkg.assets = [];
  pkg.requires.capabilities = ['tables'];
  const bindings = { 'owning-team': f.bindings['owning-team'] };
  let view = await f.service.create(f.w.id, f.w.userId, { requestId: randomUUID(), package: pkg, bindings });
  view = await f.resume(view);
  const node = view.nodes.find(node => node.state === 'waiting-review');
  assert.ok(node.definition.fields.every(field => field.kind !== 'relationship'));
  assert.match(node.review.description, /empty shell/);
  const prepared = await f.prepared(view, node);
  const compiler = packageCompiler(pkg, bindings, view.id);
  const definition = compiler.definition(node.definition);
  const revision = 'a'.repeat(40);
  view = await f.approve(view, node);
  view = await f.resume(view);
  assert.equal(view.nodes.find(item => item.key === node.key).state, 'running');

  const migration = await connect(f.db.login(f.w, 'migration'));
  try {
    // Use the native DDL/cutover functions, then persist the worker receipt for installer reconciliation.
    await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${f.w.names.customOwner}"`);
      const tx = { client, schema: f.w.names.schema };
      const generation = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      await client.query(
        `UPDATE ${f.schema}.tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
        [definition.id, revision, definition, generation.physical_table],
      );
    });
  } finally {
    await migration.end();
  }
  await f.db.platform.query(
    `INSERT INTO ${f.schema}.tf_table_proposal_receipts(proposal_id,table_id,attempt,receipt) VALUES($1,$2,0,$3)`,
    [prepared.receipt.id, definition.id, { status: 'completed', executionId: randomUUID(), revision }],
  );
  view = await f.resume(view);
  const shell = view.nodes.find(item => item.key === node.key);
  assert.equal(shell.state, 'saved');
  assert.equal(shell.attempt, 1);
  assert.equal(shell.resourceId, node.resourceId);
  assert.equal(shell.review, null);
  assert.equal(view.nodes.at(-1).state, 'pending');
  assert.ok(view.nodes.some(item => item.key !== node.key && item.state === 'waiting-review'));

  const actor = { kind: 'human', userId: f.w.userId, membershipId: f.w.membershipId };
  await f.runtime.transaction(f.w.id, commonCompatibility, async tx => {
    assert.equal(await canAccessTable(tx, actor, definition.id, 'table.row.read'), true);
    for (const permission of ['table.row.create', 'table.row.update', 'table.row.delete'])
      assert.equal(await canAccessTable(tx, actor, definition.id, permission), false, permission);
  });
  const tables = createTableService(f.runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  await assert.rejects(
    tables.mutate(f.w.id, f.w.userId, {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: randomUUID(),
      values: { [compiler.fieldId(node.key, 'title')]: { kind: 'text', value: 'Must not be inserted' } },
    }),
    AccessDenied,
  );
  assert.deepEqual(await tables.list(f.w.id, f.w.userId, { tableId: definition.id, revision, limit: 10 }), []);
  const again = await f.resume(view);
  assert.equal(again.nodes.find(item => item.key === node.key).state, 'saved');
  assert.equal(again.nodes.find(item => item.key === node.key).attempt, 1);
});
