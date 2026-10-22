import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { filesObjectFixture } from '../../../packages/workspaces/test/files-object-fixture.mjs';
import { authenticatedFixture } from './auth-fixture.mjs';
import { registerFilesComposition, filesObjectAdapter } from '../dist/files-composition.js';
import { securityServerOptions } from '../dist/security.js';

async function setup({ quotaBytes } = {}) {
  const db = await fixture();
  let runtime, identity, object, app;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const main = await workspaceTableMigrations();
    const stream = main;
    const signed = await authenticatedFixture(db);
    identity = signed.identity;
    const workspace = await db.create(stream, { userId: signed.owner.id }),
      other = await db.create(stream, { userId: signed.admin.id });
    const table = name => qualified(workspace.names.schema, name);
    const adminMembership = await signed.addAdmin(workspace);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 24,
      resolveCredential: async id => {
        const target = [workspace, other].find(item => item.id === id);
        if (!target) throw new AccessDenied();
        return { workspaceId: id, generation: 1, connectionString: db.login(target) };
      },
    });
    object = await filesObjectFixture();
    app = Fastify(securityServerOptions());
    const parsing = new Set();
    app.addHook('preParsing', async request => {
      parsing.add(request.url);
    });
    app.register(
      async routes =>
        registerFilesComposition(routes, { runtime, auth: signed.auth, objects: object.adapter, identity, quotaBytes }),
      { prefix: '/v1' },
    );
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `/v1/workspaces/${workspace.id}/files`;
    async function call(path = '', { method = 'GET', body, cookie = signed.owner.cookie, headers = {} } = {}) {
      const response = await fetch(`${origin}${path.startsWith('/v1/') ? path : base + path}`, {
        method,
        headers: {
          cookie,
          origin: 'http://localhost:5173',
          ...(body === undefined
            ? {}
            : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return { status: response.status, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString()) };
    }
    const uploadPath = (id, name = 'Private.txt', parentId = null) =>
      `/${id}/content?${new URLSearchParams({ name, parentId: parentId ?? 'null', mediaType: 'text/plain' })}`;
    const upload = (id = randomUUID(), body = Buffer.from('private contents'), parentId = null) =>
      call(uploadPath(id, 'Private.txt', parentId), { method: 'PUT', body });
    const folder = async (name, parentId = null) => {
      const id = randomUUID();
      const result = await call(`/${id}/folder`, { method: 'PUT', body: { name, parentId } });
      assert.equal(result.status, 200, result.bytes.toString());
      return id;
    };
    const share = (id, role, subject = { kind: 'individual', id: adminMembership }) =>
      call(`/${id}/sharing`, { method: 'PUT', body: { subject, role } });
    return {
      db,
      workspace,
      other,
      table,
      signed,
      adminMembership,
      object,
      app,
      origin,
      base,
      call,
      upload,
      uploadPath,
      folder,
      share,
      stream,
      parsing,
      close: async () => {
        await app.close();
        await object.close();
        await runtime.close();
        await identity.end();
        await db.close();
      },
    };
  } catch (error) {
    await app?.close();
    await object?.close();
    await runtime?.close();
    await identity?.end();
    await db.close();
    throw error;
  }
}

test('real sessions, HTTP, restricted PostgreSQL and signed object transport serve the Files lifecycle', async () => {
  const f = await setup();
  try {
    const root = await f.folder('Shared'),
      nested = await f.folder('Nested', root);
    const id = randomUUID(),
      bytes = Buffer.from('private contents');
    const uploaded = await f.upload(id, bytes, nested);
    assert.equal(uploaded.status, 200, uploaded.bytes.toString());
    assert.deepEqual(uploaded.json(), {
      id,
      name: 'Private.txt',
      kind: 'file',
      parentId: nested,
      creatorMembershipId: f.workspace.membershipId,
      mediaType: 'text/plain',
      size: 16,
      trashed: false,
      role: 'manager',
      deletion: null,
    });
    assert.equal((await f.upload(id, bytes, nested)).status, 200);
    assert.equal((await f.upload(id, Buffer.from('changed'), nested)).status, 409);
    assert.equal(f.object.objects.size, 1);
    assert.deepEqual(
      (await f.call(`?parentId=${nested}&query=PRIVATE`)).json().items.map(item => item.id),
      [id],
    );
    const content = await f.call(`/${id}/content`);
    assert.equal(content.status, 200);
    assert.deepEqual(content.bytes, bytes);
    assert.equal(content.headers.get('content-type'), 'application/octet-stream');
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
    assert.match(content.headers.get('content-disposition'), /^attachment;/);
    assert.equal(content.headers.get('location'), null);
    assert.equal((await f.call(`/${id}`, { method: 'PATCH', body: { name: "Renamed 'é.txt" } })).json().id, id);
    assert.match((await f.call(`/${id}/content`)).headers.get('content-disposition'), /Renamed%20%27%C3%A9.txt/);
    assert.equal((await f.share(root, 'viewer')).status, 200);
    const admin = { cookie: f.signed.admin.cookie };
    assert.deepEqual((await f.call(`/${id}/content`, admin)).bytes, bytes);
    const sharing = (await f.call(`/${id}/sharing`)).json();
    assert.deepEqual(sharing.directGrants, []);
    assert.equal(
      sharing.inherited.some(entry => entry.kind === 'grant' && entry.grant.subject.id === f.adminMembership),
      true,
    );
    for (const role of ['viewer', 'editor']) {
      assert.equal((await f.share(root, role)).status, 200);
      for (const [path, method, body] of [
        [`/${id}/sharing`, 'GET'],
        [`/${id}/sharing`, 'PUT', { subject: { kind: 'individual', id: f.adminMembership }, role: 'manager' }],
        [`/${id}`, 'PATCH', { name: 'stolen' }],
        [`/${id}/move-audience`, 'POST', { parentId: null }],
        [`/${id}/trash`, 'PUT', { trashed: true }],
      ])
        assert.equal((await f.call(path, { ...admin, method, body })).status, 404);
    }
    const target = await f.folder('Target');
    const preview = await f.call(`/${nested}/move-audience`, { method: 'POST', body: { parentId: target } });
    assert.equal(preview.status, 200, preview.bytes.toString());
    const movedChild = preview.json().subtree.find(entry => entry.item.id === id);
    assert.equal(
      movedChild.before.audience.some(entry => entry.membershipId === f.adminMembership),
      true,
    );
    assert.equal(
      movedChild.after.audience.some(entry => entry.membershipId === f.adminMembership),
      false,
    );
    assert.equal((await f.share(root, 'manager')).status, 200);
    const move = fingerprint => f.call(`/${nested}/parent`, { method: 'PUT', body: { parentId: target, fingerprint } });
    assert.equal((await move(preview.json().fingerprint)).status, 409);
    assert.equal((await f.call(`/${nested}`)).json().parentId, root);
    const fresh = await f.call(`/${nested}/move-audience`, { method: 'POST', body: { parentId: target } });
    assert.equal((await move(fresh.json().fingerprint)).status, 200);
    assert.equal((await f.call(`/${id}/content`, admin)).status, 404);
    assert.deepEqual((await f.call(`/${id}/content`)).bytes, bytes);
    assert.equal((await f.call(`/${target}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    assert.equal((await f.call(`/${id}`)).status, 404);
    assert.deepEqual(
      (await f.call('?trash=true')).json().items.map(item => item.id),
      [target],
    );
    assert.equal((await f.call(`/${target}/trash`, { method: 'PUT', body: { trashed: false } })).status, 200);
    assert.deepEqual((await f.call(`/${id}/content`)).bytes, bytes);
  } finally {
    await f.close();
  }
});

test('authenticated suggestion reads are side-effect free and recent use is explicit', async () => {
  const f = await setup();
  try {
    const first = randomUUID(),
      second = randomUUID();
    assert.equal((await f.upload(first, Buffer.from('first'))).status, 200);
    assert.equal(
      (await f.call(f.uploadPath(second, 'Second report.txt'), { method: 'PUT', body: Buffer.from('second') })).status,
      200,
    );

    assert.deepEqual((await f.call('/suggestions')).json(), { items: [], next: null });
    assert.deepEqual((await f.db.platform.query(`SELECT * FROM ${f.table('tf_file_usage')}`)).rows, []);
    assert.equal((await f.call(`/${first}/recent-use`, { method: 'POST' })).status, 200);
    assert.deepEqual(
      (await f.call('/suggestions')).json().items.map(item => item.id),
      [first],
    );
    assert.deepEqual(
      (await f.call('/suggestions?query=REPORT')).json().items.map(item => item.id),
      [second],
    );
    assert.equal((await f.call(`/${second}/recent-use`, { method: 'POST', cookie: '' })).status, 401);
  } finally {
    await f.close();
  }
});

test('personal files conceal metadata and bytes from anonymous, admin, foreign workspace and revoked readers', async () => {
  const f = await setup();
  try {
    const id = randomUUID();
    assert.equal((await f.upload(id)).status, 200);
    const reads = f.object.requests.length;
    for (const path of [`/${id}`, `/${id}/sharing`, `/${id}/content`]) {
      assert.equal((await f.call(path, { cookie: '' })).status, 401);
      const denied = await f.call(path, { cookie: f.signed.admin.cookie });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json(), { error: 'file-not-found' });
      assert.deepEqual(
        (await f.call(path.replace(id, randomUUID()), { cookie: f.signed.admin.cookie })).json(),
        denied.json(),
      );
      assert.equal(
        (await f.call(`/v1/workspaces/${f.other.id}/files${path}`, { cookie: f.signed.admin.cookie })).status,
        404,
      );
    }
    assert.deepEqual((await f.call('', { cookie: f.signed.admin.cookie })).json(), { items: [], next: null });
    assert.deepEqual(
      (await f.call(`/summaries?ids=${id},${randomUUID()}`)).json().items.map(item => item.id),
      [id],
      'Summaries return readable files only',
    );
    assert.deepEqual((await f.call(`/summaries?ids=${id}`, { cookie: f.signed.admin.cookie })).json(), { items: [] });
    assert.equal((await f.call('/summaries?ids=not-a-file')).status, 400);
    assert.equal(f.object.requests.length, reads);
    assert.equal(
      (
        await f.call(`/${id}`, {
          method: 'PATCH',
          body: { name: 'denied' },
          headers: { origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    assert.equal((await f.share(id, 'viewer', { kind: 'individual', id: f.other.membershipId })).status, 404);
    assert.equal((await f.share(id, 'viewer')).status, 200);
    assert.equal((await f.call(`/${id}/content`, { cookie: f.signed.admin.cookie })).status, 200);
    f.object.faults.afterRead = async () => {
      assert.equal((await f.share(id, null)).status, 200);
    };
    const revoked = await f.call(`/${id}/content`, { cookie: f.signed.admin.cookie });
    assert.equal(revoked.status, 404);
    assert.deepEqual(revoked.json(), { error: 'file-not-found' });
    assert.equal((await f.call(`/${id}/content`, { cookie: f.signed.admin.cookie })).status, 404);
    assert.equal((await f.share(id, 'viewer')).status, 200);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.adminMembership,
    ]);
    assert.equal((await f.call(`/${id}/content`, { cookie: f.signed.admin.cookie })).status, 404);
    assert.deepEqual((await f.call(`/${id}/content`)).bytes, Buffer.from('private contents'));
    const before = f.object.requests.length;
    const foreign = await f.call(`/v1/workspaces/${f.other.id}/files${f.uploadPath(randomUUID())}`, {
      method: 'PUT',
      body: Buffer.from('foreign contents'),
      cookie: f.signed.admin.cookie,
    });
    assert.equal(foreign.status, 200);
    const workspaces = requests => new Set(requests.map(({ key }) => key.split('/')[2]));
    assert.deepEqual(workspaces(f.object.requests.slice(0, before)), new Set([f.workspace.id]));
    assert.deepEqual(workspaces(f.object.requests.slice(before)), new Set([f.other.id]));
  } finally {
    await f.close();
  }
});

test('failed transfers leave no row, object, or charge, and exact retries publish once', async () => {
  const f = await setup({ quotaBytes: 32 });
  try {
    const rows = async id =>
      (await f.db.platform.query(`SELECT ready,size FROM ${f.table('tf_files')} WHERE id=$1`, [id])).rows;
    const id = randomUUID();
    f.object.faults.write = true;
    assert.equal((await f.upload(id)).status, 500);
    assert.deepEqual((await f.call()).json(), { items: [], next: null });
    assert.equal((await f.call(`/${id}`)).status, 404);
    assert.deepEqual(await rows(id), [], 'a failed write reserves nothing');
    f.object.faults.write = false;
    f.object.faults.corrupt = true;
    assert.equal((await f.upload(id)).status, 502);
    assert.deepEqual([await rows(id), f.object.objects.size], [[], 0], 'an object that fails verification is removed');
    f.object.faults.corrupt = false;
    assert.equal((await f.upload(id)).status, 200);
    assert.equal((await f.call(`/${id}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    const failed = randomUUID();
    f.object.faults.write = true;
    assert.equal((await f.upload(failed)).status, 500);
    f.object.faults.write = false;
    const fits = randomUUID();
    assert.equal(
      (await f.upload(fits)).status,
      200,
      'the failed upload holds no quota, so Trash plus this file fill it exactly',
    );
    const quota = await f.upload(failed);
    assert.equal(quota.status, 409);
    assert.deepEqual(quota.json(), { error: 'file-quota' });
    assert.deepEqual(
      [await rows(failed), f.object.objects.size],
      [[], 2],
      'the over-quota attempt removes its stored object',
    );
    f.object.faults.oversized = true;
    assert.equal((await f.call(`/${fits}/content`)).status, 500);
    f.object.faults.oversized = false;
    assert.deepEqual((await f.call(`/${fits}/content`)).bytes, Buffer.from('private contents'));
    const adapter = filesObjectAdapter(f.object.adapter);
    await assert.rejects(adapter.putIfAbsent(`${f.workspace.id}/attachments/${randomUUID()}`, Buffer.from('x')));
    await assert.rejects(adapter.remove(`${f.workspace.id}/attachments/${randomUUID()}`));
    assert.deepEqual(Object.keys(adapter).sort(), ['putIfAbsent', 'read', 'remove']);
  } finally {
    await f.close();
  }
});

test('HTTP deletes Trash items forever for owners only, names blocking items and releases storage', async () => {
  const f = await setup({ quotaBytes: 1024 });
  try {
    const admin = { cookie: f.signed.admin.cookie };
    const folder = await f.folder('Projects');
    assert.equal((await f.share(folder, 'manager')).status, 200);
    const mine = randomUUID(),
      theirs = randomUUID();
    assert.equal((await f.upload(mine, Buffer.from('owner bytes'), folder)).status, 200);
    assert.equal(
      (
        await f.call(f.uploadPath(theirs, 'Theirs.txt', folder), {
          ...admin,
          method: 'PUT',
          body: Buffer.from('their bytes'),
        })
      ).status,
      200,
    );
    assert.deepEqual((await f.call('/usage')).json(), { usedBytes: 22, quotaBytes: 1024, maxFileBytes: 10485760 });
    assert.equal((await f.call(`/${folder}/delete-forever`, { method: 'POST' })).json().error, 'file-not-trashed');
    assert.equal((await f.call(`/${folder}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    const denied = await f.call(`/${folder}/delete-forever`, { ...admin, method: 'POST' });
    assert.deepEqual([denied.status, denied.json()], [403, { error: 'file-not-owner' }]);
    assert.equal((await f.call(`/${folder}/deletion`, admin)).status, 403);
    const preview = (await f.call(`/${folder}/deletion`)).json();
    assert.deepEqual(
      { ...preview, blockers: preview.blockers.map(blocker => ({ ...blocker, owner: blocker.owner.membershipId })) },
      {
        item: {
          id: folder,
          kind: 'folder',
          name: 'Projects',
          parentId: null,
          creatorMembershipId: f.workspace.membershipId,
          mediaType: null,
          size: null,
          trashed: true,
          role: 'manager',
          deletion: null,
        },
        files: 2,
        bytes: 22,
        blockerCount: 1,
        blockers: [{ id: theirs, name: 'Theirs.txt', kind: 'file', owner: f.adminMembership }],
      },
    );
    assert.notEqual(preview.blockers[0].owner.name, 'Former member');
    const refused = await f.call(`/${folder}/delete-forever`, { method: 'POST' });
    assert.deepEqual([refused.status, refused.json()], [409, { error: 'file-owned-by-others' }]);
    assert.equal((await f.call(`/${folder}/trash`, { method: 'PUT', body: { trashed: false } })).status, 200);
    assert.equal((await f.call(`/${mine}/trash`, { method: 'PUT', body: { trashed: true } })).status, 200);
    const deleted = await f.call(`/${mine}/delete-forever`, { method: 'POST' });
    assert.deepEqual([deleted.status, deleted.json()], [200, { id: mine, state: 'deleted' }]);
    assert.equal((await f.call(`/${mine}`)).status, 404);
    assert.equal((await f.call(`/${mine}/content`)).status, 404);
    assert.deepEqual((await f.call('/usage')).json().usedBytes, 11);
    assert.equal(f.object.objects.size, 1);
    assert.equal((await f.call(`/${mine}/delete-forever`, { method: 'POST' })).status, 404);
  } finally {
    await f.close();
  }
});

test('concurrent duplicate uploads publish one file and earlier pending reservations stay unpublished', async () => {
  const f = await setup();
  try {
    const duplicate = randomUUID();
    const raced = await Promise.all([f.upload(duplicate), f.upload(duplicate)]);
    assert.deepEqual(
      raced.map(result => [result.status, result.json().id]),
      [
        [200, duplicate],
        [200, duplicate],
      ],
    );
    assert.equal(f.object.objects.size, 1, 'the losing duplicate removes its own object');
    const legacy = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
      VALUES ($1,'file',$2,'Private.txt',$3,'text/plain',16,$4,false)`,
      [legacy, f.workspace.membershipId, randomUUID(), createHash('sha256').update('private contents').digest('hex')],
    );
    assert.equal(
      (await f.upload(legacy)).status,
      409,
      'a reservation left by the earlier upload flow is not published by a retry',
    );
    assert.equal(f.object.objects.size, 1);
  } finally {
    await f.close();
  }
});

test('team editors add children, managers organize them, and restricted ancestors stay concealed over HTTP', async () => {
  const f = await setup();
  try {
    const parent = await f.folder('Private ancestor'),
      id = randomUUID(),
      team = randomUUID();
    assert.equal((await f.upload(id, Buffer.from('private contents'), parent)).status, 200);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Files team')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      f.adminMembership,
      team,
    ]);
    const subject = { kind: 'team', id: team },
      admin = { cookie: f.signed.admin.cookie };
    assert.equal((await f.share(id, 'manager', subject)).status, 200);
    const snapshot = await f.call(`/${id}/sharing`, admin);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(
      snapshot.json().inherited.map(entry => entry.source),
      [{ kind: 'restricted' }],
    );
    assert.equal(snapshot.bytes.includes(Buffer.from('Private ancestor')), false);
    assert.equal(
      (await f.call(`/${id}`, { ...admin, method: 'PATCH', body: { name: 'Team managed' } })).json().name,
      'Team managed',
    );
    assert.equal((await f.share(parent, 'viewer', subject)).status, 200);
    const child = randomUUID(),
      folderBody = { name: 'Team folder', parentId: parent };
    assert.equal((await f.call(`/${child}/folder`, { ...admin, method: 'PUT', body: folderBody })).status, 404);
    assert.equal((await f.share(parent, 'editor', subject)).status, 200);
    assert.equal((await f.call(`/${child}/folder`, { ...admin, method: 'PUT', body: folderBody })).status, 200);
    const added = randomUUID();
    assert.equal(
      (
        await f.call(f.uploadPath(added, 'Editor.txt', child), {
          ...admin,
          method: 'PUT',
          body: Buffer.from('editor content'),
        })
      ).status,
      200,
    );
    assert.deepEqual((await f.call(`/${added}/content`)).bytes, Buffer.from('editor content'));
    assert.equal((await f.share(parent, null, subject)).status, 200);
    assert.deepEqual((await f.call(`/${id}/content`, admin)).bytes, Buffer.from('private contents'));
    assert.equal((await f.share(id, null, subject)).status, 200);
    assert.equal((await f.call(`/${id}/content`, admin)).status, 404);
  } finally {
    await f.close();
  }
});

test('HTTP rejects malformed metadata and authority fields without reserving or writing objects', async () => {
  const f = await setup();
  try {
    for (const [path, method, body] of [
      ['?trash=maybe', 'GET'],
      ['?unknown=value', 'GET'],
      ['/not-a-uuid', 'GET'],
      [`/${randomUUID()}/folder`, 'PUT', { name: 'x', parentId: null, creatorMembershipId: f.adminMembership }],
      [`/${randomUUID()}/folder`, 'PUT', { name: '../unsafe', parentId: null }],
      [`/${randomUUID()}/parent`, 'PUT', { parentId: null }],
      [`/${randomUUID()}/sharing`, 'PUT', { subject: { kind: 'public', id: randomUUID() }, role: 'viewer' }],
      [`/${randomUUID()}/content?name=x&mediaType=bad`, 'PUT', Buffer.from('x')],
    ]) {
      const result = await f.call(path, { method, body });
      assert.equal(result.status, 400, result.bytes.toString());
      assert.deepEqual(result.json(), { error: 'invalid-request' });
    }
    assert.equal(f.object.requests.length, 0);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table('tf_files')}`)).rows[0].count,
      0,
    );
    assert.equal((await f.upload()).status, 200);
  } finally {
    await f.close();
  }
});

test('real HTTP bounds chunked uploads, authenticates before body consumption, and releases transfer slots', async () => {
  const f = await setup();
  try {
    const limit = 10 * 1024 * 1024;
    assert.equal((await f.upload(randomUUID(), Buffer.alloc(limit, 42))).status, 200);
    assert.equal((await f.upload(randomUUID(), Buffer.alloc(limit + 1))).status, 413);
    assert.equal((await f.upload(randomUUID(), Buffer.alloc(0))).status, 413);
    assert.equal(
      (
        await f.call(`/${randomUUID()}/folder`, {
          method: 'PUT',
          body: { name: 'x'.repeat(1_048_577), parentId: null },
        })
      ).status,
      413,
    );
    function stream(cookie, chunks, complete = true) {
      let request;
      const result = new Promise((resolve, reject) => {
        request = httpRequest(
          `${f.origin}${f.base}${f.uploadPath(randomUUID())}`,
          {
            method: 'PUT',
            agent: false,
            headers: {
              origin: 'http://localhost:5173',
              cookie,
              'content-type': 'application/octet-stream',
              'transfer-encoding': 'chunked',
            },
          },
          response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          },
        );
        request.on('error', reject);
        request.flushHeaders();
        for (const chunk of chunks) request.write(chunk);
        if (complete) request.end();
      });
      return { request, result };
    }
    const anonymous = stream('', [], false);
    assert.equal(await anonymous.result, 401);
    anonymous.request.destroy();
    assert.equal(await stream(f.signed.owner.cookie, [Buffer.alloc(limit), Buffer.from('x')]).result, 413);
    const held = Array.from({ length: 4 }, () => stream(f.signed.owner.cookie, [Buffer.from('x')], false));
    for (const item of held) item.result.catch(() => {});
    try {
      for (let attempt = 0; attempt < 100 && !held.every(item => f.parsing.has(item.request.path)); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(
        held.every(item => f.parsing.has(item.request.path)),
        true,
        'all four uploads admitted before probing capacity',
      );
      const busy = await f.call(`/${randomUUID()}/content`);
      assert.equal(busy.status, 503);
      assert.deepEqual(busy.json(), { error: 'file-busy' });
      held[0].request.destroy();
      await assert.rejects(held[0].result);
      for (const item of held.slice(1)) item.request.end();
      assert.deepEqual(await Promise.all(held.slice(1).map(item => item.result)), [200, 200, 200]);
    } finally {
      for (const item of held) item.request.destroy();
    }
    assert.equal((await f.upload()).status, 200);
  } finally {
    await f.close();
  }
});

test('default current aggregate serves Files through HTTP and signed object transport', async () => {
  const f = await setup();
  try {
    assert.deepEqual(
      f.stream.map(item => item.name),
      ['0001_baseline.sql', '0002_turn_trace.sql', '0003_chat_send_timing.sql', '0004_social.sql'],
    );
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table('tf_common_migrations')}`)).rows[0]
        .count,
      f.stream.length,
    );
    const result = await f.upload();
    assert.equal(result.status, 200, result.bytes.toString());
    assert.equal(f.object.objects.size, 1);
    assert.deepEqual((await f.call(`/${result.json().id}/content`)).bytes, Buffer.from('private contents'));
  } finally {
    await f.close();
  }
});
