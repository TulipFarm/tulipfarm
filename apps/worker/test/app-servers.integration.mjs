import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  admitPublish,
  admitResize,
  admitRollback,
  createApp,
  readApp,
  readAppRuntime,
  readBuild,
  readDraftHost,
  readOperation,
  recordAppEndpoint,
  requestBuild,
  requestDraftHost,
} from '@tulipfarm/apps/store';
import { AppHostConflictError, unavailableAppHost } from '@tulipfarm/extensions';
import {
  connect,
  fixture,
  loadPlatformBaseline,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createAppActivities } from '../src/app-activities.ts';
import { authoringPlatform } from './authoring-platform.mjs';
import { createAppServerActivities } from '../src/app-server-activities.ts';
import { captureMetrics } from './metric-capture.mjs';

const recipe = { kind: 'server', runtime: 'node26', serve: { port: 8080, start: 'node server.js' } };

function memoryObjects() {
  const objects = new Map();
  return {
    objects,
    async has(key) {
      return objects.has(key);
    },
    async put(key, body, file) {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      objects.set(key, { content: Buffer.concat(chunks), ...file });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: (async function* () {
          yield object.content;
        })(),
        contentType: object.contentType,
        bytes: object.bytes,
      };
    },
  };
}

/**
 * Hosts named by release, or by draft build and generation, and size, and one endpoint per app whose generation grows by one at each
 * switch.
 */
function memoryHost() {
  const hosts = new Map();
  const endpoints = new Map();
  return {
    hosts,
    endpoints,
    async provision({ appId, size, output, ...runs }) {
      const hostRef =
        'releaseId' in runs
          ? `host-${runs.releaseId.slice(0, 8)}-${size.vcpu}x${size.memMiB}`
          : `draft-${runs.draftBuildId.slice(0, 8)}-g${runs.draftGeneration}-${size.vcpu}x${size.memMiB}`;
      hosts.set(hostRef, { appId, artifact: output.artifact, size, draftBuildId: runs.draftBuildId });
      return { hostRef };
    },
    async switch({ appId, hostRef, expectedGeneration }) {
      if (!hosts.has(hostRef)) throw new Error(`No host ${hostRef}`);
      const generation = endpoints.get(appId)?.generation ?? 0;
      if (expectedGeneration !== undefined && expectedGeneration !== generation)
        throw new AppHostConflictError(appId, expectedGeneration);
      endpoints.set(appId, { hostRef, generation: generation + 1 });
      return { generation: generation + 1 };
    },
    async connect() {
      throw new Error('Not used');
    },
    async remove({ hostRef }) {
      hosts.delete(hostRef);
    },
    async *list() {
      for (const [hostRef, { appId }] of hosts) yield { appId, hostRef };
    },
  };
}

/** Migrates the platform and returns the worker's authoring login onto it. */
async function migrate(db) {
  await loadPlatformBaseline(db.platform);
  for (const migration of ['0011_app_hostnames.sql', '0015_app_server_owners.sql'])
    await db.platform.query(await readFile(new URL(`../../database/migrations/${migration}`, import.meta.url), 'utf8'));
  return authoringPlatform(db);
}

function commit(directory, files) {
  const git = args =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  return Promise.all(Object.entries(files).map(([path, content]) => writeFile(join(directory, path), content))).then(
    () => {
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'Server']);
      return git(['rev-parse', 'HEAD']);
    },
  );
}

test('server apps publish, roll back, resize and reconcile against an app host', { timeout: 120000 }, async t => {
  const telemetry = captureMetrics(t);
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-servers-'));
  let runtime;
  let worker;
  t.after(async () => {
    await runtime?.end();
    await worker?.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  worker = await migrate(db);
  const workspace = await db.create();
  const schema = workspace.names.schema;
  runtime = await connect(db.login(workspace));
  const transact = async action => {
    await runtime.query('BEGIN');
    try {
      const result = await action({ client: runtime, schema });
      await runtime.query('COMMIT');
      return result;
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  const builder = {
    id: 'sandbox-node26-v1',
    async build() {
      throw new Error('Not used');
    },
    async buildServer(input) {
      return {
        ok: true,
        output: { kind: 'server', artifact: `image-${input.buildId.slice(0, 8)}`, port: 8080, start: 'node server.js' },
        log: '',
        units: 0n,
      };
    },
  };
  const host = memoryHost();
  let databaseDown = false;
  let afterNextTransaction;
  const options = appHost => ({
    transact: async (workspaceId, action) => {
      assert.equal(workspaceId, workspace.id);
      if (databaseDown) throw new Error('The database is unavailable');
      const result = await transact(action);
      const after = afterNextTransaction;
      afterNextTransaction = undefined;
      await after?.();
      return result;
    },
    platform: worker.client,
    objects: memoryObjects(),
    source: async () => root,
    publisher: undefined,
    builder,
    host: appHost,
    credits: { available: async () => null, debit: async () => {} },
    async *workspaces() {
      yield workspace.id;
    },
    enabled: async () => true,
  });
  const work = options(host);
  const builds = createAppActivities(work);
  const servers = createAppServerActivities(work);
  const input = { workspaceId: workspace.id };
  const signal = () => new AbortController().signal;

  const app = (
    await transact(tx =>
      createApp(tx, {
        id: randomUUID(),
        kind: 'public',
        slug: 'shop',
        title: 'Shop',
        createdBy: workspace.membershipId,
      }),
    )
  ).app;
  await db.platform.query(
    `UPDATE "${schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now() WHERE id = $1`,
    [app.id, workspace.membershipId],
  );

  const buildAt = async (files, through = builds) => {
    const head = await commit(root, files);
    const build = await transact(tx =>
      requestBuild(tx, {
        appId: app.id,
        commit: head,
        recipe,
        builder: builder.id,
        requestedBy: workspace.membershipId,
      }),
    );
    assert.deepEqual(await through.buildApp({ ...input, buildId: build.id }), { status: 'succeeded' });
    return build.id;
  };
  const admit = admission => transact(admission).then(admitted => ({ ...input, operationId: admitted.operation.id }));
  const publish = buildId =>
    admit(tx =>
      admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, buildId }),
    );
  const retire = async ended => {
    if (ended.retiredHostRef) await servers.removeAppHost({ appId: app.id, hostRef: ended.retiredHostRef });
    return ended;
  };
  // The steps of the server workflows, so a test can interleave two operations.
  const bringUp = async operation => {
    const target = await servers.prepareAppServer(operation);
    const provisioned = await servers.provisionAppServer({ ...operation, ...target });
    const recorded = await retire(
      await servers.recordAppServerCandidate({ ...operation, hostRef: provisioned.hostRef }),
    );
    return { hostRef: provisioned.hostRef, status: recorded.status };
  };
  const switchTo = async (operation, hostRef) => retire(await servers.switchAppServer({ ...operation, hostRef }));
  const serve = async operation => switchTo(operation, (await bringUp(operation)).hostRef);
  const state = async () => {
    const found = await transact(tx => readApp(tx, app.id));
    const server = await transact(tx => readAppRuntime(tx, app.id));
    return {
      live: found.liveReleaseId,
      host: server.hostRef,
      size: server.size,
      state: server.state,
      endpoint: host.endpoints.get(app.id)?.hostRef,
      hosts: [...host.hosts.keys()].sort(),
    };
  };
  const statusOf = async operation => (await transact(tx => readOperation(tx, operation.operationId))).status;
  const releaseOf = async operation => (await transact(tx => readOperation(tx, operation.operationId))).targetReleaseId;

  await t.test('without an app host a server recipe still fails host-unavailable', async () => {
    const without = createAppActivities(options(unavailableAppHost));
    const head = await commit(root, { 'server.js': 'listen(0)' });
    const build = await transact(tx =>
      requestBuild(tx, {
        appId: app.id,
        commit: head,
        recipe,
        builder: builder.id,
        requestedBy: workspace.membershipId,
      }),
    );
    assert.deepEqual(await without.buildApp({ ...input, buildId: build.id }), { status: 'failed' });
    assert.deepEqual((await transact(tx => readBuild(tx, build.id))).status, {
      status: 'failed',
      failure: {
        code: 'host-unavailable',
        message: 'This server cannot run apps that start their own server',
        retryable: false,
      },
    });
  });

  let first;
  let newer;
  await t.test(
    'of two publishes finishing out of order the newer goes live and the loser host is removed',
    async () => {
      first = await publish(await buildAt({ 'server.js': 'listen(1)' }));
      assert.deepEqual(await serve(first), { appId: app.id, status: 'switched', switched: true, retiredHostRef: null });
      const firstHost = (await state()).host;

      const older = await publish(await buildAt({ 'server.js': 'listen(2)' }));
      const olderUp = await bringUp(older);
      assert.equal(olderUp.status, 'staging');
      newer = await publish(await buildAt({ 'server.js': 'listen(3)' }));
      const newerUp = await bringUp(newer);
      assert.deepEqual(await switchTo(newer, newerUp.hostRef), {
        appId: app.id,
        status: 'switched',
        switched: true,
        retiredHostRef: firstHost,
      });
      assert.deepEqual(await switchTo(older, olderUp.hostRef), {
        appId: app.id,
        status: 'superseded',
        switched: false,
        retiredHostRef: olderUp.hostRef,
      });

      assert.equal(await statusOf(older), 'superseded');
      assert.deepEqual(await state(), {
        live: await releaseOf(newer),
        host: newerUp.hostRef,
        size: { vcpu: 1, memMiB: 1024 },
        state: 'serving',
        endpoint: newerUp.hostRef,
        hosts: [newerUp.hostRef],
      });
    },
  );

  await t.test('a switch the host refuses supersedes the operation only when a newer one was admitted', async () => {
    const live = (await state()).host;
    const late = await publish(await buildAt({ 'server.js': 'listen(4)' }));
    const lateUp = await bringUp(late);
    let newest;
    const original = host.switch;
    host.switch = async request => {
      host.switch = original;
      newest = await publish(await buildAt({ 'server.js': 'listen(5)' }));
      const endpoint = host.endpoints.get(app.id);
      host.endpoints.set(app.id, { ...endpoint, generation: endpoint.generation + 1 });
      return original(request);
    };
    assert.deepEqual(await switchTo(late, lateUp.hostRef), {
      appId: app.id,
      status: 'superseded',
      switched: false,
      retiredHostRef: lateUp.hostRef,
    });
    assert.deepEqual((await state()).hosts, [live]);
    assert.equal(host.endpoints.get(app.id).hostRef, live);

    // The endpoint moved with no record of it, and no operation is newer, so the newest one takes it.
    const newestUp = await bringUp(newest);
    assert.deepEqual(await switchTo(newest, newestUp.hostRef), {
      appId: app.id,
      status: 'switched',
      switched: true,
      retiredHostRef: live,
    });
    assert.deepEqual(await state(), {
      live: await releaseOf(newest),
      host: newestUp.hostRef,
      size: { vcpu: 1, memMiB: 1024 },
      state: 'serving',
      endpoint: newestUp.hostRef,
      hosts: [newestUp.hostRef],
    });
  });

  await t.test(
    'a resize runs the live release at the new size, and a rollback brings back a removed host',
    async () => {
      const before = await state();
      const resize = await admit(tx =>
        admitResize(tx, {
          appId: app.id,
          requestId: randomUUID(),
          requestedBy: workspace.membershipId,
          size: { vcpu: 2, memMiB: 2048 },
          maximumSize: null,
        }),
      );
      const resized = await serve(resize);
      assert.equal(resized.status, 'switched');
      assert.equal(resized.retiredHostRef, before.host);
      const after = await state();
      assert.equal(after.live, before.live);
      assert.deepEqual(after.size, { vcpu: 2, memMiB: 2048 });
      assert.deepEqual(after.hosts, [after.host]);
      assert.equal(after.endpoint, after.host);

      const releaseId = await releaseOf(first);
      const rollback = await admit(tx =>
        admitRollback(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, releaseId }),
      );
      assert.equal((await serve(rollback)).status, 'switched');
      const rolledBack = await state();
      assert.equal(rolledBack.live, releaseId);
      assert.equal(rolledBack.host, `host-${releaseId.slice(0, 8)}-2x2048`);
      assert.deepEqual(rolledBack.hosts, [rolledBack.host]);
      assert.equal(rolledBack.endpoint, rolledBack.host);
    },
  );

  await t.test('reconcile moves a drifted endpoint back to the live host and removes orphaned hosts', async () => {
    const live = (await state()).host;
    // A loser that switched the endpoint and recorded it before its database switch lost.
    host.hosts.set('host-stray', { appId: app.id });
    const { generation } = await host.switch({ appId: app.id, hostRef: 'host-stray', drainS: 30 });
    await transact(tx => recordAppEndpoint(tx, app.id, { hostRef: 'host-stray', generation }));

    // A sibling that brought up its host and failed before recording it.
    const sibling = await publish(await buildAt({ 'server.js': 'listen(6)' }));
    const target = await servers.prepareAppServer(sibling);
    const { hostRef: orphan } = await servers.provisionAppServer({ ...sibling, ...target });
    assert.deepEqual((await state()).hosts, [orphan, 'host-stray', live].sort());

    await servers.reconcileAppServers(signal());
    assert.deepEqual(
      (await state()).hosts,
      [orphan, 'host-stray', live].sort(),
      'an app with an operation in flight is left',
    );
    assert.equal(host.endpoints.get(app.id).hostRef, 'host-stray');

    assert.deepEqual(
      await servers.failAppServerOperation({ ...sibling, message: 'The app server could not start. Try again.' }),
      { status: 'failed', retiredHostRef: null },
    );
    await servers.reconcileAppServers(signal());
    await servers.reconcileAppServers(signal());
    const repaired = await state();
    assert.equal(repaired.endpoint, live);
    assert.deepEqual(repaired.hosts, [live]);
    assert.deepEqual((await transact(tx => readAppRuntime(tx, app.id))).endpoint, {
      hostRef: live,
      generation: generation + 1,
    });
    assert.deepEqual(await telemetry.points('cloud_app_reconcile_repairs'), [
      { kind: 'endpoint-switched', value: 1 },
      { kind: 'host-removed', value: 2 },
    ]);
  });

  await t.test('reconcile leaves the endpoint a publish moved after reconcile read the app', async () => {
    host.hosts.set('host-stray', { appId: app.id });
    const { generation } = await host.switch({ appId: app.id, hostRef: 'host-stray', drainS: 30 });
    await transact(tx => recordAppEndpoint(tx, app.id, { hostRef: 'host-stray', generation }));
    let concurrent;
    let switched;
    afterNextTransaction = async () => {
      concurrent = await publish(await buildAt({ 'server.js': 'listen(8)' }));
      switched = await servers.switchAppServer({ ...concurrent, hostRef: (await bringUp(concurrent)).hostRef });
    };

    await servers.reconcileAppServers(signal());
    await retire(switched);
    const published = `host-${(await releaseOf(concurrent)).slice(0, 8)}-2x2048`;
    assert.deepEqual(await state(), {
      live: await releaseOf(concurrent),
      host: published,
      size: { vcpu: 2, memMiB: 2048 },
      state: 'serving',
      endpoint: published,
      hosts: [published],
    });
  });

  await t.test('reconcile moves the endpoint off a failed host the switch reached but never recorded', async () => {
    const { live: release, host: live } = await state();
    const operation = await publish(await buildAt({ 'server.js': 'listen(9)' }));
    const { hostRef: candidate } = await bringUp(operation);
    const original = host.switch;
    host.switch = async request => {
      host.switch = original;
      const result = await original(request);
      databaseDown = true;
      return result;
    };
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(servers.switchAppServer({ ...operation, hostRef: candidate }), /database is unavailable/);
    databaseDown = false;
    assert.deepEqual(
      await retire(
        await servers.failAppServerOperation({ ...operation, message: 'The app server could not start. Try again.' }),
      ),
      { status: 'failed', retiredHostRef: candidate },
    );
    assert.deepEqual((await state()).hosts, [live]);

    await servers.reconcileAppServers(signal());
    assert.deepEqual(await state(), {
      live: release,
      host: live,
      size: { vcpu: 2, memMiB: 2048 },
      state: 'serving',
      endpoint: live,
      hosts: [live],
    });
  });

  await t.test('without an app host a server publish fails and nothing changes', async () => {
    const before = await state();
    const without = createAppServerActivities(options(unavailableAppHost));
    const operation = await publish(await buildAt({ 'server.js': 'listen(7)' }));
    assert.equal(await without.prepareAppServer(operation), null);
    assert.equal(await statusOf(operation), 'failed');
    await without.reconcileAppServers(signal());
    assert.deepEqual(await state(), before);
  });
});

test('reconcile removes every host of a deleted workspace without opening it', { timeout: 120000 }, async t => {
  const telemetry = captureMetrics(t);
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-servers-deleted-'));
  const runtimes = [];
  let worker;
  t.after(async () => {
    for (const runtime of runtimes) await runtime.end();
    await worker?.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  worker = await migrate(db);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  const deleted = new Set();
  const opened = new Map();
  const open = async () => {
    const workspace = await db.create();
    const runtime = await connect(db.login(workspace));
    runtimes.push(runtime);
    opened.set(workspace.id, async action => {
      await runtime.query('BEGIN');
      try {
        const result = await action({ client: runtime, schema: workspace.names.schema });
        await runtime.query('COMMIT');
        return result;
      } catch (error) {
        await runtime.query('ROLLBACK');
        throw error;
      }
    });
    return workspace;
  };
  const remove = async workspace => {
    deleted.add(workspace.id);
    await db.platform.query(
      `UPDATE app.workspace_storage SET stage = 'unavailable', disabled_at = clock_timestamp(),
         disabled_operation_id = gen_random_uuid() WHERE workspace_id = $1`,
      [workspace.id],
    );
  };

  const memory = memoryHost();
  const removed = [];
  const host = {
    ...memory,
    async provision({ appId }) {
      const hostRef = `host-${appId.slice(-4)}`;
      memory.hosts.set(hostRef, { appId });
      return { hostRef };
    },
    async remove(input) {
      removed.push(input);
      await memory.remove(input);
    },
  };
  const builder = {
    id: 'sandbox-node26-v1',
    async build() {
      throw new Error('Not used');
    },
    async buildServer(input) {
      return {
        ok: true,
        output: { kind: 'server', artifact: `image-${input.buildId.slice(0, 8)}`, port: 8080, start: 'node server.js' },
        log: '',
        units: 0n,
      };
    },
  };
  const work = {
    transact: (workspaceId, action) => {
      if (deleted.has(workspaceId)) throw new Error(`Workspace ${workspaceId} is fenced`);
      return opened.get(workspaceId)(action);
    },
    platform: worker.client,
    objects: memoryObjects(),
    source: async () => root,
    publisher: undefined,
    builder,
    host,
    credits: { available: async () => null, debit: async () => {} },
    async *workspaces() {
      for (const id of opened.keys()) if (!deleted.has(id)) yield id;
    },
    enabled: async () => true,
  };
  const builds = createAppActivities(work);
  const servers = createAppServerActivities(work);
  const signal = () => new AbortController().signal;

  const serve = async (workspace, appId, source) => {
    const input = { workspaceId: workspace.id };
    const transact = opened.get(workspace.id);
    await transact(tx =>
      createApp(tx, { id: appId, kind: 'public', slug: 'shop', title: 'Shop', createdBy: workspace.membershipId }),
    );
    await db.platform.query(
      `UPDATE "${workspace.names.schema}".tf_apps SET approval_state = 'approved', approval_by = $2,
         approval_at = now() WHERE id = $1`,
      [appId, workspace.membershipId],
    );
    const head = await commit(root, { 'server.js': source });
    const build = await transact(tx =>
      requestBuild(tx, {
        appId,
        commit: head,
        recipe,
        builder: builder.id,
        requestedBy: workspace.membershipId,
      }),
    );
    await builds.buildApp({ ...input, buildId: build.id });
    const admitted = await transact(tx =>
      admitPublish(tx, { appId, requestId: randomUUID(), requestedBy: workspace.membershipId, buildId: build.id }),
    );
    const operation = { ...input, operationId: admitted.operation.id };
    const target = await servers.prepareAppServer(operation);
    const { hostRef } = await servers.provisionAppServer({ ...operation, ...target });
    await servers.recordAppServerCandidate({ ...operation, hostRef });
    assert.equal((await servers.switchAppServer({ ...operation, hostRef })).status, 'switched');
  };

  const kept = await open();
  const gone = await open();
  await serve(kept, '00000000-0000-4000-8000-00000000a001', 'listen(1)');
  await serve(gone, '00000000-0000-4000-8000-00000000b002', 'listen(2)');
  // A draft preview host of the same app, which the workspace never recorded as live.
  memory.hosts.set('draft-b002', { appId: '00000000-0000-4000-8000-00000000b002' });
  // A host brought up before the platform recorded which workspace its app belongs to.
  await db.platform.query(`DELETE FROM app.app_server_owners WHERE app_id = '00000000-0000-4000-8000-00000000a001'`);
  await remove(gone);

  await servers.reconcileAppServers(signal());
  await servers.reconcileAppServers(signal());
  assert.deepEqual(removed, [
    { appId: '00000000-0000-4000-8000-00000000b002', hostRef: 'host-b002' },
    { appId: '00000000-0000-4000-8000-00000000b002', hostRef: 'draft-b002' },
  ]);
  assert.deepEqual([...memory.hosts.keys()], ['host-a001']);
  assert.equal(memory.endpoints.get('00000000-0000-4000-8000-00000000a001').hostRef, 'host-a001');

  await remove(kept);
  await servers.reconcileAppServers(signal());
  await servers.reconcileAppServers(signal());
  assert.deepEqual(removed.slice(2), [{ appId: '00000000-0000-4000-8000-00000000a001', hostRef: 'host-a001' }]);
  assert.deepEqual([...memory.hosts.keys()], []);
  assert.deepEqual(await telemetry.points('cloud_app_reconcile_repairs'), [{ kind: 'host-removed', value: 3 }]);
});

test('the server output sweep keeps what can run again and discards the rest', { timeout: 120000 }, async t => {
  const telemetry = captureMetrics(t);
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-servers-sweep-'));
  let runtime;
  let worker;
  t.after(async () => {
    await runtime?.end();
    await worker?.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  worker = await migrate(db);
  const workspace = await db.create();
  const schema = workspace.names.schema;
  runtime = await connect(db.login(workspace));
  let databaseDown = false;
  const transact = async action => {
    if (databaseDown) throw new Error('The database is unavailable');
    await runtime.query('BEGIN');
    try {
      const result = await action({ client: runtime, schema });
      await runtime.query('COMMIT');
      return result;
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  const sweeps = [];
  const builder = {
    id: 'sandbox-node26-v1',
    async build() {
      throw new Error('Not used');
    },
    async buildServer(input) {
      return {
        ok: true,
        output: { kind: 'server', artifact: `srv-${input.buildId.slice(0, 8)}`, port: 8080, start: 'node server.js' },
        log: '',
        units: 0n,
      };
    },
    async discardServerArtifacts(input) {
      sweeps.push({ keep: [...input.keep].sort(), before: input.before });
      return { discarded: 2 };
    },
  };
  const work = {
    transact: (_, action) => transact(action),
    platform: worker.client,
    objects: memoryObjects(),
    source: async () => root,
    publisher: undefined,
    builder,
    host: memoryHost(),
    credits: { available: async () => null, debit: async () => {} },
    async *workspaces() {
      yield workspace.id;
    },
    enabled: async () => true,
  };
  const builds = createAppActivities(work);
  const servers = createAppServerActivities(work);
  const input = { workspaceId: workspace.id };
  const signal = () => new AbortController().signal;
  const now = Date.parse('2026-11-16T12:00:00.000Z');

  const app = (
    await transact(tx =>
      createApp(tx, {
        id: randomUUID(),
        kind: 'public',
        slug: 'shop',
        title: 'Shop',
        createdBy: workspace.membershipId,
      }),
    )
  ).app;
  await db.platform.query(
    `UPDATE "${schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now() WHERE id = $1`,
    [app.id, workspace.membershipId],
  );
  const request = head =>
    transact(tx =>
      requestBuild(tx, {
        appId: app.id,
        commit: head,
        recipe,
        builder: builder.id,
        requestedBy: workspace.membershipId,
      }),
    );
  const build = async source => {
    const head = await commit(root, { 'server.js': source });
    const { id } = await request(head);
    assert.deepEqual(await builds.buildApp({ ...input, buildId: id }), { status: 'succeeded' });
    return { id, head };
  };
  const publish = buildId =>
    transact(tx =>
      admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, buildId }),
    );
  const bringUp = async buildId => {
    const operation = { ...input, operationId: (await publish(buildId)).operation.id };
    const target = await servers.prepareAppServer(operation);
    const { hostRef } = await servers.provisionAppServer({ ...operation, ...target });
    await servers.recordAppServerCandidate({ ...operation, hostRef });
    return { operation, hostRef, releaseId: target.releaseId };
  };
  const serve = async buildId => {
    const { operation, hostRef, releaseId } = await bringUp(buildId);
    assert.equal((await servers.switchAppServer({ ...operation, hostRef })).status, 'switched');
    return releaseId;
  };

  const previous = await build('listen(1)');
  const previousRelease = await serve(previous.id);
  const live = await build('listen(2)');
  await serve(live.id);
  // A publish whose host came up but never went live.
  const failed = await build('listen(3)');
  const { operation: failing, releaseId: failedRelease } = await bringUp(failed.id);
  await servers.failAppServerOperation({ ...failing, message: 'The app server could not start. Try again.' });
  const unreleased = await build('listen(4)');
  const head = await build('listen(5)');
  const queued = await request(await commit(root, { 'server.js': 'listen(6)' }));
  await db.platform.query(
    `UPDATE "${schema}".tf_app_builds SET finished_at = clock_timestamp() - interval '2 hours'
     WHERE id = ANY($1::text[])`,
    [[previous.id, live.id, failed.id, unreleased.id, head.id]],
  );
  await db.platform.query(`UPDATE "${schema}".tf_app_releases SET created_at = clock_timestamp() - interval '2 hours'`);
  await db.platform.query(`UPDATE "${schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [
    app.id,
    head.head,
  ]);
  const recent = await build('listen(7)');

  await t.test('a workspace that cannot be read stops the sweep before any artifact is deleted', async () => {
    databaseDown = true;
    await assert.rejects(servers.sweepServerArtifacts(signal(), now), /Server artifact sweep failed/);
    databaseDown = false;
    assert.deepEqual(sweeps, []);
  });

  await t.test('keeps the live, rollback, draft head, recent and in-flight builds', async () => {
    await servers.sweepServerArtifacts(signal(), now);
    assert.deepEqual(sweeps, [
      {
        keep: [previous.id, live.id, head.id, queued.id, recent.id].sort(),
        before: '2026-11-16T11:00:00.000Z',
      },
    ]);
    assert.deepEqual(await telemetry.points('cloud_app_reconcile_repairs'), [
      { kind: 'release-discarded', value: 1 },
      { kind: 'server-output-discarded', value: 2 },
    ]);
  });

  await t.test('a rollback still reaches the previous release and not the discarded one', async () => {
    const rollback = releaseId =>
      transact(tx =>
        admitRollback(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, releaseId }),
      );
    assert.equal((await rollback(previousRelease)).ok, true);
    assert.deepEqual(await rollback(failedRelease), {
      ok: false,
      failure: { code: 'not-found', message: 'Release not found', retryable: false },
    });
  });

  await t.test('a build whose output was discarded is built again before it can be published', async () => {
    assert.deepEqual(await publish(unreleased.id), {
      ok: false,
      failure: { code: 'not-found', message: 'This build is no longer kept. Build the app again.', retryable: false },
    });
    assert.deepEqual((await request(unreleased.head)).status, { status: 'queued' });
    assert.deepEqual(await builds.buildApp({ ...input, buildId: unreleased.id }), { status: 'succeeded' });
    assert.equal((await publish(unreleased.id)).ok, true);
  });
});

test('server drafts run on draft hosts that reconcile keeps while used and retires', { timeout: 120000 }, async t => {
  const telemetry = captureMetrics(t);
  const db = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'app-draft-hosts-'));
  let runtime;
  let worker;
  t.after(async () => {
    await runtime?.end();
    await worker?.close();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
  worker = await migrate(db);
  const workspace = await db.create();
  const schema = workspace.names.schema;
  runtime = await connect(db.login(workspace));
  const transact = async action => {
    await runtime.query('BEGIN');
    try {
      const result = await action({ client: runtime, schema });
      await runtime.query('COMMIT');
      return result;
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
  const builder = {
    id: 'sandbox-node26-v1',
    async build() {
      throw new Error('Not used');
    },
    async buildServer(input) {
      return {
        ok: true,
        output: { kind: 'server', artifact: `image-${input.buildId.slice(0, 8)}`, port: 8080, start: 'node server.js' },
        log: '',
        units: 0n,
      };
    },
  };
  const host = memoryHost();
  let credits = null;
  const work = {
    transact: (_workspaceId, action) => transact(action),
    platform: worker.client,
    objects: memoryObjects(),
    source: async () => root,
    publisher: undefined,
    builder,
    host,
    credits: { available: async () => credits, debit: async () => {} },
    async *workspaces() {
      yield workspace.id;
    },
    enabled: async () => true,
  };
  const builds = createAppActivities(work);
  const servers = createAppServerActivities(work);
  const signal = () => new AbortController().signal;
  const app = (
    await transact(tx =>
      createApp(tx, {
        id: randomUUID(),
        kind: 'public',
        slug: 'shop',
        title: 'Shop',
        createdBy: workspace.membershipId,
      }),
    )
  ).app;
  await db.platform.query(
    `UPDATE "${schema}".tf_apps SET approval_state = 'approved', approval_by = $2, approval_at = now() WHERE id = $1`,
    [app.id, workspace.membershipId],
  );

  /** Commits `files`, builds the commit and makes it the draft head. */
  const draftAt = async files => {
    const head = await commit(root, files);
    const build = await transact(tx =>
      requestBuild(tx, {
        appId: app.id,
        commit: head,
        recipe,
        builder: builder.id,
        requestedBy: workspace.membershipId,
      }),
    );
    assert.deepEqual(await builds.buildApp({ workspaceId: workspace.id, buildId: build.id }), { status: 'succeeded' });
    await db.platform.query(`UPDATE "${schema}".tf_app_drafts SET head_commit = $2 WHERE app_id = $1`, [app.id, head]);
    return build.id;
  };
  const open = async () => (await transact(tx => requestDraftHost(tx, app.id))).start?.generation ?? null;
  const input = generation => ({ workspaceId: workspace.id, appId: app.id, generation });
  const bringUp = async generation => {
    const target = await servers.prepareDraftHost(input(generation));
    if (!target) return null;
    const provisioned = await servers.provisionDraftHost({ ...input(generation), ...target });
    return provisioned.hostRef;
  };
  const record = async (generation, hostRef) => {
    const recorded = await servers.recordDraftHost({ ...input(generation), hostRef });
    if (recorded.retiredHostRef) await servers.removeAppHost({ appId: app.id, hostRef: recorded.retiredHostRef });
    return recorded;
  };
  const draft = async () => {
    const found = await transact(tx => readDraftHost(tx, app.id));
    return found && { generation: found.generation, state: found.state, hostRef: found.hostRef ?? null };
  };
  const hosts = () => [...host.hosts.keys()].sort();
  const draftHost = (buildId, generation) => `draft-${buildId.slice(0, 8)}-g${generation}-1x1024`;

  const first = await draftAt({ 'server.js': 'listen(1)' });
  assert.equal(await open(), 1);
  const target = await servers.prepareDraftHost(input(1));
  assert.deepEqual(target, {
    buildId: first,
    size: { vcpu: 1, memMiB: 1024 },
    output: { kind: 'server', artifact: `image-${first.slice(0, 8)}`, port: 8080, start: 'node server.js' },
  });
  assert.deepEqual(await servers.provisionDraftHost({ ...input(1), ...target }), {
    ok: true,
    hostRef: draftHost(first, 1),
  });
  assert.equal(host.hosts.get(draftHost(first, 1)).draftBuildId, first);
  assert.deepEqual(await record(1, draftHost(first, 1)), { retiredHostRef: null });
  assert.deepEqual(await draft(), { generation: 1, state: 'ready', hostRef: draftHost(first, 1) });

  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [draftHost(first, 1)], 'a draft host opened recently is kept');
  assert.equal(host.endpoints.get(app.id), undefined, 'the endpoint never moves to a draft host');

  // A new draft build starts again. Until the start records its host, reconcile removes no host of the app.
  const second = await draftAt({ 'server.js': 'listen(2)' });
  assert.equal(await open(), 2);
  const secondHost = await bringUp(2);
  assert.equal(secondHost, draftHost(second, 2));
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [draftHost(first, 1), draftHost(second, 2)].sort());

  // That start is lost; a later open starts again and the late recording removes its host.
  await db.platform.query(
    `UPDATE "${schema}".tf_app_draft_hosts SET updated_at = now() - interval '11 minutes' WHERE app_id = $1`,
    [app.id],
  );
  assert.equal(await open(), 3);
  assert.deepEqual(await record(2, secondHost), { retiredHostRef: secondHost });
  assert.deepEqual(hosts(), [draftHost(first, 1)]);
  assert.deepEqual(await record(3, await bringUp(3)), { retiredHostRef: null });
  assert.deepEqual(await draft(), { generation: 3, state: 'ready', hostRef: draftHost(second, 3) });
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [draftHost(second, 3)], 'the replaced draft host is removed');

  // A draft host no editor opened for a day is retired.
  await db.platform.query(
    `UPDATE "${schema}".tf_app_draft_hosts SET opened_at = now() - interval '25 hours' WHERE app_id = $1`,
    [app.id],
  );
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), []);
  assert.deepEqual(await draft(), { generation: 3, state: 'stopped', hostRef: null });

  // A draft host whose build is no longer the draft head's is retired.
  assert.equal(await open(), 4);
  await record(4, await bringUp(4));
  await draftAt({ 'server.js': 'listen(3)' });
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), []);
  assert.deepEqual(await draft(), { generation: 4, state: 'stopped', hostRef: null });

  // A draft host whose build went live is retired, and the endpoint stays on the live host.
  assert.equal(await open(), 5);
  const third = (await transact(tx => readDraftHost(tx, app.id))).buildId;
  await record(5, await bringUp(5));
  const operation = await transact(tx =>
    admitPublish(tx, { appId: app.id, requestId: randomUUID(), requestedBy: workspace.membershipId, buildId: third }),
  );
  const publish = { workspaceId: workspace.id, operationId: operation.operation.id };
  const serving = await servers.prepareAppServer(publish);
  const { hostRef: live } = await servers.provisionAppServer({ ...publish, ...serving });
  await servers.recordAppServerCandidate({ ...publish, hostRef: live });
  assert.equal((await servers.switchAppServer({ ...publish, hostRef: live })).status, 'switched');
  assert.equal(await open(), null, 'a draft head that is live needs no draft host');
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [live]);
  assert.equal(host.endpoints.get(app.id).hostRef, live);
  assert.deepEqual(await draft(), { generation: 5, state: 'stopped', hostRef: null });
  assert.deepEqual(await telemetry.points('cloud_app_reconcile_repairs'), [{ kind: 'host-removed', value: 4 }]);

  // Without credits a draft host start fails before any host is brought up.
  const fourth = await draftAt({ 'server.js': 'listen(4)' });
  credits = 0n;
  assert.equal(await open(), 6);
  assert.equal(await servers.prepareDraftHost(input(6)), null);
  assert.deepEqual(hosts(), [live]);
  assert.deepEqual((await transact(tx => readDraftHost(tx, app.id))).failure, {
    code: 'budget-exhausted',
    message: 'The workspace has no credits left to run this draft.',
    retryable: false,
  });

  // A start that never records its host holds the app's hosts for 10 minutes, then fails and lets reconcile remove it.
  credits = null;
  assert.equal(await open(), 7);
  const stuck = await bringUp(7);
  assert.equal(stuck, draftHost(fourth, 7));
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [stuck, live].sort());
  assert.deepEqual(await draft(), { generation: 7, state: 'starting', hostRef: null });
  await db.platform.query(
    `UPDATE "${schema}".tf_app_draft_hosts SET updated_at = now() - interval '11 minutes' WHERE app_id = $1`,
    [app.id],
  );
  await servers.reconcileAppServers(signal());
  assert.deepEqual(hosts(), [live]);
  assert.deepEqual(await draft(), { generation: 7, state: 'failed', hostRef: null });
  assert.deepEqual((await transact(tx => readDraftHost(tx, app.id))).failure, {
    code: 'host-unavailable',
    message: 'The app server did not start in time. Try again.',
    retryable: true,
  });
  assert.equal(await open(), 8, 'the next open starts again');
});
