import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { definitionSchema } from '@tulipfarm/tables/definition';
import { initializeSoul } from '../src/soul.ts';
import { prepareSoulRevision, readVerifiedProjection, verifySoulRevision } from '../src/soul-revisions.ts';

const execute = promisify(execFile);
const seed = {
  workspaceId: 'a9fc9f32-8787-4b81-9962-c834e2a8fe51',
  createdBy: 'a6b75a33-4245-432b-a615-4d5fa9aa646a',
  createdAt: '2026-09-27T12:00:00.000Z',
};
const tableId = 'fd4db608-e82d-43d4-8e6a-161ac977d1fe';
const fieldId = 'be2d0d19-27ba-4230-b65b-8755e0e669c7';
const owningTeamId = '3f6ad5b6-8f4b-4bd5-8b0d-6bb1a4bf2d41';
const resource = definitionSchema.parse({
  formatVersion: 2,
  id: tableId,
  owningTeamId,
  label: 'Invoices',
  fields: [{ id: fieldId, label: 'Total', kind: 'text', required: false, maxLength: 1000 }],
  uniqueKeys: [],
});
function change(parent, definition = resource, kind = 'table') {
  return {
    commandId: randomUUID(),
    expectedParentCommit: parent.commit,
    createdAt: '2026-09-27T12:01:00.000Z',
    kind,
    definition,
  };
}

async function storageFixture(t) {
  const objects = new Map();
  const writes = new Map();
  const reads = [];
  const faults = { loseAcknowledgement: false, rejectProjection: false };
  const server = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/soul-test\//, '');
    if (request.method === 'GET') {
      reads.push(key);
      const stored = objects.get(key);
      if (!stored) {
        response.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, {
        'content-length': stored.body.length,
        'x-amz-meta-sha256': stored.sha256,
        ...(stored.commandSha256 ? { 'x-amz-meta-command-sha256': stored.commandSha256 } : {}),
      });
      response.end(stored.body);
      return;
    }
    if (request.method === 'PUT') {
      assert.equal(request.headers['if-none-match'], '*');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (faults.rejectProjection && key.includes('/projections/')) {
        response
          .writeHead(503, { 'content-type': 'application/xml' })
          .end('<Error><Code>ServiceUnavailable</Code></Error>');
        return;
      }
      if (objects.has(key)) {
        response
          .writeHead(412, { 'content-type': 'application/xml' })
          .end('<Error><Code>PreconditionFailed</Code></Error>');
        return;
      }
      objects.set(key, {
        body: Buffer.concat(chunks),
        sha256: request.headers['x-amz-meta-sha256'],
        commandSha256: request.headers['x-amz-meta-command-sha256'],
      });
      writes.set(key, (writes.get(key) ?? 0) + 1);
      if (faults.loseAcknowledgement) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200).end();
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new S3Client({
    region: 'auto',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  t.after(async () => {
    client.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const storage = { client, bucket: 'soul-test' };
  const parent = await initializeSoul(storage, seed);
  return { storage, parent, objects, writes, reads, faults };
}

test('complete resource definitions survive immutable publication and verified Git restoration', async t => {
  const { storage, parent } = await storageFixture(t);
  const definition = {
    formatVersion: 2,
    id: tableId,
    owningTeamId: randomUUID(),
    label: 'Tickets',
    fields: [{ id: fieldId, label: 'Subject', kind: 'text', required: true, maxLength: 1000 }],
    uniqueKeys: [],
  };
  const command = change(parent, definition);
  const published = await prepareSoulRevision(storage, seed, parent, command);
  assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, published.projection), definition);
  assert.deepEqual(
    (await verifySoulRevision(storage, seed, published.bundle, published.projection)).definition,
    definition,
  );
  assert.deepEqual(await prepareSoulRevision(storage, seed, parent, command), published);
});

test('named Unicode table paths match public IDs and keep the original Git history', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  const definition = { ...resource, label: 'Café 東京' };
  const legacy = await prepareSoulRevision(storage, seed, parent, change(parent, definition));
  const command = {
    ...change(legacy.bundle, definition),
    tableNames: { [tableId]: 'café_東京' },
    previousSha256: legacy.projection.sha256,
  };
  await assert.rejects(
    prepareSoulRevision(storage, seed, legacy.bundle, { ...command, definition: { ...definition, label: 'Changed' } }),
    /changes the saved definition/,
  );
  const named = await prepareSoulRevision(storage, seed, legacy.bundle, command);
  assert.equal(named.projection.path, 'tables/café_東京.json');
  const document = JSON.parse(objects.get(named.projection.key).body);
  assert.equal(document.id, 'café_東京');
  assert.equal(document.formatVersion, 3);
  assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, named.projection), definition);
  assert.deepEqual(await prepareSoulRevision(storage, seed, legacy.bundle, command), named);
  await assert.rejects(
    readVerifiedProjection(storage, seed.workspaceId, { ...named.projection, tableNames: { [tableId]: 'different' } }),
    /outside the selected definition/,
  );
  const directory = await mkdtemp(join(tmpdir(), 'soul-named-history-'));
  try {
    await writeFile(join(directory, 'soul.bundle'), objects.get(named.bundle.key).body);
    await execute('git', ['clone', '--bare', 'soul.bundle', 'repository'], { cwd: directory });
    const cwd = join(directory, 'repository');
    await execute('git', ['merge-base', '--is-ancestor', legacy.commit, named.commit], { cwd });
    assert.deepEqual(
      JSON.parse((await execute('git', ['show', `${legacy.commit}:tables/${tableId}.json`], { cwd })).stdout),
      definition,
    );
    const paths = (await execute('git', ['ls-tree', '-r', '-z', '--name-only', named.commit], { cwd })).stdout.split(
      '\0',
    );
    assert.ok(paths.includes('tables/café_東京.json'));
    assert.ok(!paths.includes(`tables/${tableId}.json`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resource and agent revisions restore full Git history and immutable per-file definitions', async t => {
  const { storage, parent, objects, writes, reads } = await storageFixture(t);
  const initial = Buffer.from(objects.get(parent.key).body);
  const first = await prepareSoulRevision(storage, seed, parent, change(parent));
  assert.equal(first.parentCommit, parent.commit);
  assert.equal(first.projection.path, `tables/${tableId}.json`);
  assert.equal(first.bundle.key, `workspaces/${seed.workspaceId}/soul/revisions/${first.commandId}.bundle`);
  assert.equal(first.projection.key, `workspaces/${seed.workspaceId}/soul/projections/${first.projection.sha256}.json`);
  reads.length = 0;
  assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, first.projection), resource);
  assert.deepEqual(reads, [first.projection.key]);
  const agent = { formatVersion: 1, id: randomUUID(), name: 'Accountant', instructions: 'Summarize invoices.' };
  const second = await prepareSoulRevision(storage, seed, first.bundle, change(first.bundle, agent, 'agent'));
  assert.deepEqual((await verifySoulRevision(storage, seed, second.bundle, second.projection)).definition, agent);
  assert.deepEqual((await verifySoulRevision(storage, seed, first.bundle, first.projection)).definition, resource);
  const directory = await mkdtemp(join(tmpdir(), 'soul-revision-test-'));
  try {
    await writeFile(join(directory, 'soul.bundle'), objects.get(second.bundle.key).body);
    await execute('git', ['clone', '--branch', 'main', 'soul.bundle', 'restored'], { cwd: directory });
    const repository = join(directory, 'restored');
    await execute('git', ['fsck', '--full', '--strict'], { cwd: repository });
    assert.deepEqual(JSON.parse(await readFile(join(repository, first.projection.path), 'utf8')), resource);
    assert.deepEqual(JSON.parse(await readFile(join(repository, second.projection.path), 'utf8')), agent);
    assert.deepEqual((await execute('git', ['rev-list', 'HEAD'], { cwd: repository })).stdout.trim().split('\n'), [
      second.commit,
      first.commit,
      parent.commit,
    ]);
    const changed = (
      await execute('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: repository })
    ).stdout.trim();
    assert.equal(changed, second.projection.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(objects.get(parent.key).body, initial);
  assert.equal(writes.get(parent.key), 1);
});

test('lost bundle and projection acknowledgements recover in-call and concurrent replay writes once', async t => {
  const { storage, parent, writes, faults } = await storageFixture(t);
  const command = change(parent);
  faults.loseAcknowledgement = true;
  const first = await prepareSoulRevision(storage, seed, parent, command);
  const results = await Promise.all([
    prepareSoulRevision(storage, seed, parent, command),
    prepareSoulRevision(storage, seed, parent, command),
  ]);
  assert.deepEqual(results, [first, first]);
  assert.equal(writes.get(first.bundle.key), 1);
  assert.equal(writes.get(first.projection.key), 1);
  await assert.rejects(
    prepareSoulRevision(storage, seed, parent, { ...command, definition: { ...resource, label: 'Other' } }),
    /checksum/,
  );
  assert.equal(writes.get(first.bundle.key), 1);
});

test('adding a model family preserves old agent bytes and creates a new Git revision', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  const agent = {
    formatVersion: 1,
    id: randomUUID(),
    name: 'Reader',
    instructions: 'Read invoices.',
    tools: ['rows.list'],
  };
  const first = await prepareSoulRevision(storage, seed, parent, change(parent, agent, 'agent'));
  const oldBundle = Buffer.from(objects.get(first.bundle.key).body);
  const oldProjection = Buffer.from(objects.get(first.projection.key).body);
  const selected = { ...agent, modelFamilyId: 'claude-opus' };
  const edit = change(first.bundle, selected, 'agent');
  const second = await prepareSoulRevision(storage, seed, first.bundle, edit);
  assert.notEqual(second.commit, first.commit);
  assert.notEqual(second.projection.sha256, first.projection.sha256);
  assert.deepEqual(await prepareSoulRevision(storage, seed, first.bundle, edit), second);
  assert.deepEqual((await verifySoulRevision(storage, seed, second.bundle, second.projection)).definition, selected);
  assert.deepEqual((await verifySoulRevision(storage, seed, first.bundle, first.projection)).definition, agent);
  assert.equal(
    second.projection.sha256,
    createHash('sha256')
      .update(`${JSON.stringify(selected, null, 2)}\n`)
      .digest('hex'),
  );
  assert.deepEqual(objects.get(first.bundle.key).body, oldBundle);
  assert.deepEqual(objects.get(first.projection.key).body, oldProjection);
});

test('projection upload failure can resume from the immutable bundle without accepting or replacing it', async t => {
  const { storage, parent, objects, writes, faults } = await storageFixture(t);
  const command = change(parent);
  faults.rejectProjection = true;
  await assert.rejects(prepareSoulRevision(storage, seed, parent, command));
  assert.equal(objects.size, 2);
  faults.rejectProjection = false;
  const revision = await prepareSoulRevision(storage, seed, parent, command);
  assert.equal(writes.get(revision.bundle.key), 1);
  assert.equal(writes.get(revision.projection.key), 1);
  assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, revision.projection), resource);
});

test('one command UUID has one identity across letter case and timestamp precision', async t => {
  const { storage, parent, writes } = await storageFixture(t);
  const command = {
    ...change(parent),
    commandId: 'fd4db608-e82d-43d4-8e6a-161ac977d1fe',
    createdAt: '2026-09-27T12:01:00.001Z',
  };
  const first = await prepareSoulRevision(storage, seed, parent, command);
  const upper = { ...command, commandId: command.commandId.toUpperCase() };
  assert.deepEqual(await prepareSoulRevision(storage, seed, parent, upper), first);
  await assert.rejects(
    prepareSoulRevision(storage, seed, parent, {
      ...upper,
      definition: { ...resource, label: 'Conflicting' },
    }),
    /checksum|metadata/,
  );
  for (const createdAt of ['2026-09-27T12:01:00.999Z', '2026-09-27T12:01:00.0010Z', '2026-09-27T12:01:01.001Z']) {
    await assert.rejects(prepareSoulRevision(storage, seed, parent, { ...command, createdAt }), /checksum|metadata/);
  }
  assert.equal(writes.size, 3);
  assert.deepEqual(await prepareSoulRevision(storage, seed, parent, command), first);
});

test('workspace, creator, resource, field and agent UUID casing preserves paths and replay identity', async t => {
  const { storage, parent, writes } = await storageFixture(t);
  const upperSeed = { ...seed, workspaceId: seed.workspaceId.toUpperCase(), createdBy: seed.createdBy.toUpperCase() };
  assert.deepEqual(await initializeSoul(storage, upperSeed), parent);
  const command = change(parent);
  const first = await prepareSoulRevision(storage, seed, parent, command);
  const upperTable = {
    ...resource,
    id: resource.id.toUpperCase(),
    owningTeamId: owningTeamId.toUpperCase(),
    fields: resource.fields.map(field => ({ ...field, id: field.id.toUpperCase() })),
  };
  assert.deepEqual(
    await prepareSoulRevision(storage, upperSeed, parent, { ...command, definition: upperTable }),
    first,
  );
  assert.deepEqual(
    await readVerifiedProjection(storage, upperSeed.workspaceId, {
      ...first.projection,
      workspaceId: upperSeed.workspaceId,
      id: resource.id.toUpperCase(),
    }),
    resource,
  );
  const agent = {
    formatVersion: 1,
    id: 'be2d0d19-27ba-4230-b65b-8755e0e669c7',
    name: 'Accountant',
    instructions: 'Summarize.',
  };
  const agentCommand = change(first.bundle, agent, 'agent');
  const second = await prepareSoulRevision(storage, seed, first.bundle, agentCommand);
  assert.deepEqual(
    await prepareSoulRevision(storage, upperSeed, first.bundle, {
      ...agentCommand,
      definition: { ...agent, id: agent.id.toUpperCase() },
    }),
    second,
  );
  assert.equal(second.projection.path, `agents/${agent.id}.json`);
  assert.equal(writes.size, 5);
});

test('command payload digest is stored, verified on replay and bound into the Git commit', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  const command = change(parent);
  const first = await prepareSoulRevision(storage, seed, parent, command);
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        seed,
        change: {
          kind: command.kind,
          commandId: command.commandId,
          expectedParentCommit: command.expectedParentCommit,
          createdAt: command.createdAt,
          definition: command.definition,
        },
      }),
    )
    .digest('hex');
  assert.equal(first.commandSha256, expected);
  assert.equal(first.bundle.commandSha256, expected);
  const object = objects.get(first.bundle.key);
  assert.equal(object.commandSha256, expected);
  delete object.commandSha256;
  await assert.rejects(prepareSoulRevision(storage, seed, parent, command), /metadata/);
  await assert.rejects(verifySoulRevision(storage, seed, first.bundle), /metadata/);
  object.commandSha256 = '0'.repeat(64);
  await assert.rejects(
    verifySoulRevision(storage, seed, { ...first.bundle, commandSha256: object.commandSha256 }),
    /digest does not match Git/,
  );
  object.commandSha256 = expected;
  assert.deepEqual(await prepareSoulRevision(storage, seed, parent, command), first);
});

test('different commands against one parent produce independent candidates and content-addressed projection reuse', async t => {
  const { storage, parent, writes } = await storageFixture(t);
  const [first, second] = await Promise.all([
    prepareSoulRevision(storage, seed, parent, change(parent)),
    prepareSoulRevision(storage, seed, parent, change(parent)),
  ]);
  assert.notEqual(first.commit, second.commit);
  assert.notEqual(first.bundle.key, second.bundle.key);
  assert.equal(first.projection.key, second.projection.key);
  assert.equal(writes.get(first.projection.key), 1);
  assert.equal(first.parentCommit, second.parentCommit);
});

test('resource history restores each published definition from Git', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  let pointer = parent;
  const definitions = [
    resource,
    { ...resource, fields: [{ ...resource.fields[0], required: true }] },
    { ...resource, label: 'Bills', fields: [{ ...resource.fields[0], required: true, maxLength: 50 }] },
  ];
  const revisions = [];
  for (const document of definitions) {
    const prepared = await prepareSoulRevision(storage, seed, pointer, change(pointer, document));
    assert.deepEqual(await readVerifiedProjection(storage, seed.workspaceId, prepared.projection), document);
    assert.deepEqual(
      (await verifySoulRevision(storage, seed, prepared.bundle, prepared.projection)).definition,
      document,
    );
    revisions.push(prepared);
    pointer = prepared.bundle;
  }
  const directory = await mkdtemp(join(tmpdir(), 'soul-history-test-'));
  try {
    await writeFile(join(directory, 'soul.bundle'), objects.get(pointer.key).body);
    await execute('git', ['clone', '--bare', '--branch', 'main', 'soul.bundle', 'restored'], { cwd: directory });
    const repository = join(directory, 'restored');
    for (const [index, revision] of revisions.entries()) {
      const restored = (
        await execute('git', ['show', `${revision.commit}:tables/${tableId}.json`], { cwd: repository })
      ).stdout;
      assert.deepEqual(JSON.parse(restored), definitions[index]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects arbitrary paths, records, multiple definitions, relationships, duplicate field IDs and unsupported formats before storage IO', async t => {
  const { storage, parent, reads, writes } = await storageFixture(t);
  const command = change(parent);
  const invalid = [
    { ...command, path: '../../soul.json' },
    { ...command, definition: { ...resource, records: [{ total: 10 }] } },
    { ...command, definitions: [resource, resource] },
    { ...command, definition: { ...resource, formatVersion: 1 } },
    { ...command, definition: { ...resource, fields: [...resource.fields, resource.fields[0]] } },
    { ...command, definition: { ...resource, id: '../soul' } },
    { ...command, commandId: '../initial' },
    { ...command, definition: { formatVersion: 1, id: tableId, name: 'Invoices', fields: [] } },
  ];
  reads.length = 0;
  for (const input of invalid) await assert.rejects(prepareSoulRevision(storage, seed, parent, input));
  assert.deepEqual(reads, []);
  assert.equal(writes.size, 1);
});

test('wrong parent commit, workspace identity, bucket and key fail before preparing a revision', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  const command = change(parent);
  await assert.rejects(
    prepareSoulRevision(storage, seed, parent, { ...command, expectedParentCommit: '0'.repeat(40) }),
    /parent commit/,
  );
  await assert.rejects(
    prepareSoulRevision(
      storage,
      seed,
      { ...parent, commit: '0'.repeat(40) },
      { ...command, expectedParentCommit: '0'.repeat(40) },
    ),
    /parent commit/,
  );
  await assert.rejects(
    prepareSoulRevision(storage, { ...seed, createdBy: randomUUID() }, parent, command),
    /different workspace/,
  );
  await assert.rejects(
    prepareSoulRevision(storage, { ...seed, workspaceId: randomUUID() }, parent, command),
    /outside/,
  );
  await assert.rejects(prepareSoulRevision(storage, seed, { ...parent, bucket: 'another' }, command), /outside/);
  await assert.rejects(
    prepareSoulRevision(storage, seed, { ...parent, key: `${parent.key}/../other.bundle` }, command),
    /outside/,
  );
  assert.equal(objects.size, 1);
});

test('corrupt bundles and altered projections fail digest, Git, identity and selected revision verification', async t => {
  const { storage, parent, objects } = await storageFixture(t);
  const revision = await prepareSoulRevision(storage, seed, parent, change(parent));
  const object = objects.get(revision.projection.key);
  const original = { ...object };
  object.body = Buffer.from('{"records":[]}');
  await assert.rejects(readVerifiedProjection(storage, seed.workspaceId, revision.projection), /checksum/);
  object.sha256 = createHash('sha256').update(object.body).digest('hex');
  await assert.rejects(readVerifiedProjection(storage, seed.workspaceId, revision.projection), /checksum/);
  Object.assign(object, original);
  await assert.rejects(readVerifiedProjection(storage, randomUUID(), revision.projection), /outside/);
  await assert.rejects(
    readVerifiedProjection(storage, seed.workspaceId, { ...revision.projection, path: 'soul.json' }),
    /outside/,
  );
  await assert.rejects(
    readVerifiedProjection(storage, seed.workspaceId, {
      ...revision.projection,
      id: randomUUID(),
      path: `tables/${randomUUID()}.json`,
    }),
    /outside/,
  );
  await assert.rejects(
    verifySoulRevision(storage, seed, revision.bundle, { ...revision.projection, commit: parent.commit }),
    /revision mismatch/,
  );
  const replacement = await prepareSoulRevision(
    storage,
    seed,
    revision.bundle,
    change(revision.bundle, { ...resource, label: 'Changed' }),
  );
  await assert.rejects(
    verifySoulRevision(storage, seed, revision.bundle, { ...replacement.projection, commit: revision.commit }),
    /does not match Git/,
  );
  const bundle = objects.get(revision.bundle.key);
  bundle.body = Buffer.from('not a Git bundle');
  bundle.sha256 = createHash('sha256').update(bundle.body).digest('hex');
  await assert.rejects(verifySoulRevision(storage, seed, revision.bundle), /checksum/);
  await assert.rejects(verifySoulRevision(storage, seed, { ...revision.bundle, sha256: bundle.sha256 }), /git/);
});
