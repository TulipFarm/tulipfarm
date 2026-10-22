import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test(
  'Restore asks for a destination when the original folder is out of reach, under the existing manager and owner rules',
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const owner = f.signed.owner.cookie,
        admin = f.signed.admin.cookie;
      const call = (path, options) => f.call(`${base}${path}`, options);
      const ok = async (path, options) => {
        const result = await call(path, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const folder = async (name, parentId = null, cookie = owner) =>
        (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
      const upload = async (name, parentId, cookie) =>
        (
          await ok(
            `/${randomUUID()}/content?${new URLSearchParams({ name, mediaType: 'text/plain', parentId: parentId ?? 'null' })}`,
            { method: 'PUT', cookie, body: Buffer.from(`${name} body`) },
          )
        ).id;
      const share = (id, role, cookie = owner) =>
        ok(`/${id}/sharing`, {
          method: 'PUT',
          cookie,
          body: { subject: { kind: 'individual', id: f.adminMembership }, role },
        });
      const trash = (id, trashed, cookie) => call(`/${id}/trash`, { method: 'PUT', cookie, body: { trashed } });
      const trashIds = async cookie =>
        (await ok(`/library?${new URLSearchParams({ section: 'trash' })}`, { cookie })).items.map(item => item.id);

      const contracts = await folder('Supplier contracts');
      await share(contracts, 'editor');
      const kept = await upload('Kept draft.txt', contracts, admin);
      const signed = await upload('Signed copy.txt', contracts, admin);
      assert.equal((await trash(kept, true, admin)).status, 200);
      assert.equal((await trash(kept, false, admin)).status, 200, 'an editor of the original folder restores in place');
      assert.equal((await ok(`/${kept}`, { cookie: admin })).parentId, contracts);

      assert.equal((await trash(signed, true, admin)).status, 200);
      await share(contracts, null);
      const refused = await trash(signed, false, admin);
      assert.deepEqual(
        [refused.status, refused.json().error],
        [409, 'file-restore-destination'],
        'the original folder no longer accepts the restorer’s items',
      );
      assert.deepEqual(await trashIds(admin), [signed], 'a refused restore leaves the item in Trash');
      assert.equal(
        (await call(`/${signed}/move-audience`, { method: 'POST', cookie: admin, body: { parentId: contracts } }))
          .status,
        404,
        'the original folder is not offered as a destination once it is out of reach',
      );
      assert.ok(
        (await ok(`/${signed}/directory`, { cookie: admin })).members.some(
          member => member.membershipId === f.workspace.membershipId,
        ),
        'the restore review can name who loses access',
      );
      const preview = await ok(`/${signed}/move-audience`, { method: 'POST', cookie: admin, body: { parentId: null } });
      const self = preview.subtree.find(entry => entry.item.id === signed);
      assert.deepEqual(
        [self.before.availability, self.after.availability],
        ['unavailable', 'available'],
        'the review shows the restore reopening the item',
      );
      assert.deepEqual(
        self.before.audience.map(entry => entry.membershipId).sort(),
        [f.adminMembership, f.workspace.membershipId].sort(),
        'the folder owner could open it in its old place',
      );
      assert.deepEqual(
        self.after.audience.map(entry => entry.membershipId),
        [f.adminMembership],
        'the folder owner loses access once it moves out',
      );
      await share(contracts, 'viewer');
      const stale = await call(`/${signed}/parent`, {
        method: 'PUT',
        cookie: admin,
        body: { parentId: null, fingerprint: preview.fingerprint },
      });
      assert.deepEqual(
        [stale.status, stale.json().error],
        [409, 'file-conflict'],
        'a sharing change after review requires a fresh review',
      );
      assert.deepEqual(
        [(await trash(signed, false, admin)).json().error],
        ['file-restore-destination'],
        'view access to the original folder still cannot accept the restore',
      );
      const fresh = await ok(`/${signed}/move-audience`, { method: 'POST', cookie: admin, body: { parentId: null } });
      await ok(`/${signed}/parent`, {
        method: 'PUT',
        cookie: admin,
        body: { parentId: null, fingerprint: fresh.fingerprint },
      });
      const restored = await ok(`/${signed}`, { cookie: admin });
      assert.deepEqual(
        [restored.parentId, restored.trashed],
        [null, false],
        'restoring to a chosen destination clears Trash',
      );
      assert.deepEqual(await trashIds(admin), []);

      const policies = await folder('Policies');
      const handbook = await upload('Handbook.txt', policies, owner);
      await share(handbook, 'manager');
      assert.equal((await trash(handbook, true, admin)).status, 200, 'a manager of the item moves it to Trash');
      assert.deepEqual(
        [(await trash(handbook, false, admin)).json().error],
        ['file-restore-destination'],
        'a manager without access to its folder chooses a destination',
      );
      const desk = await folder('Admin desk', null, admin);
      const toDesk = await ok(`/${handbook}/move-audience`, {
        method: 'POST',
        cookie: admin,
        body: { parentId: desk },
      });
      assert.equal(toDesk.destination.item.id, desk);
      await ok(`/${handbook}/parent`, {
        method: 'PUT',
        cookie: admin,
        body: { parentId: desk, fingerprint: toDesk.fingerprint },
      });
      assert.deepEqual(
        await ok(`/${handbook}`, { cookie: owner }).then(item => [
          item.parentId,
          item.trashed,
          item.creatorMembershipId,
        ]),
        [desk, false, f.workspace.membershipId],
        'the owner keeps ownership of an item restored into another member’s folder',
      );

      const memo = await upload('Memo.txt', null, owner);
      await share(memo, 'editor');
      assert.equal((await trash(memo, true, owner)).status, 200);
      assert.equal(
        (await call(`/${memo}/move-audience`, { method: 'POST', cookie: admin, body: { parentId: null } })).status,
        404,
        'an editor cannot restore a Trash item through a move',
      );
      assert.equal((await trash(memo, false, admin)).status, 404, 'nor restore it in place');
      assert.equal(
        (await call(`/${memo}/directory`, { cookie: admin })).status,
        404,
        'nor read the directory for a review',
      );

      const archive = await folder('Archive');
      const note = await upload('Note.txt', archive, owner);
      assert.equal((await trash(note, true, owner)).status, 200);
      assert.equal((await trash(archive, true, owner)).status, 200);
      assert.equal(
        (await trash(note, false, owner)).status,
        404,
        'an item below a trashed folder is closed until its folder returns',
      );
      assert.equal((await trash(archive, false, owner)).status, 200);
      assert.equal((await trash(note, false, owner)).status, 200, 'restoring the folder reopens its original place');
    } finally {
      await f.close();
    }
  },
);

test(
  'A cancelled upload leaves no file, no stored object, and no quota charge, and the same id uploads again',
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const used = async () => (await f.call(`${base}/usage`)).json().usedBytes;
      const rows = async id =>
        (await f.db.platform.query(`SELECT count(*)::int AS count FROM ${f.table('tf_files')} WHERE id=$1`, [id]))
          .rows[0].count;
      const id = randomUUID(),
        body = Buffer.from('date,amount\n2026-01-01,40\n');
      const path = `${base}/${id}/content?${new URLSearchParams({ name: 'Ledger.csv', mediaType: 'text/csv', parentId: 'null' })}`;
      const before = await used(),
        objects = f.object.objects.size;
      const sender = new AbortController();
      let verifying = false;
      f.object.faults.afterRead = async () => {
        verifying = true;
        sender.abort();
        await sleep(250);
      };
      await assert.rejects(
        fetch(`${f.origin}${path}`, {
          method: 'PUT',
          signal: sender.signal,
          body,
          headers: {
            cookie: f.signed.owner.cookie,
            origin: 'http://localhost:5173',
            'content-type': 'application/octet-stream',
          },
        }),
        { name: 'AbortError' },
      );
      assert.ok(verifying, 'the sender left after the server stored and was verifying the bytes');
      for (let attempt = 0; attempt < 50 && f.object.objects.size !== objects; attempt++) await sleep(100);
      assert.equal(f.object.objects.size, objects, 'the cancelled transfer’s object is removed');
      assert.equal(await rows(id), 0, 'no row commits for a cancelled upload');
      assert.equal(await used(), before, 'a cancelled upload holds no quota');
      assert.equal((await f.call(`${base}/${id}`)).status, 404);

      const retried = await f.call(path, { method: 'PUT', body });
      assert.equal(retried.status, 200, retried.bytes.toString());
      assert.equal(await rows(id), 1);
      assert.equal(await used(), before + body.length, 'retrying the cancelled id uploads it once');
    } finally {
      await f.close();
    }
  },
);

test('Uploads cancelled while storage is slow free their transfer slots at once', { timeout: 180000 }, async () => {
  const f = await knowledgeFixture();
  try {
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    const path = name =>
      `${base}/${randomUUID()}/content?${new URLSearchParams({ name, mediaType: 'text/plain', parentId: 'null' })}`;
    const headers = {
      cookie: f.signed.owner.cookie,
      origin: 'http://localhost:5173',
      'content-type': 'application/octet-stream',
    };
    f.object.faults.writeDelayMs = 5000;
    const senders = Array.from({ length: 4 }, () => new AbortController());
    const sent = senders.map((sender, index) =>
      fetch(`${f.origin}${path(`Slow ${index}.txt`)}`, {
        method: 'PUT',
        signal: sender.signal,
        body: Buffer.from(`slow ${index}`),
        headers,
      }).catch(error => error),
    );
    for (
      let attempt = 0;
      attempt < 100 && f.object.requests.filter(request => request.method === 'PUT').length < 4;
      attempt++
    )
      await sleep(20);
    assert.equal(
      f.object.requests.filter(request => request.method === 'PUT').length,
      4,
      'every upload reached storage before its sender left',
    );
    for (const sender of senders) sender.abort();
    assert.deepEqual(
      (await Promise.all(sent)).map(result => result.name),
      Array(4).fill('AbortError'),
    );
    f.object.faults.writeDelayMs = 0;
    const started = Date.now();
    let next;
    for (let attempt = 0; attempt < 20; attempt++) {
      next = await f.call(path('Next.txt'), { method: 'PUT', body: Buffer.from('next') });
      if (next.status !== 503) break;
      await sleep(25);
    }
    assert.equal(next.status, 200, `the next upload is admitted: ${next.bytes.toString()}`);
    assert.ok(
      Date.now() - started < 1000,
      `cancelled uploads released their slots within a second, not when storage answered (${Date.now() - started}ms)`,
    );
  } finally {
    await f.close();
  }
});

test('Downloads cancelled while storage is slow free their transfer slots at once', { timeout: 180000 }, async () => {
  const f = await knowledgeFixture();
  try {
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    const ids = [];
    for (let index = 0; index < 5; index++) {
      const id = randomUUID();
      const stored = await f.call(
        `${base}/${id}/content?${new URLSearchParams({ name: `Slow ${index}.txt`, mediaType: 'text/plain', parentId: 'null' })}`,
        { method: 'PUT', body: Buffer.from(`slow ${index}`) },
      );
      assert.equal(stored.status, 200, stored.bytes.toString());
      ids.push(id);
    }
    const gets = () => f.object.requests.filter(request => request.method === 'GET').length;
    const before = gets();
    f.object.faults.readDelayMs = 5000;
    const readers = ids.slice(0, 4).map(() => new AbortController());
    const read = readers.map((reader, index) =>
      fetch(`${f.origin}${base}/${ids[index]}/content`, {
        signal: reader.signal,
        headers: { cookie: f.signed.owner.cookie, origin: 'http://localhost:5173' },
      }).catch(error => error),
    );
    for (let attempt = 0; attempt < 100 && gets() - before < 4; attempt++) await sleep(20);
    assert.equal(gets() - before, 4, 'every download reached storage before its reader left');
    for (const reader of readers) reader.abort();
    assert.deepEqual(
      (await Promise.all(read)).map(result => result.name),
      Array(4).fill('AbortError'),
    );
    f.object.faults.readDelayMs = 0;
    const started = Date.now();
    let next;
    for (let attempt = 0; attempt < 20; attempt++) {
      next = await f.call(`${base}/${ids[4]}/content`);
      if (next.status !== 503) break;
      await sleep(25);
    }
    assert.equal(next.status, 200, `the next download is admitted: ${next.bytes.toString()}`);
    assert.equal(next.bytes.toString(), 'slow 4');
    assert.ok(
      Date.now() - started < 1000,
      `cancelled downloads released their slots within a second, not when storage answered (${Date.now() - started}ms)`,
    );
  } finally {
    await f.close();
  }
});
