import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { createAuth } from '../src/auth.ts';
import { registerWorkspaceMembers } from '../src/workspace-members.ts';
import { registerAccountDetails } from '../src/account-details.ts';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
  seedPlatformAccount,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createMemberProfileProjection, memberProfileSource } from '@tulipfarm/workspaces/member-profiles';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration, workspaceMembersTable } from '@tulipfarm/tables/store';
import { manualWorkspaceMemberValues, workspaceMemberFields } from '@tulipfarm/tables/workspace-members';

test(
  'authenticated member status and photos expose pending, failed, retry, and private account boundaries',
  { timeout: 45000 },
  async t => {
    const db = await fixture(),
      cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app', max: 2 });
    cleanup.push(() => pool.end());
    const deliveries = [];
    const auth = createAuth(
      pool,
      async ({ url }) => {
        deliveries.push(url);
      },
      async () => {},
    );
    const signIn = async name => {
      const email = `${randomUUID()}@example.test`;
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email, name },
      });
      const response = await auth.handler(new Request(deliveries.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      assert.ok(session);
      return { id: session.user.id, cookie };
    };
    const admin = await signIn('Admin'),
      reader = await signIn('Reader'),
      outsider = await signIn('Outsider');
    const workspace = await db.create(db.baseline, { userId: admin.id });
    await markWorkspaceReady(db.platform, workspace.id);
    const s = `"${workspace.names.schema}"`;
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => {
        assert.equal(id, workspace.id);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const app = Fastify();
    app.register(
      async routes => {
        registerWorkspaceMembers(routes, { auth, runtime });
        registerAccountDetails(routes, { auth, identity: pool, googleEnabled: true });
      },
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const base = `/v1/workspaces/${workspace.id}/workspace-members`;
    const http = (who, path = base, method = 'GET', origin = 'http://localhost:5173') =>
      fetch(`${address}${path}`, {
        method,
        headers: { ...(who ? { cookie: who.cookie } : {}), origin },
      });
    const state = async who => {
      const response = await http(who);
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await http(null)).status, 401);
    assert.equal((await http(outsider)).status, 404);
    let current = await state(admin);
    assert.equal(current.sync.pending, 1);
    assert.equal(current.members[0].materialized, false);
    assert.equal(current.members[0].profile, 'pending');
    assert.equal(current.members[0].canRetry, true);
    assert.equal((await (await http(admin, `${base}?attention=true`)).json()).members.length, 1);
    const memberId = current.members[0].id;
    assert.notEqual(memberId, admin.id);
    const methodsPath = '/v1/account/sign-in-methods';
    assert.equal((await http(null, methodsPath)).status, 401);
    assert.deepEqual(await (await http(admin, methodsPath)).json(), { methods: ['email-link'] });
    await seedPlatformAccount(pool, {
      userId: admin.id,
      providerId: 'google',
      accessToken: 'private-access-token',
      refreshToken: 'private-refresh-token',
    });
    assert.deepEqual(await (await http(admin, methodsPath)).json(), { methods: ['email-link', 'google'] });
    assert.deepEqual(await (await http(reader, methodsPath)).json(), { methods: ['email-link'] });
    const suppliedUser = await http(reader, `${methodsPath}?userId=${admin.id}`);
    assert.ok(
      suppliedUser.status === 400 || JSON.stringify(await suppliedUser.json()) === '{"methods":["email-link"]}',
      'Caller-supplied identity cannot select another account',
    );
    const readerAccessId = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      readerAccessId,
      reader.id,
    ]);
    const source = memberProfileSource(pool),
      discover = async after => (after ? [] : [workspace.id]);
    const projection = createMemberProfileProjection({ runtime, source, discover });
    assert.equal((await projection.project(workspace.id)).applied, 2);
    const generation = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
      activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
    );
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const manual = await tables.mutate(workspace.id, admin.id, {
      kind: 'create',
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: randomUUID(),
      values: manualWorkspaceMemberValues({ name: 'Never signs in' }),
    });
    const visible = (await state(reader)).members.find(row => row.id === manual.id);
    assert.equal(visible.profile, 'manual');
    assert.equal(visible.accountLinked, false);
    assert.equal(visible.canEditProfile, false);
    assert.equal(visible.canRetry, false);
    assert.deepEqual((await (await http(admin, `${base}?attention=true`)).json()).members, []);
    assert.equal((await (await http(admin, `${base}?attention=false`)).json()).members.length, 3);
    await assert.rejects(
      tables.mutate(workspace.id, reader.id, {
        kind: 'update',
        tableId: generation.table_id,
        revision: generation.revision,
        recordId: manual.id,
        expectedToken: manual.token,
        values: { [workspaceMemberFields.name]: { kind: 'text', value: 'Denied' } },
      }),
      AccessDenied,
    );
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH0AAAAASUVORK5CYII=';
    await pool.query('UPDATE app.users SET image=$2 WHERE id=$1', [admin.id, image]);
    await projection.dispatch();
    const offline = createMemberProfileProjection({
      runtime,
      discover,
      source: {
        ...source,
        read: async () => {
          throw new Error('Fixture offline');
        },
      },
    });
    await assert.rejects(offline.project(workspace.id), /source unavailable/);
    current = await state(admin);
    assert.equal(current.sync.failed, 1);
    assert.equal(current.members.find(row => row.id === memberId).profile, 'failed');
    assert.deepEqual(
      (await (await http(admin, `${base}?attention=true`)).json()).members.map(row => row.id),
      [memberId],
    );
    const retry = `${base}/${memberId}/profile-sync/retry`;
    assert.equal((await http(reader, retry, 'POST')).status, 404);
    assert.equal((await http(admin, retry, 'POST', 'https://untrusted.example')).status, 403);
    assert.equal((await http(admin, retry, 'POST')).status, 200);
    assert.equal((await http(admin, retry, 'POST')).status, 200);
    assert.equal((await state(admin)).sync.pending, 1);
    assert.equal((await projection.project(workspace.id)).applied, 1);
    const record = await tables.read(workspace.id, reader.id, {
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: memberId,
    });
    const photoPath = record.values[workspaceMemberFields.photo].value;
    const photo = await http(reader, photoPath);
    assert.equal(photo.status, 200);
    assert.match(photo.headers.get('content-type'), /^image\/png/);
    assert.equal(photo.headers.get('cache-control'), 'private, no-store');
    assert.equal(photo.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(image.split(',')[1], 'base64'));
    assert.equal((await http(outsider, photoPath)).status, 404);
    assert.equal((await http(null, photoPath)).status, 401);
    current = await state(reader);
    assert.deepEqual(current.sync, { pending: 0, failed: 0, repairRequired: 0 });
    assert.ok(current.members.every(row => !('userId' in row) && !('membershipId' in row) && !('provider' in row)));
    const change = (who, input) =>
      fetch(`${address}${base}/${input.recordId}`, {
        method: 'POST',
        headers: { cookie: who.cookie, origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const upload = {
      kind: 'member-photo',
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: manual.id,
      expectedToken: manual.token,
      requestId: randomUUID(),
      image,
    };
    assert.equal((await change(reader, upload)).status, 404);
    assert.equal((await change(admin, { ...upload, image: 'data:image/png;base64,SGVsbG8=' })).status, 409);
    const savedResponse = await change(admin, upload);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual(
      await (await change(admin, upload)).json(),
      saved,
      'The same intent replays its original photo result',
    );
    assert.equal((await change(admin, { ...upload, image: null })).status, 409, 'A key cannot change its payload');
    assert.equal(
      (await change(admin, { ...upload, requestId: randomUUID() })).status,
      409,
      'A new edit needs the current row token',
    );
    const removedResponse = await change(admin, {
      ...upload,
      requestId: randomUUID(),
      expectedToken: saved.token,
      image: null,
    });
    assert.equal(removedResponse.status, 200);
    assert.equal((await removedResponse.json()).values[workspaceMemberFields.photo], null);
    assert.equal(
      (await http(reader, saved.values[workspaceMemberFields.photo].value)).status,
      200,
      'Retained history photos still resolve',
    );
    assert.equal(
      (await change(admin, { ...upload, recordId: memberId, expectedToken: record.token, requestId: randomUUID() }))
        .status,
      409,
      'Table photo edits cannot overwrite an active account profile',
    );

    const departed = await signIn('Private name must not be copied');
    const departedAccessId = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      departedAccessId,
      departed.id,
    ]);
    await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [
      departedAccessId,
    ]);
    current = await state(admin);
    assert.equal(current.sync.repairRequired, 1);
    const reserved = current.members.find(row => row.profile === 'repair-required');
    assert.equal(reserved.canRepair, true);
    assert.equal(reserved.canRetry, false);
    assert.equal((await state(reader)).members.find(row => row.id === reserved.id).canRepair, false);
    const repair = {
      kind: 'member-repair',
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: reserved.id,
      expectedToken: reserved.token,
      requestId: randomUUID(),
      values: manualWorkspaceMemberValues({ name: 'Manually restored person', contactEmail: 'business@example.test' }),
    };
    assert.equal((await change(reader, repair)).status, 404);
    const repairedResponse = await change(admin, repair);
    assert.equal(repairedResponse.status, 200);
    const repaired = await repairedResponse.json();
    assert.equal(repaired.id, reserved.id);
    assert.equal(repaired.values[workspaceMemberFields.accountEmail], null);
    assert.deepEqual(await (await change(admin, repair)).json(), repaired, 'Repair is safe after a lost response');
    assert.equal(
      (await change(admin, { ...repair, requestId: randomUUID() })).status,
      409,
      'Repair cannot rewrite a live member',
    );
    await pool.query('UPDATE app.users SET name=$2 WHERE id=$1', [departed.id, 'New private name']);
    await projection.dispatch();
    await projection.project(workspace.id);
    assert.deepEqual(
      (
        await tables.read(workspace.id, reader.id, {
          tableId: generation.table_id,
          revision: generation.revision,
          recordId: reserved.id,
        })
      ).values,
      repaired.values,
      'Repair never resumes profile sharing after access removal',
    );
    current = await state(admin);
    assert.equal(current.sync.repairRequired, 0);
    assert.equal(current.members.find(row => row.id === reserved.id).profile, 'manual');
  },
);
