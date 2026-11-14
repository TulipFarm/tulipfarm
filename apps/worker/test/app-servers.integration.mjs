import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  readOperation,
  recordAppEndpoint,
  requestBuild,
} from '@tulipfarm/apps/store';
import { AppHostConflictError, unavailableAppHost } from '@tulipfarm/extensions';
import { connect, fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createAppActivities } from '../src/app-activities.ts';
import { createAppServerActivities } from '../src/app-server-activities.ts';
import { captureMetrics } from './metric-capture.mjs';

const recipe = { kind: 'server', runtime: 'node22', serve: { port: 8080, start: 'node server.js' } };

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

/** Hosts named by release and size, and one endpoint per app whose generation grows by one at each switch. */
function memoryHost() {
  const hosts = new Map();
  const endpoints = new Map();
  return {
    hosts,
    endpoints,
    async provision({ appId, releaseId, size, output }) {
      const hostRef = `host-${releaseId.slice(0, 8)}-${size.vcpu}x${size.memMiB}`;
      hosts.set(hostRef, { appId, artifact: output.artifact, size });
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
  t.after(async () => {
    await runtime?.end();
    await rm(root, { recursive: true, force: true });
    await db.close();
  });
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
    id: 'sandbox-node22-v1',
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
  const options = appHost => ({
    transact: (workspaceId, action) => {
      assert.equal(workspaceId, workspace.id);
      return transact(action);
    },
    platform: db.platform,
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
