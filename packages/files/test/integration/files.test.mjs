import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied, lockAuthorization } from '@tulipfarm/access';
import { createFiles, FileError, readableFileSql, recordFileUse, requireReadableFile } from '../../src/index.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sharingGraphLimits } from '../../src/sharing.ts';

async function setup() {
  const db = await fixture();
  let runtime;
  try {
    const stream = db.baseline;
    const w = await db.create(stream);
    const other = await db.create(stream);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(id === w.id ? w : other),
      }),
    });
    const table = name => qualified(w.names.schema, name);
    const members = {};
    for (const name of ['admin', 'viewer', 'editor', 'manager', 'unrelated']) {
      members[name] = randomUUID();
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
        members[name],
        name,
        name === 'admin' ? 'admin' : 'member',
      ]);
    }
    const objects = new Map();
    const bytes = {
      putIfAbsent: async (key, body) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(body));
      },
      read: async key => {
        const body = objects.get(key);
        assert.ok(body);
        return Buffer.from(body);
      },
      remove: async key => {
        objects.delete(key);
      },
    };
    const files = createFiles(runtime, bytes);
    const folder = (name, parentId = null, user = w.userId) =>
      files.createFolder(w.id, user, randomUUID(), { name, parentId });
    const upload = (name, parentId = null, user = w.userId) =>
      files.upload(
        w.id,
        user,
        randomUUID(),
        { name, parentId, mediaType: 'text/plain' },
        Buffer.from('private contents'),
      );
    const grant = (id, name, role) => files.share(w.id, w.userId, id, { kind: 'individual', id: members[name] }, role);
    const move = async (id, parentId, user = w.userId) => {
      const preview = await files.previewMove(w.id, user, id, parentId);
      return files.move(w.id, user, id, parentId, preview.fingerprint);
    };
    const close = async () => {
      await runtime.close();
      await db.close();
    };
    return { db, w, other, runtime, table, members, objects, bytes, files, folder, upload, grant, move, close };
  } catch (error) {
    await runtime?.close();
    await db.close();
    throw error;
  }
}

test('personal files deny admins, guessed identities and cross-workspace users; grants combine recursively', async () => {
  const f = await setup();
  try {
    const root = await f.folder('Root');
    const nested = await f.folder('Nested', root.id);
    const file = await f.upload('Secret.txt', nested.id);
    assert.equal((await f.files.read(f.w.id, f.w.userId, file.id)).name, 'Secret.txt');
    for (const user of ['admin', 'unrelated']) {
      assert.deepEqual(await f.files.list(f.w.id, user), { items: [], next: null });
      await assert.rejects(f.files.read(f.w.id, user, file.id), AccessDenied);
      await assert.rejects(f.files.download(f.w.id, user, file.id), AccessDenied);
    }
    await assert.rejects(f.files.read(f.other.id, f.other.userId, file.id), AccessDenied);
    const missing = randomUUID();
    assert.deepEqual(
      (await f.files.summaries(f.w.id, f.w.userId, [file.id, missing, nested.id, file.id])).items.map(
        item => item.name,
      ),
      ['Secret.txt', 'Nested'],
    );
    assert.deepEqual(await f.files.summaries(f.w.id, 'unrelated', [file.id, nested.id]), { items: [] });
    await f.grant(root.id, 'viewer', 'viewer');
    assert.deepEqual(
      (await f.files.list(f.w.id, 'viewer', { parentId: nested.id })).items.map(item => item.name),
      ['Secret.txt'],
    );
    assert.equal((await f.files.download(f.w.id, 'viewer', file.id)).bytes.toString(), 'private contents');
    assert.equal((await f.files.read(f.w.id, 'viewer', file.id)).role, 'viewer');
    await f.grant(file.id, 'viewer', 'editor');
    assert.equal((await f.files.read(f.w.id, 'viewer', file.id)).role, 'editor');
    await f.grant(root.id, 'viewer', null);
    assert.equal((await f.files.read(f.w.id, 'viewer', file.id)).role, 'editor');
    await assert.rejects(f.files.read(f.w.id, 'viewer', nested.id), AccessDenied);
    await f.grant(file.id, 'viewer', null);
    await assert.rejects(f.files.read(f.w.id, 'viewer', file.id), AccessDenied);
    assert.deepEqual(
      await f.files.summaries(f.w.id, 'viewer', [file.id]),
      { items: [] },
      'Revoked access drops the summary',
    );
    await assert.rejects(
      f.files.share(f.w.id, f.w.userId, file.id, { kind: 'individual', id: f.other.membershipId }, 'viewer'),
      AccessDenied,
    );
  } finally {
    await f.close();
  }
});

test('viewer and editor cannot share or reorganize; managers can; creator ownership survives sharing', async () => {
  const f = await setup();
  try {
    const root = await f.folder('Shared');
    const file = await f.upload('Original', root.id);
    for (const name of ['viewer', 'editor', 'manager']) await f.grant(root.id, name, name);
    for (const user of ['viewer', 'editor']) {
      await assert.rejects(
        f.files.share(f.w.id, user, file.id, { kind: 'individual', id: f.members.admin }, 'manager'),
        AccessDenied,
      );
      await assert.rejects(f.files.rename(f.w.id, user, file.id, 'Renamed'), AccessDenied);
      await assert.rejects(f.move(file.id, null, user), AccessDenied);
      await assert.rejects(f.files.trash(f.w.id, user, file.id, true), AccessDenied);
    }
    await assert.rejects(f.folder('No', root.id, 'viewer'), AccessDenied);
    const subfolder = await f.folder('Editor folder', root.id, 'editor');
    const added = await f.upload('Editor file', subfolder.id, 'editor');
    assert.equal((await f.files.read(f.w.id, 'viewer', added.id)).role, 'viewer');
    await f.files.share(f.w.id, 'manager', file.id, { kind: 'individual', id: f.members.admin }, 'viewer');
    assert.equal((await f.files.read(f.w.id, 'admin', file.id)).name, 'Original');
    assert.equal((await f.files.rename(f.w.id, 'manager', file.id, 'Renamed')).id, file.id);
    await f.files.share(f.w.id, 'manager', file.id, { kind: 'individual', id: f.w.membershipId }, 'viewer');
    assert.equal((await f.files.read(f.w.id, f.w.userId, file.id)).role, 'manager');
  } finally {
    await f.close();
  }
});

test('moves recompute inherited grants, preserve direct grants and identities, reject cycles and unauthorized destinations', async () => {
  const f = await setup();
  try {
    const source = await f.folder('Source'),
      target = await f.folder('Target');
    const nested = await f.folder('Nested', source.id),
      file = await f.upload('Duplicate', nested.id);
    await f.upload('Duplicate');
    await f.grant(source.id, 'viewer', 'viewer');
    await f.grant(target.id, 'editor', 'editor');
    await f.grant(file.id, 'manager', 'viewer');
    await f.move(nested.id, target.id);
    await assert.rejects(f.files.read(f.w.id, 'viewer', file.id), AccessDenied);
    assert.equal((await f.files.read(f.w.id, 'editor', file.id)).role, 'editor');
    assert.equal((await f.files.read(f.w.id, 'manager', file.id)).role, 'viewer');
    assert.equal((await f.files.rename(f.w.id, f.w.userId, file.id, 'Renamed')).id, file.id);
    await assert.rejects(f.move(target.id, nested.id), error => error.code === 'invalid-move');
    await assert.rejects(f.move(nested.id, nested.id), error => error.code === 'invalid-move');
    await assert.rejects(f.move(nested.id, file.id), error => error.code === 'invalid-move');
    const privateDestination = await f.folder('Private', null, 'unrelated');
    await assert.rejects(f.move(file.id, privateDestination.id), AccessDenied);
    assert.equal((await f.files.read(f.w.id, f.w.userId, file.id)).parentId, nested.id);
    const a = await f.folder('a'),
      b = await f.folder('b');
    const previews = await Promise.all([
      f.files.previewMove(f.w.id, f.w.userId, a.id, b.id),
      f.files.previewMove(f.w.id, f.w.userId, b.id, a.id),
    ]);
    const race = await Promise.allSettled([
      f.files.move(f.w.id, f.w.userId, a.id, b.id, previews[0].fingerprint),
      f.files.move(f.w.id, f.w.userId, b.id, a.id, previews[1].fingerprint),
    ]);
    assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(race.filter(value => value.status === 'rejected' && value.reason.code === 'invalid-move').length, 1);
  } finally {
    await f.close();
  }
});

test('Trash hides descendants from reads, downloads and search; restoring a parent preserves separately trashed children', async () => {
  const f = await setup();
  try {
    const parent = await f.folder('Parent'),
      file = await f.upload('Child', parent.id),
      hidden = await f.upload('Hidden', parent.id);
    await f.grant(parent.id, 'viewer', 'viewer');
    await f.files.trash(f.w.id, f.w.userId, hidden.id, true);
    await f.files.trash(f.w.id, f.w.userId, parent.id, true);
    assert.deepEqual(await f.files.list(f.w.id, 'viewer'), { items: [], next: null });
    assert.deepEqual(
      (await f.files.list(f.w.id, f.w.userId, { trash: true })).items.map(item => item.name),
      ['Parent'],
    );
    await assert.rejects(f.files.download(f.w.id, f.w.userId, file.id), AccessDenied);
    await assert.rejects(f.files.trash(f.w.id, f.w.userId, hidden.id, false), AccessDenied);
    await f.files.trash(f.w.id, f.w.userId, parent.id, false);
    assert.equal((await f.files.download(f.w.id, 'viewer', file.id)).bytes.toString(), 'private contents');
    await assert.rejects(f.files.read(f.w.id, f.w.userId, hidden.id), AccessDenied);
    await f.files.trash(f.w.id, f.w.userId, hidden.id, false);
    assert.equal((await f.files.read(f.w.id, 'viewer', hidden.id)).name, 'Hidden');
  } finally {
    await f.close();
  }
});

test('membership incarnations and team removal revoke access while independent grants survive', async () => {
  const f = await setup();
  try {
    const file = await f.upload('Membership');
    const team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Team')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      f.members.viewer,
      team,
    ]);
    await f.files.share(f.w.id, f.w.userId, file.id, { kind: 'team', id: team }, 'editor');
    await f.grant(file.id, 'viewer', 'viewer');
    assert.equal((await f.files.read(f.w.id, 'viewer', file.id)).role, 'editor');
    await f.db.platform.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id = $1`, [f.members.viewer]);
    assert.equal((await f.files.read(f.w.id, 'viewer', file.id)).role, 'viewer');
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      f.members.viewer,
    ]);
    await assert.rejects(f.files.read(f.w.id, 'viewer', file.id), AccessDenied);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'viewer','admin')`,
      [randomUUID()],
    );
    await assert.rejects(f.files.read(f.w.id, 'viewer', file.id), AccessDenied);
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      f.w.membershipId,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      f.w.userId,
    ]);
    await assert.rejects(f.files.read(f.w.id, f.w.userId, file.id), AccessDenied);
  } finally {
    await f.close();
  }
});

test('explicit file use drives membership-isolated recent file suggestions without read side effects', async () => {
  const f = await setup();
  try {
    const files = [];
    for (const name of ['One.txt', 'Two.txt', 'Three.txt', 'Four.txt', 'Five.txt', 'Six.txt'])
      files.push(await f.upload(name));
    await f.grant(files[0].id, 'viewer', 'viewer');

    assert.deepEqual(await f.files.suggestions(f.w.id, 'viewer', { query: '' }), { items: [], next: null });
    assert.deepEqual((await f.db.platform.query(`SELECT * FROM ${f.table('tf_file_usage')}`)).rows, []);

    await f.runtime.transaction(f.w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      await recordFileUse(tx, { kind: 'human', userId: f.w.userId, membershipId: f.w.membershipId }, files[0].id);
    });
    for (const file of files.slice(1)) await f.files.recordRecentUse(f.w.id, f.w.userId, file.id);
    await f.files.recordRecentUse(f.w.id, 'viewer', files[0].id);
    assert.deepEqual(
      (await f.files.suggestions(f.w.id, f.w.userId, { query: '' })).items.map(item => item.name),
      ['Six.txt', 'Five.txt', 'Four.txt', 'Three.txt', 'Two.txt'],
    );
    assert.deepEqual(
      (await f.files.suggestions(f.w.id, 'viewer', { query: '' })).items.map(item => item.name),
      ['One.txt'],
    );

    await f.files.trash(f.w.id, f.w.userId, files[5].id, true);
    assert.deepEqual(
      (await f.files.suggestions(f.w.id, f.w.userId, { query: '' })).items.map(item => item.name),
      ['Five.txt', 'Four.txt', 'Three.txt', 'Two.txt', 'One.txt'],
    );

    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
      f.members.viewer,
    ]);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'viewer','member')`,
      [randomUUID()],
    );
    assert.deepEqual(await f.files.suggestions(f.w.id, 'viewer', { query: '' }), { items: [], next: null });
  } finally {
    await f.close();
  }
});

test('typed suggestions search every readable file, exclude folders, and page eight stable filename matches', async () => {
  const f = await setup();
  try {
    const folder = await f.folder('Report folder');
    const files = [];
    for (const name of [
      'Report 09.txt',
      'Report 02.txt',
      'Report 08.txt',
      'Report 01.txt',
      'Report 07.txt',
      'Report 03.txt',
      'Report 06.txt',
      'Report 04.txt',
      'Report 05.txt',
    ])
      files.push(await f.upload(name));
    await f.upload('Unrelated.txt');
    await f.grant(folder.id, 'viewer', 'viewer');
    for (const file of files) await f.grant(file.id, 'viewer', 'viewer');

    const first = await f.files.suggestions(f.w.id, 'viewer', { query: 'REPORT' });
    assert.deepEqual(
      first.items.map(item => item.name),
      [
        'Report 01.txt',
        'Report 02.txt',
        'Report 03.txt',
        'Report 04.txt',
        'Report 05.txt',
        'Report 06.txt',
        'Report 07.txt',
        'Report 08.txt',
      ],
    );
    assert.equal(first.next, first.items.at(-1).id);
    const second = await f.files.suggestions(f.w.id, 'viewer', { query: 'report', after: first.next });
    assert.deepEqual(
      second.items.map(item => item.name),
      ['Report 09.txt'],
    );
    assert.equal(second.next, null);
  } finally {
    await f.close();
  }
});

test('uploads recover lost acknowledgements, conceal incomplete files, verify immutable bytes and retain Trash quota', async () => {
  const f = await setup();
  try {
    const id = randomUUID(),
      content = Buffer.from('verified');
    const input = { name: 'Report', parentId: null, mediaType: 'text/plain' };
    let fail = true;
    const bytes = {
      ...f.bytes,
      putIfAbsent: async (key, body) => {
        await f.bytes.putIfAbsent(key, body);
        if (fail) {
          fail = false;
          throw new Error('lost acknowledgement');
        }
      },
    };
    let files = createFiles(f.runtime, bytes, { quotaBytes: 8 });
    await assert.rejects(files.upload(f.w.id, f.w.userId, id, input, content), /lost acknowledgement/);
    assert.deepEqual(await files.list(f.w.id, f.w.userId), { items: [], next: null });
    await assert.rejects(files.download(f.w.id, f.w.userId, id), AccessDenied);
    files = createFiles(f.runtime, bytes, { quotaBytes: 8 });
    assert.equal((await files.upload(f.w.id.toUpperCase(), f.w.userId, id, input, content)).id, id);
    assert.equal((await files.upload(f.w.id, f.w.userId, id, input, content)).id, id);
    assert.equal(f.objects.size, 1);
    assert.equal((await files.download(f.w.id, f.w.userId, id)).bytes.toString(), 'verified');
    assert.equal((await files.download(f.w.id.toUpperCase(), f.w.userId, id)).bytes.toString(), 'verified');
    await assert.rejects(
      files.upload(f.w.id, f.w.userId, id, input, Buffer.from('replaced')),
      error => error.code === 'conflict',
    );
    await files.trash(f.w.id, f.w.userId, id, true);
    await assert.rejects(
      files.upload(f.w.id, f.w.userId, randomUUID(), input, content),
      error => error.code === 'quota',
    );
    await files.trash(f.w.id, f.w.userId, id, false);
    const corrupt = createFiles(f.runtime, { ...bytes, read: async () => Buffer.from('tampered') });
    await assert.rejects(corrupt.download(f.w.id, f.w.userId, id), error => error.code === 'integrity');
    const login = await connect(f.db.login(f.w));
    try {
      await denied(login, `UPDATE ${f.table('tf_files')} SET object_key = $1`, [randomUUID()]);
      await denied(login, `UPDATE ${f.table('tf_files')} SET creator_membership_id = $1`, [f.members.admin]);
      await denied(login, `DELETE FROM ${f.table('tf_files')}`);
    } finally {
      await login.end();
    }
  } finally {
    await f.close();
  }
});

test('imports recognize a replay by recorded source without loading again and reject a different source under the same id', async () => {
  const f = await setup();
  try {
    const id = randomUUID(),
      target = { name: 'Plan.pdf', parentId: null };
    const source = fileId => ({ provider: 'google-drive', accountId: 'account-a', fileId, format: 'pdf' });
    const loads = [];
    const load = (text, version) => async () => {
      loads.push(text);
      return { mediaType: 'application/pdf', content: Buffer.from(text), version };
    };
    const first = await f.files.importFile(f.w.id, f.w.userId, id, target, source('doc-1'), load('first read', '42'));
    assert.deepEqual([first.id, first.size, first.mediaType], [id, 10, 'application/pdf']);
    assert.equal(
      (await f.files.importFile(f.w.id, f.w.userId, id, target, source('doc-1'), load('changed source'))).size,
      10,
    );
    await assert.rejects(
      f.files.importFile(f.w.id, f.w.userId, id, target, source('doc-2'), load('other source')),
      error => error.code === 'conflict',
    );
    await assert.rejects(
      f.files.importFile(
        f.w.id,
        f.w.userId,
        id,
        target,
        { ...source('doc-1'), accountId: 'account-b' },
        load('other account'),
      ),
      error => error.code === 'conflict',
    );
    await assert.rejects(
      f.files.importFile(f.w.id, f.w.userId, id, { ...target, name: 'Renamed.pdf' }, source('doc-1'), load('renamed')),
      error => error.code === 'conflict',
    );
    assert.deepEqual(loads, ['first read']);
    assert.equal((await f.files.download(f.w.id, f.w.userId, id)).bytes.toString(), 'first read');
    const recorded = (
      await f.db.platform.query(
        `SELECT provider, account_id, source_file_id, format, source_version, read_at IS NOT NULL AS read FROM ${f.table('tf_file_copy_sources')} WHERE file_id = $1`,
        [id],
      )
    ).rows;
    assert.deepEqual(recorded, [
      {
        provider: 'google-drive',
        account_id: 'account-a',
        source_file_id: 'doc-1',
        format: 'pdf',
        source_version: '42',
        read: true,
      },
    ]);
    await assert.rejects(
      f.files.importFile(f.w.id, f.w.userId, randomUUID(), target, source('doc-3'), async () => {
        throw new Error('source failed');
      }),
      /source failed/,
    );
    await assert.rejects(
      f.files.importFile(f.w.id, f.w.userId, randomUUID(), target, source('doc-4'), load('')),
      error => error.code === 'size',
    );
    assert.equal(f.objects.size, 1);
    assert.equal(
      (await f.db.platform.query(`SELECT count(*)::integer AS count FROM ${f.table('tf_files')}`)).rows[0].count,
      1,
    );
  } finally {
    await f.close();
  }
});

test('copies made before provenance rows still replay by their legacy object key', async () => {
  const f = await setup();
  try {
    const source = { provider: 'google-drive', accountId: 'account-a', fileId: 'legacy-doc', format: 'docx' };
    const hash = createHash('sha256')
      .update(JSON.stringify(['google-drive', 'account-a', 'legacy-doc', 'docx']))
      .digest();
    hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
    const hex = hash.subarray(0, 8).toString('hex') + '8'.repeat(16);
    const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const id = randomUUID(),
      content = Buffer.from('legacy copy');
    f.objects.set(`${f.w.id}/files/${key}`, content);
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,name,object_key,media_type,size,sha256,ready)
      VALUES ($1,'file',$2,'Legacy.docx',$3,'application/octet-stream',$4,$5,true)`,
      [id, f.w.membershipId, key, content.byteLength, createHash('sha256').update(content).digest('hex')],
    );
    const target = { name: 'Legacy.docx', parentId: null };
    const never = async () => {
      throw new Error('replay must not read Google');
    };
    assert.equal((await f.files.importFile(f.w.id, f.w.userId, id, target, source, never)).id, id);
    await assert.rejects(
      f.files.importFile(f.w.id, f.w.userId, id, target, { ...source, format: 'pdf' }, never),
      error => error.code === 'conflict',
    );
  } finally {
    await f.close();
  }
});

test('download rechecks access after object IO and failed final upload authorization stays hidden', async () => {
  const f = await setup();
  try {
    const file = await f.upload('Revoked');
    await f.grant(file.id, 'viewer', 'viewer');
    const reader = createFiles(f.runtime, {
      ...f.bytes,
      read: async (...args) => {
        const body = await f.bytes.read(...args);
        await f.grant(file.id, 'viewer', null);
        return body;
      },
    });
    await assert.rejects(reader.download(f.w.id, 'viewer', file.id), AccessDenied);
    const parent = await f.folder('Upload destination');
    await f.grant(parent.id, 'editor', 'editor');
    const writer = createFiles(f.runtime, {
      ...f.bytes,
      putIfAbsent: async (...args) => {
        await f.bytes.putIfAbsent(...args);
        await f.grant(parent.id, 'editor', null);
      },
    });
    await assert.rejects(
      writer.upload(
        f.w.id,
        'editor',
        randomUUID(),
        { name: 'Failed', parentId: parent.id, mediaType: 'text/plain' },
        Buffer.from('private'),
      ),
      AccessDenied,
    );
    assert.deepEqual(await f.files.list(f.w.id, 'editor'), { items: [], next: null });
  } finally {
    await f.close();
  }
});

test('read waits for a concurrent authorization writer and evaluates the committed revocation', async () => {
  const f = await setup();
  const connection = await connect(f.db.login(f.w));
  try {
    const file = await f.upload('Locked');
    await f.grant(file.id, 'viewer', 'viewer');
    await connection.query('BEGIN');
    await lockAuthorization({ client: connection, schema: f.w.names.schema }, 'write');
    await connection.query(`DELETE FROM ${f.table('tf_file_grants')} WHERE item_id = $1`, [file.id]);
    const result = f.files.read(f.w.id, 'viewer', file.id);
    const rejected = assert.rejects(result, AccessDenied);
    await connection.query('COMMIT');
    await rejected;
    assert.equal((await f.files.read(f.w.id, f.w.userId, file.id)).name, 'Locked');
  } finally {
    await connection.end();
    await f.close();
  }
});

test('schema rejects invalid immutable file metadata rather than accepting SQL NULL checks', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')}
      (id,kind,creator_membership_id,name,object_key,media_type,ready) VALUES ($1,'file',$2,'Broken',$3,'text/plain',true)`,
        [randomUUID(), f.w.membershipId, randomUUID()],
      ),
      error => error.code === '23514',
    );
    assert.equal((await f.upload('Valid')).size, 16);
    await assert.rejects(
      f.files.upload(
        f.w.id,
        f.w.userId,
        randomUUID(),
        { name: 'Empty', parentId: null, mediaType: 'text/plain' },
        Buffer.alloc(0),
      ),
      FileError,
    );
  } finally {
    await f.close();
  }
});

test('Files migration composes once with the default aggregate and runtime admits it', async () => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const main = await workspaceTableMigrations();
    const migrations = main;
    assert.deepEqual(migrations, main);
    assert.equal(migrations.length, 10);
    const w = await db.create(migrations);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const files = createFiles(runtime, {
      putIfAbsent: async () => {},
      read: async () => Buffer.from('content'),
      remove: async () => {},
    });
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS count FROM ${qualified(w.names.schema, 'tf_common_migrations')}`,
        )
      ).rows[0].count,
      migrations.length,
    );
    const folder = await files.createFolder(w.id, w.userId, randomUUID(), { name: 'Installed', parentId: null });
    assert.equal(folder.name, 'Installed');
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::integer AS count FROM ${qualified(w.names.schema, 'tf_conversation_attachments')}`,
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test('search pagination exposes only readable identities and returns every authorized duplicate', async () => {
  const f = await setup();
  try {
    const root = await f.folder('Search root');
    await f.grant(root.id, 'viewer', 'viewer');
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready)
      SELECT gen_random_uuid(),'folder',$1,$2,'Duplicate',true FROM generate_series(1,105)`,
      [f.w.membershipId, root.id],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,name,ready)
      SELECT gen_random_uuid(),'folder',$1,'Duplicate',true FROM generate_series(1,105)`,
      [f.w.membershipId],
    );
    const first = await f.files.list(f.w.id, 'viewer', { query: 'dUPlicate' });
    assert.equal(first.items.length, 100);
    assert.equal(first.next, first.items.at(-1).id);
    const second = await f.files.list(f.w.id, 'viewer', { query: 'dUPlicate', after: first.next });
    assert.equal(second.items.length, 5);
    assert.equal(second.next, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 105);
    assert.equal(
      [...first.items, ...second.items].every(item => item.parentId === root.id && item.name === 'Duplicate'),
      true,
    );
    assert.deepEqual(await f.files.list(f.w.id, 'unrelated', { query: 'Duplicate' }), { items: [], next: null });
  } finally {
    await f.close();
  }
});

const reference = item => ({ kind: 'readable', id: item.id, name: item.name });
const sortedAudience = entries =>
  entries
    .map(([membershipId, role]) => ({ membershipId, role }))
    .sort((a, b) => a.membershipId.localeCompare(b.membershipId));
const conflict = error => error instanceof FileError && error.code === 'conflict';

async function addMembers(f, count) {
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role)
    SELECT gen_random_uuid(), 'bulk-' || n, 'member' FROM generate_series(1,$1::int) n`,
    [count],
  );
}

async function addChildren(f, id, count) {
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready)
    SELECT gen_random_uuid(),'folder',$1,$2,'Bulk child',true FROM generate_series(1,$3::int)`,
    [f.w.membershipId, id, count],
  );
}

async function addGrants(f, id, count) {
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_file_grants')} (item_id,subject_kind,subject_id,role)
    SELECT $1,'individual',gen_random_uuid(),'viewer' FROM generate_series(1,$2::int)`,
    [id, count],
  );
}

for (const [name, enlarge, sharingOverLimit] of [
  ['items', (f, source) => addChildren(f, source.id, sharingGraphLimits.items), false],
  ['grants', (f, source) => addGrants(f, source.id, sharingGraphLimits.grants), true],
  ['memberships', f => addMembers(f, sharingGraphLimits.memberships - 5), true],
  [
    'teams',
    f =>
      f.db.platform.query(
        `INSERT INTO ${f.table('tf_teams')} (id,name)
    SELECT gen_random_uuid(),'Bulk team ' || n FROM generate_series(1,$1::int) n`,
        [sharingGraphLimits.teams + 1],
      ),
    true,
  ],
  [
    'enrollments',
    async f => {
      await addMembers(f, 100);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name)
      SELECT gen_random_uuid(),'Bulk team ' || n FROM generate_series(1,200) n`);
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id)
      SELECT m.id,t.id FROM ${f.table('tf_memberships')} m CROSS JOIN ${f.table('tf_teams')} t LIMIT $1`,
        [sharingGraphLimits.enrollments + 1],
      );
    },
    true,
  ],
  [
    'audience entries',
    async (f, source) => {
      await addMembers(f, 994);
      await addChildren(f, source.id, 99);
      const exact = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
      assert.equal(exact.subtree.length, 100);
      assert.deepEqual(
        exact.subtree.find(entry => entry.item.id === source.id).before.audience,
        sortedAudience([
          [f.w.membershipId, 'manager'],
          [f.members.viewer, 'viewer'],
        ]),
      );
      await addChildren(f, source.id, 1);
    },
    false,
  ],
  [
    'role checks',
    async (f, source) => {
      await addMembers(f, 994);
      await addGrants(f, source.id, sharingGraphLimits.grants - 1);
    },
    true,
  ],
  [
    'lineage',
    async (f, source, destination) => {
      await f.db.platform.query(
        `WITH ids AS MATERIALIZED (
      SELECT n,gen_random_uuid() AS id FROM generate_series(1,$3::int) n
    ) INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready)
      SELECT current.id,'folder',$1,COALESCE(previous.id,$2::uuid),'Deep folder',true
      FROM ids current LEFT JOIN ids previous ON previous.n = current.n - 1`,
        [f.w.membershipId, source.id, sharingGraphLimits.lineage - 1],
      );
      const exact = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
      assert.equal(exact.subtree.length, 128);
      await assert.rejects(
        f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id),
        error => error instanceof FileError && error.code === 'graph-limit',
      );
    },
    false,
  ],
])
  test(`sharing graph refuses excessive ${name} without changing move state`, async () => {
    const f = await setup();
    try {
      const source = await f.folder('Source'),
        destination = await f.folder('Destination');
      await f.grant(source.id, 'viewer', 'viewer');
      const preview = await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
      await enlarge(f, source, destination);
      const rows = async () => ({
        files: (await f.db.platform.query(`SELECT *,xmin::text AS version FROM ${f.table('tf_files')} ORDER BY id`))
          .rows,
        grants: (
          await f.db.platform.query(
            `SELECT *,xmin::text AS version FROM ${f.table('tf_file_grants')} ORDER BY item_id,subject_kind,subject_id`,
          )
        ).rows,
      });
      const before = await rows();
      const limited = error => error instanceof FileError && error.code === 'graph-limit';
      await assert.rejects(f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id), limited);
      await assert.rejects(f.files.move(f.w.id, f.w.userId, source.id, destination.id, preview.fingerprint), limited);
      if (sharingOverLimit) await assert.rejects(f.files.readSharing(f.w.id, f.w.userId, source.id), limited);
      assert.deepEqual(await rows(), before);
      assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
      assert.equal((await f.files.read(f.w.id, 'viewer', source.id)).role, 'viewer');
    } finally {
      await f.close();
    }
  });

test('actor-scoped source and destination authorization precede oversized graph reads', async () => {
  const f = await setup();
  try {
    const source = await f.folder('Source'),
      destination = await f.folder('Private destination', null, 'unrelated');
    const preview = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
    await addMembers(f, sharingGraphLimits.memberships);
    await assert.rejects(f.files.readSharing(f.w.id, 'unrelated', source.id), AccessDenied);
    for (const [user, parentId] of [
      ['unrelated', null],
      [f.w.userId, destination.id],
    ]) {
      await assert.rejects(f.files.previewMove(f.w.id, user, source.id, parentId), AccessDenied);
      await assert.rejects(f.files.move(f.w.id, user, source.id, parentId, preview.fingerprint), AccessDenied);
    }
    await assert.rejects(
      f.files.readSharing(f.w.id, f.w.userId, source.id),
      error => error instanceof FileError && error.code === 'graph-limit',
    );
    assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
  } finally {
    await f.close();
  }
});

test('initial sharing access bounds recursive production on valid 6001-item source and destination chains', async t => {
  const f = await setup();
  try {
    const root = await f.folder('Root'),
      shallow = await f.folder('Shallow');
    await f.grant(root.id, 'manager', 'manager');
    await f.grant(shallow.id, 'unrelated', 'manager');
    const ids = Array.from({ length: 6000 }, () => randomUUID());
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready)
      SELECT id,'folder',$1,COALESCE(lag(id) OVER (ORDER BY n),$2::uuid),'Deep folder',true
      FROM unnest($3::uuid[]) WITH ORDINALITY AS chain(id,n)`,
      [f.w.membershipId, root.id, ids],
    );
    const leaf = ids.at(-1);
    const observed = [];
    const files = createFiles(
      {
        transaction: (id, versions, operation) =>
          f.runtime.transaction(id, versions, tx =>
            operation({
              ...tx,
              client: {
                query: async (...args) => {
                  const result = await tx.client.query(...args);
                  observed.push({ args, rows: result.rows });
                  return result;
                },
              },
            }),
          ),
      },
      f.bytes,
    );
    const before = (
      await f.db.platform.query(`SELECT id,parent_id,xmin::text AS version FROM ${f.table('tf_files')} ORDER BY id`)
    ).rows;
    const fingerprint = 'files-move-v1:' + '0'.repeat(64);
    function recursiveNodes(plan) {
      return [
        ...(plan['Node Type'] === 'Recursive Union' ? [plan] : []),
        ...(plan.Plans ?? []).flatMap(recursiveNodes),
      ];
    }
    for (const user of [f.w.userId, 'manager', 'unrelated']) {
      for (const [name, operation] of [
        ['source readSharing', () => files.readSharing(f.w.id, user, leaf)],
        ['source previewMove', () => files.previewMove(f.w.id, user, leaf, null)],
        ['source move', () => files.move(f.w.id, user, leaf, null, fingerprint)],
      ]) {
        observed.length = 0;
        await assert.rejects(operation(), error => error instanceof FileError && error.code === 'graph-limit');
        assert.deepEqual(
          observed.filter(query => query.args[0].includes('WITH RECURSIVE')).map(query => query.rows.length),
          [129],
        );
        const overflow = observed.at(-1);
        assert.equal(overflow.rows.length, 129);
        assert.deepEqual(Object.keys(overflow.rows[0]).sort(), ['id', 'parent_id']);
        const plan = (await f.db.platform.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + overflow.args[0], overflow.args[1]))
          .rows[0]['QUERY PLAN'][0].Plan;
        assert.deepEqual(
          recursiveNodes(plan).map(node => node['Actual Rows'] * node['Actual Loops']),
          [129],
        );
        t.diagnostic(
          `${name}, ${user === f.w.userId ? 'creator' : user}: returned 129 ID pairs, produced 129 recursive rows, no subsequent query`,
        );
      }
    }
    for (const user of [f.w.userId, 'unrelated']) {
      for (const name of ['previewMove', 'move']) {
        observed.length = 0;
        await assert.rejects(
          files[name](f.w.id, user, shallow.id, leaf, fingerprint),
          error => error instanceof FileError && error.code === 'graph-limit',
        );
        const recursive = observed.filter(query => query.args[0].includes('WITH RECURSIVE'));
        assert.deepEqual(
          recursive.map(query => query.rows.length),
          [1, 129],
        );
        const overflow = observed.at(-1);
        assert.equal(overflow, recursive[1]);
        assert.deepEqual(Object.keys(overflow.rows[0]).sort(), ['id', 'parent_id']);
        const plan = (await f.db.platform.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + overflow.args[0], overflow.args[1]))
          .rows[0]['QUERY PLAN'][0].Plan;
        assert.deepEqual(
          recursiveNodes(plan).map(node => node['Actual Rows'] * node['Actual Loops']),
          [129],
        );
        t.diagnostic(
          `destination ${name}, ${user === f.w.userId ? 'creator' : user}: recursive results [1,129], overflow produced 129 rows, no subsequent query`,
        );
      }
    }
    assert.deepEqual(
      (await f.db.platform.query(`SELECT id,parent_id,xmin::text AS version FROM ${f.table('tf_files')} ORDER BY id`))
        .rows,
      before,
    );
    assert.equal((await f.files.read(f.w.id, 'manager', leaf)).role, 'manager');
    await assert.rejects(f.files.read(f.w.id, 'unrelated', leaf), AccessDenied);
    const boundary = ids[126];
    assert.equal((await files.readSharing(f.w.id, 'manager', boundary)).inherited.length, 128);
    await assert.rejects(files.readSharing(f.w.id, 'unrelated', boundary), AccessDenied);
    await f.files.trash(f.w.id, f.w.userId, root.id, true);
    await assert.rejects(files.readSharing(f.w.id, f.w.userId, boundary), AccessDenied);
  } finally {
    await f.close();
  }
});

test('sharing readback separates direct grants, inherited grants and current ancestor ownership without leaking restricted ancestors', async () => {
  const f = await setup();
  try {
    const root = await f.folder('Confidential ancestor');
    await f.grant(root.id, 'editor', 'editor');
    await f.grant(root.id, 'viewer', 'viewer');
    const child = await f.folder('Editor-owned child', root.id, 'editor');
    await f.files.share(f.w.id, 'editor', child.id, { kind: 'individual', id: f.members.manager }, 'manager');
    const team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Reviewers')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      f.members.viewer,
      team,
    ]);
    await f.files.share(f.w.id, f.w.userId, root.id, { kind: 'team', id: team }, 'editor');
    const snapshot = await f.files.readSharing(f.w.id, f.w.userId, child.id);
    assert.deepEqual(snapshot.item, reference(child));
    assert.deepEqual(snapshot.creator, { membershipId: f.members.editor, active: true });
    assert.equal(snapshot.effectiveRole, 'manager');
    assert.deepEqual(snapshot.directGrants, [
      { subject: { kind: 'individual', id: f.members.manager }, role: 'manager' },
    ]);
    assert.deepEqual(snapshot.inherited[0], {
      kind: 'ownership',
      source: reference(root),
      owner: { membershipId: f.w.membershipId, active: true },
    });
    assert.deepEqual(
      snapshot.inherited.filter(entry => entry.kind === 'grant').map(entry => entry.grant),
      [
        ...sortedAudience([
          [f.members.editor, 'editor'],
          [f.members.viewer, 'viewer'],
        ]).map(entry => ({ subject: { kind: 'individual', id: entry.membershipId }, role: entry.role })),
        { subject: { kind: 'team', id: team }, role: 'editor' },
      ],
    );
    assert.deepEqual(
      snapshot.effectiveAudience,
      sortedAudience([
        [f.w.membershipId, 'manager'],
        [f.members.editor, 'manager'],
        [f.members.manager, 'manager'],
        [f.members.viewer, 'editor'],
      ]),
    );
    const restricted = await f.files.readSharing(f.w.id, 'manager', child.id);
    assert.deepEqual(
      restricted.inherited.map(entry => entry.source),
      Array(4).fill({ kind: 'restricted' }),
    );
    assert.equal(JSON.stringify(restricted).includes(root.id), false);
    assert.equal(JSON.stringify(restricted).includes(root.name), false);
    assert.equal(JSON.stringify(restricted).includes('object_key'), false);
    for (const user of ['viewer', 'admin', 'unrelated']) {
      await assert.rejects(f.files.readSharing(f.w.id, user, child.id), AccessDenied);
      await assert.rejects(f.files.previewMove(f.w.id, user, child.id, null), AccessDenied);
    }
    await assert.rejects(f.files.readSharing(f.w.id, 'editor', root.id), AccessDenied);
    await assert.rejects(f.files.readSharing(f.other.id, f.other.userId, child.id), AccessDenied);
    for (const member of snapshot.effectiveAudience) {
      const user =
        member.membershipId === f.w.membershipId
          ? f.w.userId
          : Object.keys(f.members).find(name => f.members[name] === member.membershipId);
      assert.equal((await f.files.read(f.w.id, user, child.id)).role, member.role);
      assert.equal((await f.files.list(f.w.id, user)).items.find(item => item.id === child.id).role, member.role);
    }
    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      f.w.membershipId,
    ]);
    const newMembership = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      newMembership,
      f.w.userId,
    ]);
    const afterRemoval = await f.files.readSharing(f.w.id, 'manager', child.id);
    assert.deepEqual(afterRemoval.inherited[0].owner, { membershipId: f.w.membershipId, active: false });
    assert.deepEqual(
      afterRemoval.effectiveAudience,
      sortedAudience([
        [f.members.editor, 'manager'],
        [f.members.manager, 'manager'],
        [f.members.viewer, 'editor'],
      ]),
    );
    await assert.rejects(f.files.readSharing(f.w.id, f.w.userId, child.id), AccessDenied);
  } finally {
    await f.close();
  }
});

test('source owners with destination editor access inspect subtree audiences without destination sharing disclosure', async () => {
  const f = await setup();
  try {
    const source = await f.folder('Editor-owned source', null, 'editor');
    const child = await f.upload('Editor-owned child', source.id, 'editor');
    const destination = await f.folder('Destination');
    await f.files.share(f.w.id, 'editor', source.id, { kind: 'individual', id: f.members.viewer }, 'viewer');
    await f.grant(destination.id, 'editor', 'editor');
    await f.grant(destination.id, 'unrelated', 'viewer');
    assert.equal((await f.files.read(f.w.id, 'editor', destination.id)).role, 'editor');
    await assert.rejects(f.files.readSharing(f.w.id, 'editor', destination.id), AccessDenied);

    const preview = await f.files.previewMove(f.w.id, 'editor', source.id, destination.id);
    assert.deepEqual(preview.source, reference(source));
    assert.deepEqual(preview.destination, { kind: 'folder', item: reference(destination), effectiveRole: 'editor' });
    assert.deepEqual(
      preview.subtree,
      [source, child]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(item => ({
          item: reference(item),
          before: {
            availability: 'available',
            audience: sortedAudience([
              [f.members.editor, 'manager'],
              [f.members.viewer, 'viewer'],
            ]),
          },
          after: {
            availability: 'available',
            audience: sortedAudience([
              [f.w.membershipId, 'manager'],
              [f.members.editor, 'manager'],
              [f.members.viewer, 'viewer'],
              [f.members.unrelated, 'viewer'],
            ]),
          },
        })),
    );
    assert.deepEqual(await f.files.move(f.w.id, 'editor', source.id, destination.id, preview.fingerprint), {
      id: source.id,
      parentId: destination.id,
    });
    for (const item of [source, child]) {
      for (const [user, role] of [
        [f.w.userId, 'manager'],
        ['editor', 'manager'],
        ['viewer', 'viewer'],
        ['unrelated', 'viewer'],
      ]) {
        assert.equal((await f.files.read(f.w.id, user, item.id)).role, role);
        assert.equal((await f.files.list(f.w.id, user)).items.find(entry => entry.id === item.id).role, role);
      }
    }
    await assert.rejects(f.files.readSharing(f.w.id, 'editor', destination.id), AccessDenied);
  } finally {
    await f.close();
  }
});

test('move analysis includes every descendant, changed roles, overlapping direct grants, creator roles and unavailable latent audiences', async () => {
  const f = await setup();
  try {
    const old = await f.folder('Old'),
      destination = await f.folder('New');
    await f.grant(old.id, 'editor', 'editor');
    await f.grant(old.id, 'viewer', 'viewer');
    await f.grant(destination.id, 'viewer', 'editor');
    await f.grant(destination.id, 'unrelated', 'viewer');
    const source = await f.folder('Moving', old.id);
    const nested = await f.folder('Nested', source.id, 'editor');
    const child = await f.upload('Directly shared', nested.id, 'editor');
    await f.grant(child.id, 'viewer', 'manager');
    const hidden = await f.upload('Hidden private name', nested.id, 'editor');
    await f.files.trash(f.w.id, 'editor', hidden.id, true);
    const pendingId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,object_key,media_type,size,sha256,ready)
      VALUES ($1,'file',$2,$3,'Pending private name',$4,'text/plain',7,repeat('a',64),false)`,
      [pendingId, f.members.editor, nested.id, randomUUID()],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready)
      SELECT gen_random_uuid(),'folder',$1,$2,'Extra descendant',true FROM generate_series(1,105)`,
      [f.w.membershipId, source.id],
    );
    const preview = await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
    assert.deepEqual(preview.source, reference(source));
    assert.deepEqual(preview.destination, { kind: 'folder', item: reference(destination), effectiveRole: 'manager' });
    assert.equal(preview.subtree.length, 110);
    const moving = preview.subtree.find(entry => entry.item.id === source.id);
    assert.deepEqual(moving.before, {
      availability: 'available',
      audience: sortedAudience([
        [f.w.membershipId, 'manager'],
        [f.members.editor, 'editor'],
        [f.members.viewer, 'viewer'],
      ]),
    });
    assert.deepEqual(moving.after, {
      availability: 'available',
      audience: sortedAudience([
        [f.w.membershipId, 'manager'],
        [f.members.viewer, 'editor'],
        [f.members.unrelated, 'viewer'],
      ]),
    });
    const shared = preview.subtree.find(entry => entry.item.id === child.id);
    assert.deepEqual(
      shared.after.audience,
      sortedAudience([
        [f.w.membershipId, 'manager'],
        [f.members.editor, 'manager'],
        [f.members.viewer, 'manager'],
        [f.members.unrelated, 'viewer'],
      ]),
    );
    const unavailable = preview.subtree.filter(entry => entry.item.kind === 'restricted');
    assert.equal(unavailable.length, 2);
    for (const entry of unavailable) {
      assert.deepEqual(entry.item, { kind: 'restricted' });
      assert.deepEqual(entry.before, {
        availability: 'unavailable',
        audience: sortedAudience([
          [f.w.membershipId, 'manager'],
          [f.members.editor, 'manager'],
          [f.members.viewer, 'viewer'],
        ]),
      });
      assert.deepEqual(entry.after, {
        availability: 'unavailable',
        audience: sortedAudience([
          [f.w.membershipId, 'manager'],
          [f.members.editor, 'manager'],
          [f.members.viewer, 'editor'],
          [f.members.unrelated, 'viewer'],
        ]),
      });
    }
    for (const secret of [hidden.id, hidden.name, pendingId, 'Pending private name', 'object_key'])
      assert.equal(JSON.stringify(preview).includes(secret), false);
    const grants = (
      await f.db.platform.query(`SELECT * FROM ${f.table('tf_file_grants')} ORDER BY item_id, subject_kind, subject_id`)
    ).rows;
    assert.deepEqual(await f.files.move(f.w.id, f.w.userId, source.id, destination.id, preview.fingerprint), {
      id: source.id,
      parentId: destination.id,
    });
    assert.deepEqual(
      (
        await f.db.platform.query(
          `SELECT * FROM ${f.table('tf_file_grants')} ORDER BY item_id, subject_kind, subject_id`,
        )
      ).rows,
      grants,
    );
    assert.equal((await f.files.read(f.w.id, 'viewer', child.id)).role, 'manager');
    assert.equal((await f.files.read(f.w.id, 'editor', nested.id)).role, 'manager');
    await assert.rejects(f.files.read(f.w.id, 'editor', source.id), AccessDenied);
    await assert.rejects(f.files.read(f.w.id, 'viewer', hidden.id), AccessDenied);
    await assert.rejects(f.files.read(f.w.id, 'viewer', pendingId), AccessDenied);
  } finally {
    await f.close();
  }
});

test('all moves require a well-formed matching fingerprint, including root and same-parent moves, and normalize UUIDs', async () => {
  const f = await setup();
  try {
    const source = await f.folder('Source'),
      destination = await f.folder('Destination');
    for (const parentId of [null, destination.id]) {
      for (const token of [undefined, null, '', 'yes', {}, 'files-move-v1:123', 'files-move-v2:' + 'a'.repeat(64)]) {
        await assert.rejects(
          f.files.move(f.w.id, f.w.userId, source.id, parentId, token),
          error => error.name === 'ZodError',
        );
        assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
      }
    }
    const root = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
    assert.deepEqual(root.destination, { kind: 'root' });
    assert.deepEqual(root.subtree[0].before, root.subtree[0].after);
    await assert.rejects(f.files.move(f.w.id, f.w.userId, source.id, destination.id, root.fingerprint), conflict);
    await assert.rejects(f.files.move(f.w.id, f.w.userId, destination.id, null, root.fingerprint), conflict);
    await f.grant(source.id, 'manager', 'manager');
    const actorPreview = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
    await assert.rejects(f.files.move(f.w.id, 'manager', source.id, null, actorPreview.fingerprint), conflict);
    const normalized = await f.files.previewMove(
      f.w.id.toUpperCase(),
      f.w.userId,
      source.id.toUpperCase(),
      destination.id.toUpperCase(),
    );
    assert.deepEqual(await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id), normalized);
    assert.match(normalized.fingerprint, /^files-move-v1:[a-f0-9]{64}$/);
    await f.files.move(
      f.w.id.toUpperCase(),
      f.w.userId,
      source.id.toUpperCase(),
      destination.id.toUpperCase(),
      normalized.fingerprint,
    );
    await assert.rejects(f.files.move(f.w.id, f.w.userId, source.id, destination.id, normalized.fingerprint), conflict);
    const same = await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
    assert.deepEqual(same.subtree[0].before, same.subtree[0].after);
    await assert.rejects(
      f.files.move(f.w.id, f.w.userId, source.id, destination.id),
      error => error.name === 'ZodError',
    );
    assert.deepEqual(await f.files.move(f.w.id, f.w.userId, source.id, destination.id, same.fingerprint), {
      id: source.id,
      parentId: destination.id,
    });
    await f.move(source.id, null);
    const rootAgain = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
    assert.deepEqual(await f.files.move(f.w.id, f.w.userId, source.id, null, rootAgain.fingerprint), {
      id: source.id,
      parentId: null,
    });
  } finally {
    await f.close();
  }
});

test('fingerprints reject stale scoped rows and governance dependencies even when effective audiences do not change', async t => {
  const f = await setup();
  try {
    const old = await f.folder('Old'),
      destinationAncestor = await f.folder('Destination ancestor');
    const destination = await f.folder('Destination', destinationAncestor.id),
      source = await f.folder('Source', old.id);
    const child = await f.upload('Child', source.id),
      other = await f.folder('Unrelated folder');
    const team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Team')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      f.members.viewer,
      team,
    ]);
    await f.files.share(f.w.id, f.w.userId, source.id, { kind: 'team', id: team }, 'viewer');
    await f.grant(source.id, 'viewer', 'manager');
    const preview = () => f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
    const stale = async change => {
      const before = await preview();
      await change();
      const expectedParent = (await f.files.read(f.w.id, f.w.userId, source.id)).parentId;
      const grants = (
        await f.db.platform.query(
          `SELECT * FROM ${f.table('tf_file_grants')} ORDER BY item_id, subject_kind, subject_id`,
        )
      ).rows;
      await assert.rejects(f.files.move(f.w.id, f.w.userId, source.id, destination.id, before.fingerprint), conflict);
      assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, expectedParent);
      assert.deepEqual(
        (
          await f.db.platform.query(
            `SELECT * FROM ${f.table('tf_file_grants')} ORDER BY item_id, subject_kind, subject_id`,
          )
        ).rows,
        grants,
      );
    };
    for (const [name, change] of [
      ['source ancestor grant', () => f.grant(old.id, 'editor', 'viewer')],
      ['source direct grant', () => f.grant(source.id, 'editor', 'editor')],
      ['destination grant', () => f.grant(destination.id, 'editor', 'viewer')],
      ['destination ancestor grant', () => f.grant(destinationAncestor.id, 'editor', 'editor')],
      ['descendant grant', () => f.grant(child.id, 'manager', 'manager')],
      [
        'masked grant update and revert',
        async () => {
          await f.files.share(f.w.id, f.w.userId, source.id, { kind: 'team', id: team }, 'editor');
          await f.files.share(f.w.id, f.w.userId, source.id, { kind: 'team', id: team }, 'viewer');
        },
      ],
      [
        'existing grant delete and reinsert',
        async () => {
          await f.grant(source.id, 'viewer', null);
          await f.grant(source.id, 'viewer', 'manager');
        },
      ],
      [
        'membership role change',
        () =>
          f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role = 'admin' WHERE id = $1`, [
            f.members.viewer,
          ]),
      ],
      [
        'membership remove and rejoin',
        async () => {
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
            f.members.viewer,
          ]);
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'viewer','member')`,
            [randomUUID()],
          );
        },
      ],
      [
        'membership update and revert',
        async () => {
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
            f.members.manager,
          ]);
          await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = NULL WHERE id = $1`, [
            f.members.manager,
          ]);
        },
      ],
      [
        'team enrollment remove and rejoin',
        async () => {
          await f.db.platform.query(
            `DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id = $1 AND team_id = $2`,
            [f.members.viewer, team],
          );
          await f.db.platform.query(
            `INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`,
            [f.members.viewer, team],
          );
        },
      ],
      [
        'team enrollment addition',
        () =>
          f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
            f.members.editor,
            team,
          ]),
      ],
      [
        'team enrollment removal',
        () =>
          f.db.platform.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE membership_id = $1`, [f.members.editor]),
      ],
      [
        'team removal',
        async () => {
          await f.db.platform.query(`DELETE FROM ${f.table('tf_member_teams')} WHERE team_id = $1`, [team]);
          await f.db.platform.query(`DELETE FROM ${f.table('tf_teams')} WHERE id = $1`, [team]);
        },
      ],
      [
        'team recreation',
        () => f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Team')`, [team]),
      ],
      [
        'unrelated membership insertion',
        () =>
          f.db.platform.query(
            `INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,'new-user','member')`,
            [randomUUID()],
          ),
      ],
      [
        'source parent away and back',
        async () => {
          await f.move(old.id, other.id);
          await f.move(old.id, null);
        },
      ],
      [
        'destination parent away and back',
        async () => {
          await f.move(destinationAncestor.id, other.id);
          await f.move(destinationAncestor.id, null);
        },
      ],
      [
        'source move away and back',
        async () => {
          await f.move(source.id, other.id);
          await f.move(source.id, old.id);
        },
      ],
      [
        'descendant move away and back',
        async () => {
          await f.move(child.id, other.id);
          await f.move(child.id, source.id);
        },
      ],
      ['descendant name', () => f.files.rename(f.w.id, f.w.userId, child.id, 'Renamed')],
      ['descendant trash', () => f.files.trash(f.w.id, f.w.userId, child.id, true)],
      [
        'hidden descendant grant',
        () =>
          f.db.platform.query(`UPDATE ${f.table('tf_file_grants')} SET role = 'editor' WHERE item_id = $1`, [child.id]),
      ],
      [
        'descendant readiness',
        () => f.db.platform.query(`UPDATE ${f.table('tf_files')} SET ready = false WHERE id = $1`, [child.id]),
      ],
      ['descendant insertion', () => f.folder('New child', source.id)],
      ['destination rename', () => f.files.rename(f.w.id, f.w.userId, destination.id, 'Renamed destination')],
    ])
      await t.test(name, () => stale(change));
    const before = await preview();
    await f.files.rename(f.w.id, f.w.userId, other.id, 'Unrelated rename');
    assert.equal((await preview()).fingerprint, before.fingerprint);
    assert.deepEqual(await f.files.move(f.w.id, f.w.userId, source.id, destination.id, before.fingerprint), {
      id: source.id,
      parentId: destination.id,
    });
  } finally {
    await f.close();
  }
});

test('move reauthorizes source and destination, rejects new cycles, and can succeed after losing inherited source access', async () => {
  const f = await setup();
  try {
    const sourceParent = await f.folder('Source parent'),
      source = await f.folder('Source', sourceParent.id),
      destination = await f.folder('Destination');
    await f.grant(sourceParent.id, 'manager', 'manager');
    await f.grant(destination.id, 'manager', 'editor');
    const preview = () => f.files.previewMove(f.w.id, 'manager', source.id, destination.id);
    let before = await preview();
    await f.grant(sourceParent.id, 'manager', 'editor');
    await assert.rejects(f.files.move(f.w.id, 'manager', source.id, destination.id, before.fingerprint), AccessDenied);
    await f.grant(sourceParent.id, 'manager', 'manager');
    before = await preview();
    await f.grant(destination.id, 'manager', 'viewer');
    await assert.rejects(f.files.move(f.w.id, 'manager', source.id, destination.id, before.fingerprint), AccessDenied);
    await f.grant(destination.id, 'manager', 'editor');
    before = await preview();
    await f.files.trash(f.w.id, f.w.userId, destination.id, true);
    await assert.rejects(f.files.move(f.w.id, 'manager', source.id, destination.id, before.fingerprint), AccessDenied);
    await f.files.trash(f.w.id, f.w.userId, destination.id, false);
    before = await preview();
    await f.move(destination.id, source.id);
    await assert.rejects(
      f.files.move(f.w.id, 'manager', source.id, destination.id, before.fingerprint),
      error => error.code === 'invalid-move',
    );
    assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, sourceParent.id);
    const root = await f.files.previewMove(f.w.id, 'manager', source.id, null);
    assert.equal(
      root.subtree
        .find(entry => entry.item.id === source.id)
        .after.audience.some(member => member.membershipId === f.members.manager),
      false,
    );
    assert.deepEqual(await f.files.move(f.w.id, 'manager', source.id, null, root.fingerprint), {
      id: source.id,
      parentId: null,
    });
    await assert.rejects(f.files.read(f.w.id, 'manager', source.id), AccessDenied);
    assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
  } finally {
    await f.close();
  }
});

async function waitForBlocked(db, blockerPid, count = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.platform.query(
      `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (rows.length >= count) return;
    await delay(10);
  }
  assert.fail('operation did not wait on the authorization lock');
}

test('readSharing and previewMove wait for authorization writes and read the committed grant state', async () => {
  const f = await setup();
  const connection = await connect(f.db.login(f.w));
  try {
    const source = await f.folder('Source');
    await f.grant(source.id, 'manager', 'manager');
    const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await connection.query('BEGIN');
    await lockAuthorization({ client: connection, schema: f.w.names.schema }, 'write');
    await connection.query(`DELETE FROM ${f.table('tf_file_grants')} WHERE item_id = $1`, [source.id]);
    const sharing = assert.rejects(f.files.readSharing(f.w.id, 'manager', source.id), AccessDenied);
    const preview = assert.rejects(f.files.previewMove(f.w.id, 'manager', source.id, null), AccessDenied);
    await waitForBlocked(f.db, pid, 2);
    await connection.query('COMMIT');
    await Promise.all([sharing, preview]);
    assert.deepEqual((await f.files.readSharing(f.w.id, f.w.userId, source.id)).directGrants, []);
  } finally {
    await connection.query('ROLLBACK');
    await connection.end();
    await f.close();
  }
});

test('move waits for authorization writers, then compares fresh dependency versions before changing the parent', async () => {
  const f = await setup();
  const connection = await connect(f.db.login(f.w));
  try {
    const source = await f.folder('Source'),
      destination = await f.folder('Destination');
    await f.grant(source.id, 'viewer', 'manager');
    const preview = await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
    const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await connection.query('BEGIN');
    await lockAuthorization({ client: connection, schema: f.w.names.schema }, 'write');
    await connection.query(`UPDATE ${f.table('tf_file_grants')} SET role = 'editor' WHERE item_id = $1`, [source.id]);
    const move = assert.rejects(
      f.files.move(f.w.id, f.w.userId, source.id, destination.id, preview.fingerprint),
      conflict,
    );
    await waitForBlocked(f.db, pid);
    await connection.query('COMMIT');
    await move;
    assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
    assert.equal((await f.files.read(f.w.id, 'viewer', source.id)).role, 'editor');
    const fresh = await f.files.previewMove(f.w.id, f.w.userId, source.id, destination.id);
    assert.deepEqual(await f.files.move(f.w.id, f.w.userId, source.id, destination.id, fresh.fingerprint), {
      id: source.id,
      parentId: destination.id,
    });
  } finally {
    await connection.query('ROLLBACK');
    await connection.end();
    await f.close();
  }
});

test('move takes the authorization write lock even when the audience is unchanged', async () => {
  const f = await setup();
  const connection = await connect(f.db.login(f.w));
  try {
    const source = await f.folder('Source');
    const preview = await f.files.previewMove(f.w.id, f.w.userId, source.id, null);
    const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await connection.query('BEGIN');
    await lockAuthorization({ client: connection, schema: f.w.names.schema }, 'read');
    const move = f.files.move(f.w.id, f.w.userId, source.id, null, preview.fingerprint);
    await waitForBlocked(f.db, pid);
    await connection.query('COMMIT');
    assert.deepEqual(await move, { id: source.id, parentId: null });
  } finally {
    await connection.query('ROLLBACK');
    await connection.end();
    await f.close();
  }
});

test('move rechecks manager authority after waiting for committed revocation', async () => {
  const f = await setup();
  const connection = await connect(f.db.login(f.w));
  try {
    const source = await f.folder('Source');
    await f.grant(source.id, 'manager', 'manager');
    const preview = await f.files.previewMove(f.w.id, 'manager', source.id, null);
    const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await connection.query('BEGIN');
    await lockAuthorization({ client: connection, schema: f.w.names.schema }, 'write');
    await connection.query(`UPDATE ${f.table('tf_file_grants')} SET role = 'viewer' WHERE item_id = $1`, [source.id]);
    const move = assert.rejects(f.files.move(f.w.id, 'manager', source.id, null, preview.fingerprint), AccessDenied);
    await waitForBlocked(f.db, pid);
    await connection.query('COMMIT');
    await move;
    assert.equal((await f.files.read(f.w.id, 'manager', source.id)).role, 'viewer');
    assert.equal((await f.files.read(f.w.id, f.w.userId, source.id)).parentId, null);
  } finally {
    await connection.query('ROLLBACK');
    await connection.end();
    await f.close();
  }
});

const usage = (f, files = f.files) => files.usage(f.w.id, f.w.userId).then(value => value.usedBytes);
const rows = async (f, ids) =>
  (await f.db.platform.query(`SELECT id FROM ${f.table('tf_files')} WHERE id = ANY($1::uuid[])`, [ids])).rows.length;

test("only the current owner deletes a Trash item forever; managers and folders holding others' items are refused", async () => {
  const f = await setup();
  try {
    const folder = await f.folder('Projects');
    const own = await f.upload('Mine.txt', folder.id);
    await f.grant(folder.id, 'manager', 'manager');
    await f.grant(folder.id, 'editor', 'editor');
    const theirs = await f.upload('Theirs.txt', folder.id, 'editor');
    const loose = await f.upload('Loose.txt');
    await assert.rejects(f.files.deleteForever(f.w.id, f.w.userId, loose.id), error => error.code === 'not-trashed');
    await f.files.trash(f.w.id, 'manager', folder.id, true);
    await f.files.trash(f.w.id, f.w.userId, loose.id, true);
    await assert.rejects(f.files.previewDeletion(f.w.id, 'manager', folder.id), error => error.code === 'not-owner');
    await assert.rejects(f.files.deleteForever(f.w.id, 'manager', folder.id), error => error.code === 'not-owner');
    await assert.rejects(f.files.deleteForever(f.w.id, 'admin', folder.id), AccessDenied);
    const preview = await f.files.previewDeletion(f.w.id, f.w.userId, folder.id);
    assert.deepEqual(
      {
        files: preview.files,
        bytes: preview.bytes,
        blockerCount: preview.blockerCount,
        blockers: preview.blockers,
        owners: preview.owners.map(owner => owner.membershipId),
      },
      {
        files: 2,
        bytes: 32,
        blockerCount: 1,
        blockers: [{ id: theirs.id, name: 'Theirs.txt', kind: 'file', ownerMembershipId: f.members.editor }],
        owners: [f.members.editor],
      },
    );
    await assert.rejects(
      f.files.deleteForever(f.w.id, f.w.userId, folder.id),
      error => error.code === 'owned-by-others',
    );
    assert.equal(await rows(f, [folder.id, own.id, theirs.id]), 3);
    assert.deepEqual(await f.files.deleteForever(f.w.id, f.w.userId, loose.id), { id: loose.id, state: 'deleted' });
    assert.equal(await rows(f, [loose.id]), 0);
    await f.files.trash(f.w.id, f.w.userId, folder.id, false);
    await f.move(theirs.id, null, 'editor');
    await f.files.trash(f.w.id, f.w.userId, folder.id, true);
    assert.equal((await f.files.previewDeletion(f.w.id, f.w.userId, folder.id)).blockerCount, 0);
    assert.deepEqual(await f.files.deleteForever(f.w.id, f.w.userId, folder.id), { id: folder.id, state: 'deleted' });
    assert.equal(await rows(f, [folder.id, own.id]), 0);
    assert.deepEqual([...f.objects.keys()].length, 1);
    assert.equal((await f.files.download(f.w.id, 'editor', theirs.id)).bytes.toString(), 'private contents');
    const login = await connect(f.db.login(f.w));
    try {
      await denied(login, `DELETE FROM ${f.table('tf_files')} WHERE id = $1`, [theirs.id]);
    } finally {
      await login.end();
    }
  } finally {
    await f.close();
  }
});

test('deletion denies reads at once, keeps a failed removal charged, and converges once on retry or restart', async () => {
  const f = await setup();
  try {
    const folder = await f.folder('Archive');
    const first = await f.upload('First.txt', folder.id),
      second = await f.upload('Second.txt', folder.id);
    await f.grant(folder.id, 'viewer', 'viewer');
    const kept = await f.upload('Kept.txt');
    await f.files.trash(f.w.id, f.w.userId, folder.id, true);
    assert.equal(await usage(f), 48);
    let removals = 0,
      reads = 0;
    const failing = createFiles(f.runtime, {
      ...f.bytes,
      remove: async key => {
        removals++;
        if (removals === 2) throw new Error('object store down');
        await f.bytes.remove(key);
      },
    });
    const crashed = createFiles(f.runtime, {
      ...f.bytes,
      remove: async () => {
        throw new Error('process stopped');
      },
    });
    assert.deepEqual(await crashed.deleteForever(f.w.id, f.w.userId, folder.id), { id: folder.id, state: 'failed' });
    for (const id of [folder.id, first.id, second.id]) {
      await assert.rejects(f.files.read(f.w.id, f.w.userId, id), AccessDenied);
      await assert.rejects(f.files.trash(f.w.id, f.w.userId, id, false), AccessDenied);
    }
    await assert.rejects(f.files.download(f.w.id, 'viewer', first.id), AccessDenied);
    await assert.rejects(
      f.runtime.transaction(f.w.id, commonCompatibility, tx =>
        requireReadableFile(tx, { kind: 'human', userId: f.w.userId, membershipId: f.w.membershipId }, first.id),
      ),
      AccessDenied,
    );
    const knowledge = async id =>
      (
        await f.db.platform.query(
          `SELECT ${readableFileSql(f.w.names.schema)} AS readable FROM (SELECT $2::jsonb AS original) r`,
          [
            f.w.membershipId,
            { fileId: id, sha256: createHash('sha256').update('private contents').digest('hex'), bytes: 16 },
          ],
        )
      ).rows[0].readable;
    assert.equal(await knowledge(kept.id), true);
    assert.equal(await knowledge(first.id), false);
    const trash = (
      await f.files.library(f.w.id, f.w.userId, { section: 'trash', location: { kind: 'root' }, query: '' })
    ).items;
    assert.deepEqual(
      trash.map(item => [item.name, item.deletion]),
      [['Archive', 'failed']],
    );
    assert.equal(await usage(f), 48);
    assert.equal(f.objects.size, 3);
    assert.deepEqual(await failing.deleteForever(f.w.id, f.w.userId, folder.id), { id: folder.id, state: 'deleted' });
    assert.equal(removals, 4);
    assert.equal(await rows(f, [folder.id, first.id, second.id]), 0);
    assert.equal(await usage(f), 16);
    assert.deepEqual(await f.files.sweepDeletions(f.w.id), { attempted: 0, failed: 0 });
    assert.deepEqual(
      await f.files.deleteForever(f.w.id, f.w.userId, folder.id).catch(error => error.constructor.name),
      'AccessDenied',
    );
    assert.equal(await usage(f), 16);
    assert.deepEqual([...f.objects.keys()].length, 1);
    assert.equal(await knowledge(first.id), false);
    assert.equal((await f.files.download(f.w.id, f.w.userId, kept.id)).bytes.toString(), 'private contents');
    const resumed = await f.upload('Resumed.txt');
    await f.files.trash(f.w.id, f.w.userId, resumed.id, true);
    await crashed.deleteForever(f.w.id, f.w.userId, resumed.id);
    const restarted = createFiles(f.runtime, {
      ...f.bytes,
      read: async (...args) => {
        reads++;
        return f.bytes.read(...args);
      },
    });
    const sweeps = await Promise.all([restarted.sweepDeletions(f.w.id), restarted.sweepDeletions(f.w.id)]);
    assert.deepEqual(
      sweeps.map(sweep => sweep.failed),
      [0, 0],
    );
    assert.equal(reads, 0);
    assert.equal(await rows(f, [resumed.id]), 0);
    assert.equal(await usage(f), 16);
  } finally {
    await f.close();
  }
});

test('the collation guard passes where ICU exists and stops a rollout that lacks the collation', async () => {
  const db = await fixture();
  try {
    const baseline = await readFile(
      new URL('../../../workspace-storage/common/0001_baseline.sql', import.meta.url),
      'utf8',
    );
    const sql = baseline.match(/DO \$\$\nDECLARE\n {2}collation_name text := 'und-x-icu';[\s\S]*?\nEND \$\$;/)?.[0];
    assert.ok(sql, 'the baseline carries the collation guard');
    assert.equal((await db.platform.query(`SELECT getdatabaseencoding() AS encoding`)).rows[0].encoding, 'UTF8');
    await db.platform.query(sql);
    const missing = sql.replace(`collation_name text := 'und-x-icu'`, `collation_name text := 'tf-absent-icu'`);
    assert.notEqual(missing, sql);
    await assert.rejects(
      db.platform.query(missing),
      error =>
        error.code === '42704' &&
        error.message === 'Files requires the ICU collation pg_catalog."tf-absent-icu" for database encoding UTF8' &&
        error.hint === 'Use a PostgreSQL server built with ICU and a UTF8 database, then retry the rollout.',
    );
  } finally {
    await db.close();
  }
});

test('the deletion sweep reaches a recoverable item behind ten that keep failing', async () => {
  const f = await setup();
  try {
    const stuck = [];
    for (let n = 0; n < 10; n++) stuck.push(await f.upload(`Stuck ${n}.txt`));
    const later = await f.upload('Later.txt');
    const keys = new Map(
      (await f.db.platform.query(`SELECT id, object_key FROM ${f.table('tf_files')}`)).rows.map(row => [
        `${f.w.id}/files/${row.object_key}`,
        row.id,
      ]),
    );
    const stuckIds = new Set(stuck.map(item => item.id));
    let healthy = false;
    const store = createFiles(f.runtime, {
      ...f.bytes,
      remove: async key => {
        if (stuckIds.has(keys.get(key)) || !healthy) throw new Error('object store refused');
        await f.bytes.remove(key);
      },
    });
    for (const item of [...stuck, later]) {
      await f.files.trash(f.w.id, f.w.userId, item.id, true);
      assert.deepEqual(await store.deleteForever(f.w.id, f.w.userId, item.id), { id: item.id, state: 'failed' });
    }
    healthy = true;
    const sweeps = [await store.sweepDeletions(f.w.id), await store.sweepDeletions(f.w.id)];
    assert.deepEqual(sweeps, [
      { attempted: 10, failed: 10 },
      { attempted: 10, failed: 9 },
    ]);
    assert.equal(await rows(f, [later.id]), 0);
    assert.equal(await rows(f, [...stuckIds]), 10);
    assert.equal(await usage(f), 160);
  } finally {
    await f.close();
  }
});

test('an unexpected failure while deleting rows records a retryable failure', async () => {
  const f = await setup();
  try {
    const folder = await f.folder('Archive');
    const child = await f.upload('Child.txt', folder.id);
    await f.files.trash(f.w.id, f.w.userId, folder.id, true);
    const crashed = createFiles(f.runtime, {
      ...f.bytes,
      remove: async () => {
        throw new Error('process stopped');
      },
    });
    assert.deepEqual(await crashed.deleteForever(f.w.id, f.w.userId, folder.id), { id: folder.id, state: 'failed' });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_files')} SET deleting_at = NULL, deletion_failed_at = NULL WHERE id = $1`,
      [child.id],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET deletion_failed_at = NULL WHERE id = $1`, [folder.id]);
    assert.deepEqual(await f.files.sweepDeletions(f.w.id), { attempted: 1, failed: 1 });
    assert.equal(await rows(f, [folder.id, child.id]), 2);
    const trash = (
      await f.files.library(f.w.id, f.w.userId, { section: 'trash', location: { kind: 'root' }, query: '' })
    ).items;
    assert.deepEqual(
      trash.map(item => [item.name, item.deletion]),
      [['Archive', 'failed']],
    );
  } finally {
    await f.close();
  }
});

test('the row delete removes only tombstoned rows even with the database guards disabled', async () => {
  const f = await setup();
  try {
    const folder = await f.folder('Archive');
    const child = await f.upload('Child.txt', folder.id);
    await f.files.trash(f.w.id, f.w.userId, folder.id, true);
    const crashed = createFiles(f.runtime, {
      ...f.bytes,
      remove: async () => {
        throw new Error('process stopped');
      },
    });
    assert.deepEqual(await crashed.deleteForever(f.w.id, f.w.userId, folder.id), { id: folder.id, state: 'failed' });
    await f.db.platform.query(
      `UPDATE ${f.table('tf_files')} SET deleting_at = NULL, deletion_failed_at = NULL WHERE id = $1`,
      [child.id],
    );
    const parentKey = (
      await f.db.platform.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'parent_id')]`,
        [f.table('tf_files')],
      )
    ).rows[0].conname;
    await f.db.platform.query(
      `ALTER TABLE ${f.table('tf_files')} DISABLE TRIGGER tf_files_delete_tombstoned, DROP CONSTRAINT ${parentKey}`,
    );
    assert.deepEqual(await f.files.sweepDeletions(f.w.id), { attempted: 1, failed: 0 });
    assert.equal(await rows(f, [folder.id]), 0, 'the tombstoned folder is deleted');
    assert.equal(
      await rows(f, [child.id]),
      1,
      'the untombstoned child survives without the tombstone trigger or parent foreign key',
    );
  } finally {
    await f.close();
  }
});

test('modified times: new files and renames stamp a change; moves, trash, restore and same-name saves do not', async () => {
  const f = await setup();
  try {
    const archive = await f.folder('Archive');
    const root = { section: 'mine', location: { kind: 'root' }, query: '' };
    const modifiedAt = async (location = root.location) =>
      Object.fromEntries(
        (await f.files.library(f.w.id, f.w.userId, { ...root, location })).items.map(item => [
          item.name,
          item.modifiedAt,
        ]),
      );
    const before = new Date();
    const fresh = await f.upload('Fresh.txt');
    const stamped = (await modifiedAt())['Fresh.txt'];
    assert.ok(
      stamped && new Date(stamped) >= new Date(before.getTime() - 1000),
      `a new file records when it arrived: ${stamped}`,
    );

    await f.move(fresh.id, archive.id);
    await f.files.trash(f.w.id, f.w.userId, fresh.id, true);
    await f.files.trash(f.w.id, f.w.userId, fresh.id, false);
    await f.files.rename(f.w.id, f.w.userId, fresh.id, 'Fresh.txt');
    const inArchive = { kind: 'folder', id: archive.id };
    assert.deepEqual(
      await modifiedAt(inArchive),
      { 'Fresh.txt': stamped },
      'move, trash, restore, and saving the same name keep the modified time',
    );

    await f.files.rename(f.w.id, f.w.userId, fresh.id, 'Renamed.txt');
    const renamed = (await modifiedAt(inArchive))['Renamed.txt'];
    assert.ok(renamed && renamed > stamped, 'a rename records a new modified time');
  } finally {
    await f.close();
  }
});

test('an upload or copy that cannot fit is refused before any bytes move, and a failed cleanup is logged without content', async () => {
  const f = await setup();
  try {
    const calls = [],
      warnings = [];
    const bytes = {
      putIfAbsent: async (key, body) => {
        calls.push('put');
        await f.bytes.putIfAbsent(key, body);
      },
      read: async key => {
        calls.push('read');
        return Buffer.alloc((await f.bytes.read(key)).length);
      },
      remove: async () => {
        calls.push('remove');
        throw Object.assign(new Error('storage down'), { code: 'unavailable' });
      },
    };
    const files = createFiles(f.runtime, bytes, {
      quotaBytes: 20,
      log: { warn: (fields, message) => warnings.push({ fields, message }) },
    });
    const upload = (content, name = 'Fits.txt') =>
      files.upload(
        f.w.id,
        f.w.userId,
        randomUUID(),
        { name, parentId: null, mediaType: 'text/plain' },
        Buffer.from(content),
      );
    await assert.rejects(
      upload('twenty-one characters'),
      error => error instanceof FileError && error.code === 'quota',
    );
    assert.deepEqual(calls, [], 'an upload over quota stores nothing');
    let loaded = false;
    const source = { provider: 'google-drive', accountId: 'account', fileId: 'doc', format: 'text/plain' };
    await assert.rejects(
      files.importFile(f.w.id, f.w.userId, randomUUID(), { name: 'Copy.txt', parentId: null }, source, async () => {
        loaded = true;
        return { mediaType: 'text/plain', content: Buffer.from('a copy that is far too large') };
      }),
      error => error.code === 'quota',
    );
    assert.deepEqual(
      [loaded, calls],
      [true, []],
      'a copy whose bytes cannot fit is refused after reading and before storing',
    );

    await assert.rejects(upload('corrupt'), error => error.code === 'integrity');
    assert.deepEqual(calls, ['put', 'read', 'remove']);
    assert.equal(warnings.length, 1);
    const [{ fields, message }] = warnings;
    assert.deepEqual(
      { ...fields, objectKey: fields.objectKey.replace(/[^/]+$/, 'key') },
      {
        event: 'files.discard_failed',
        workspaceId: f.w.id,
        objectKey: `${f.w.id}/files/key`,
        error: 'Error',
        code: 'unavailable',
      },
    );
    assert.equal(message, 'Files could not remove an unpublished object');
    assert.ok(!JSON.stringify(warnings).includes('corrupt'), 'the log carries no file content');

    calls.length = 0;
    const full = createFiles(f.runtime, bytes, { quotaBytes: 16 });
    await f.upload('Full.txt');
    loaded = false;
    await assert.rejects(
      full.importFile(f.w.id, f.w.userId, randomUUID(), { name: 'Copy.txt', parentId: null }, source, async () => {
        loaded = true;
        return { mediaType: 'text/plain', content: Buffer.from('x') };
      }),
      error => error.code === 'quota',
    );
    assert.deepEqual([loaded, calls], [false, []], 'a full workspace refuses a copy before reading the source');
  } finally {
    await f.close();
  }
});
