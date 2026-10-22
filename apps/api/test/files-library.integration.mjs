import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test(
  'Files library sections, folders, search, trash, and pagination over authenticated HTTP',
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const owner = f.signed.owner.cookie,
        admin = f.signed.admin.cookie;
      const adminMembership = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [f.signed.admin.id])
      ).rows[0].id;
      const ok = async (path, options) => {
        const result = await f.call(`${base}${path}`, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const folder = async (name, parentId = null, cookie = owner) =>
        (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
      const share = (id, membershipId, role, cookie) =>
        ok(`/${id}/sharing`, {
          method: 'PUT',
          cookie,
          body: { subject: { kind: 'individual', id: membershipId }, role },
        });
      const trash = (id, trashed, cookie = owner) => ok(`/${id}/trash`, { method: 'PUT', cookie, body: { trashed } });
      const page = (input, cookie = owner) => ok(`/library?${new URLSearchParams(input)}`, { cookie });
      const ids = async (input, cookie = owner) => (await page(input, cookie)).items.map(item => item.id);
      async function everything(input, cookie = owner) {
        const found = [];
        let after,
          pages = 0;
        do {
          const result = await page({ ...input, ...(after ? { after } : {}) }, cookie);
          assert.ok(result.items.length <= 100);
          if (result.next) assert.equal(result.items.length, 100, 'a page with a continuation is full');
          found.push(...result.items.map(item => item.id));
          after = result.next;
          pages++;
        } while (after);
        return { found, pages };
      }

      const own = await folder('Owned folder');
      const child = await folder('Owned child', own);
      const privateFolder = await folder('Owner private');
      await share(own, adminMembership, 'editor', owner);
      const guest = await folder('Guest folder', own, admin);
      const foreign = await folder('Shared folder', null, admin);
      await share(foreign, f.workspace.membershipId, 'editor', admin);
      const foreignChild = await folder('Shared child', foreign, admin);
      const stranded = await folder('Owned in shared folder', foreign);
      const hidden = await folder('Admin private', null, admin);
      const direct = await folder('Shared private branch', hidden, admin);
      await share(direct, f.workspace.membershipId, 'viewer', admin);
      const directChild = await folder('Branch child', direct, admin);

      assert.deepEqual(
        await ids({ section: 'mine' }),
        [own, stranded, privateFolder],
        "My files lists owned roots and owned items stranded in other owners' folders",
      );
      assert.deepEqual(
        await ids({ section: 'shared' }),
        [foreign, direct],
        'Shared with me lists entry points, not their descendants',
      );
      assert.deepEqual(
        await ids({ section: 'mine', folder: own }),
        [guest, child],
        'a folder lists every readable child regardless of owner',
      );
      assert.deepEqual(await ids({ section: 'shared', folder: foreign }), [stranded, foreignChild]);
      assert.deepEqual(
        await ids({ section: 'mine', query: 'CHILD' }),
        [child],
        'section search covers nested items in that section only',
      );
      assert.deepEqual(await ids({ section: 'shared', query: 'child' }), [directChild, foreignChild]);
      const crumbs = await page({ section: 'shared', folder: directChild });
      assert.deepEqual(
        crumbs.breadcrumbs.map(item => [item.id, item.name, item.role]),
        [
          [direct, 'Shared private branch', 'viewer'],
          [directChild, 'Branch child', 'viewer'],
        ],
        'breadcrumbs stop below an ancestor the reader cannot open',
      );
      assert.equal(crumbs.breadcrumbs[0].parentId, hidden);

      assert.deepEqual(
        await ids({ section: 'mine' }, admin),
        [hidden, guest, foreign],
        'admin My files holds only what the admin created',
      );
      assert.deepEqual(
        await ids({ section: 'shared' }, admin),
        [own],
        'workspace admin role grants no access to unshared files',
      );
      assert.deepEqual(
        await ids({ section: 'shared', query: 'owne' }, admin),
        [child, own],
        "admin search reaches shared items but not the owner's private folder",
      );
      assert.equal(
        (await f.call(`${base}/library?section=mine&folder=${privateFolder}`, { cookie: admin })).status,
        404,
      );
      assert.equal((await f.call(`${base}/library?section=mine&folder=${hidden}`)).status, 404);

      const mineBulk = Array.from({ length: 150 }, () => randomUUID()).sort();
      const sharedBulk = Array.from({ length: 150 }, () => randomUUID()).sort();
      const insert = (rows, membershipId, parentId) =>
        f.db.platform.query(
          `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready,object_key,media_type,size,sha256)
      SELECT id,'file',$2,$3,'Duplicate.txt',true,id,'text/plain',1,repeat('a',64) FROM unnest($1::uuid[]) id`,
          [rows, membershipId, parentId],
        );
      await insert(mineBulk, f.workspace.membershipId, null);
      await insert(sharedBulk, adminMembership, null);
      await insert(
        Array.from({ length: 150 }, () => randomUUID()),
        adminMembership,
        foreign,
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_file_grants')} (item_id,subject_kind,subject_id,role) SELECT id,'individual',$2,'viewer' FROM unnest($1::uuid[]) id`,
        [sharedBulk, f.workspace.membershipId],
      );
      assert.deepEqual(
        await everything({ section: 'mine' }),
        { found: [own, stranded, privateFolder, ...mineBulk], pages: 2 },
        'roots are filtered before pagination; duplicate names page by id without gaps or repeats',
      );
      assert.deepEqual(
        await everything({ section: 'shared' }),
        { found: [foreign, direct, ...sharedBulk], pages: 2 },
        'descendants of a listed shared folder never fill a Shared with me page',
      );

      const discarded = await folder('Discarded', own);
      await folder('Inside discarded', discarded);
      await trash(discarded, true);
      await trash(foreignChild, true, admin);
      assert.deepEqual(await ids({ section: 'trash' }), [discarded], 'Trash lists trashed roots the reader manages');
      assert.deepEqual(
        await ids({ section: 'trash' }, admin),
        [foreignChild],
        "an editor of the parent folder cannot manage another owner's trash",
      );
      assert.equal((await f.call(`${base}/library?section=trash&folder=${discarded}`)).status, 404);
      assert.ok(!(await ids({ section: 'mine', folder: own })).includes(discarded));
      await trash(discarded, false);
      assert.deepEqual(await ids({ section: 'trash' }), []);
      assert.ok(
        (await ids({ section: 'mine', folder: own })).includes(discarded),
        'restore returns the folder to its parent',
      );

      const legacy = await ok(`?parentId=${own}`);
      assert.deepEqual(
        new Set(legacy.items.map(item => item.id)),
        new Set([child, guest, discarded]),
        'Knowledge picker list() keeps explicit-parent semantics',
      );

      await share(foreign, f.workspace.membershipId, null, admin);
      assert.deepEqual(
        (await everything({ section: 'shared' })).found,
        [direct, ...sharedBulk],
        'revoked shares disappear',
      );
      assert.deepEqual(
        (await everything({ section: 'mine' })).found.slice(0, 3),
        [own, stranded, privateFolder],
        'an owned item in an unreachable folder still surfaces',
      );
      assert.equal((await f.call(`${base}/library?section=shared&folder=${foreign}`)).status, 404);
    } finally {
      await f.close();
    }
  },
);

test(
  'Files library cursors are opaque, follow locale order, and reject items the reader cannot reach',
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const owner = f.signed.owner.cookie,
        admin = f.signed.admin.cookie;
      const ok = async (path, options) => {
        const result = await f.call(`${base}${path}`, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const folder = async (name, parentId = null, cookie = owner) =>
        (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
      const page = (input, cookie = owner) => ok(`/library?${new URLSearchParams(input)}`, { cookie });

      const sorted = await folder('Sorted');
      for (const name of ['zebra', '供应商', 'école', 'Äpfel', 'banana', 'Zoo']) await folder(name, sorted);
      assert.deepEqual(
        (await page({ section: 'mine', folder: sorted })).items.map(item => item.name),
        ['Äpfel', 'banana', 'école', 'zebra', 'Zoo', '供应商'],
        'accented names sort with their base letters; case does not split the alphabet',
      );

      const names = Array.from(
        { length: 160 },
        (_, index) => `${['Ä', 'a', 'É', 'e', 'Ö', 'o', '供', 'z'][index % 8]}${String(index).padStart(3, '0')} secret`,
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready,object_key,media_type,size,sha256)
      SELECT gen_random_uuid(),'file',$2,$3,name,true,gen_random_uuid(),'text/plain',1,repeat('a',64) FROM unnest($1::text[]) name`,
        [names, f.workspace.membershipId, sorted],
      );
      const first = await page({ section: 'mine', folder: sorted });
      assert.equal(first.items.length, 100);
      assert.equal(first.next, first.items.at(-1).id, 'the cursor is the last item id and nothing else');
      assert.ok(
        !first.next.includes('secret') && !Buffer.from(first.next, 'base64url').toString('latin1').includes('secret'),
      );
      const second = await page({ section: 'mine', folder: sorted, after: first.next });
      assert.equal(second.next, null);
      const walked = [...first.items, ...second.items].map(item => item.name);
      assert.equal(new Set(walked).size, 166, 'no item repeats or goes missing across the page boundary');
      assert.deepEqual(
        walked.slice(6),
        walked.slice(6).sort((a, b) => a.localeCompare(b, 'und')),
        'files page in locale order after folders',
      );

      const invalid = async (after, cookie = owner) => {
        const result = await f.call(`${base}/library?section=mine&after=${after}`, { cookie });
        assert.equal(result.status, 400);
        return result.json();
      };
      assert.deepEqual(await invalid('not-a-cursor'), { error: 'invalid-request' });
      assert.deepEqual(
        await invalid(randomUUID()),
        { error: 'file-invalid-cursor' },
        'an unknown id is an invalid link',
      );
      assert.deepEqual(
        await invalid(first.next, admin),
        { error: 'file-invalid-cursor' },
        "another member's private item cannot position a page",
      );
      const inaccessible = await folder('Admin only', null, admin);
      assert.deepEqual(await invalid(inaccessible), { error: 'file-invalid-cursor' });
    } finally {
      await f.close();
    }
  },
);

test(
  "owned items under another owner's trashed folder surface in Trash and restore to a chosen destination",
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const owner = f.signed.owner.cookie,
        admin = f.signed.admin.cookie;
      const ok = async (path, options) => {
        const result = await f.call(`${base}${path}`, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const folder = async (name, parentId = null, cookie = owner) =>
        (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
      const trash = (id, trashed, cookie = owner) => ok(`/${id}/trash`, { method: 'PUT', cookie, body: { trashed } });
      const page = (input, cookie = owner) => ok(`/library?${new URLSearchParams(input)}`, { cookie });
      const rows = async (input, cookie = owner) =>
        (await page(input, cookie)).items.map(item => [item.name, item.trashed, item.stranded]);
      const restore = async (id, parentId, cookie = owner) => {
        const preview = await ok(`/${id}/move-audience`, { method: 'POST', cookie, body: { parentId } });
        const self = preview.subtree.find(entry => entry.item.id === id);
        assert.deepEqual(
          [self.before.availability, self.after.availability],
          ['unavailable', 'available'],
          'the access review names the restored item and shows it becoming available',
        );
        return ok(`/${id}/parent`, { method: 'PUT', cookie, body: { parentId, fingerprint: preview.fingerprint } });
      };

      const team = await folder('Team drop', null, admin);
      await ok(`/${team}/sharing`, {
        method: 'PUT',
        cookie: admin,
        body: { subject: { kind: 'individual', id: f.workspace.membershipId }, role: 'editor' },
      });
      const drafts = await folder('My drafts', team);
      const nested = await folder('Draft child', drafts);
      const discarded = await folder('Already discarded', team);
      await trash(discarded, true);
      const destination = await folder('Archive');
      await trash(team, true, admin);

      assert.deepEqual(
        await rows({ section: 'trash' }),
        [
          ['Already discarded', true, true],
          ['My drafts', false, true],
        ],
        "the owner's topmost items below the trashed folder appear once in Trash, marked stranded",
      );
      assert.deepEqual(await rows({ section: 'trash' }, admin), [['Team drop', true, false]]);
      assert.deepEqual(await rows({ section: 'mine' }), [['Archive', false, false]]);
      assert.deepEqual(await rows({ section: 'trash', query: 'draft' }), [['My drafts', false, true]]);
      assert.equal(
        (await f.call(`${base}/${drafts}`)).status,
        404,
        'a stranded item stays closed until it is restored',
      );
      assert.equal(
        (await f.call(`${base}/${drafts}/move-audience`, { method: 'POST', cookie: admin, body: { parentId: null } }))
          .status,
        404,
        'only the owner can restore it',
      );
      assert.equal(
        (await f.call(`${base}/${drafts}/move-audience`, { method: 'POST', body: { parentId: team } })).status,
        404,
        'the trashed folder is not a destination',
      );

      await restore(drafts, null);
      await restore(discarded, destination);
      assert.deepEqual(await rows({ section: 'trash' }), []);
      assert.deepEqual(await rows({ section: 'mine' }), [
        ['Archive', false, false],
        ['My drafts', false, false],
      ]);
      assert.deepEqual(
        await rows({ section: 'mine', folder: destination }),
        [['Already discarded', false, false]],
        'a restore into a chosen folder also clears its own trash mark',
      );
      assert.equal((await ok(`/${nested}`)).parentId, drafts, 'descendants come back with the restored item');
      assert.deepEqual(
        await rows({ section: 'trash' }, admin),
        [['Team drop', true, false]],
        "the other owner's folder stays in its owner's Trash",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'Files library sorts and filters before pagination across mixed owners and keeps cursors stable',
  { timeout: 180000 },
  async () => {
    const f = await knowledgeFixture();
    try {
      const base = `/v1/workspaces/${f.workspace.id}/files`;
      const owner = f.signed.owner.cookie,
        admin = f.signed.admin.cookie;
      const me = f.workspace.membershipId;
      const adminMembership = (
        await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [f.signed.admin.id])
      ).rows[0].id;
      const ok = async (path, options) => {
        const result = await f.call(`${base}${path}`, options);
        assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
        return result.json();
      };
      const mixed = (
        await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie: owner, body: { name: 'Mixed', parentId: null } })
      ).id;
      await ok(`/${mixed}/sharing`, {
        method: 'PUT',
        cookie: owner,
        body: { subject: { kind: 'individual', id: adminMembership }, role: 'editor' },
      });

      const types = [
        ['pdf', 'application/pdf', 'pdf'],
        ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
        ['png', 'image/png', 'image'],
        ['docx', 'application/octet-stream', 'document'],
        ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
        ['zip', 'application/zip', 'other'],
      ];
      const hour = 3_600_000_000n,
        start = Date.parse('2026-01-01T00:00:00Z');
      // Offsets in microseconds: duplicates exercise the id tiebreak, the n % 3 microseconds prove the cursor keeps PostgreSQL precision.
      const rows = Array.from({ length: 236 }, (_, n) => {
        const [extension, mediaType, type] = types[n % types.length];
        const folder = n < 6;
        return {
          id: randomUUID(),
          kind: folder ? 'folder' : 'file',
          owner: n % 2 ? adminMembership : me,
          type: folder ? 'folder' : type,
          mediaType: folder ? null : mediaType,
          name: folder
            ? `Folder ${n}`
            : n % 9 === 0
              ? `Same.${extension}`
              : `Item ${String(n).padStart(3, '0')}.${extension}`,
          modified: n % 7 === 0 ? null : BigInt(n % 40) * hour + BigInt(n % 3),
        };
      });
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready,object_key,media_type,size,sha256,modified_at)
      SELECT r.id, r.kind, r.owner, $2, r.name, true, CASE WHEN r.kind = 'file' THEN r.id END, r.media_type, CASE WHEN r.kind = 'file' THEN 1 END,
        CASE WHEN r.kind = 'file' THEN repeat('a',64) END, $3::timestamptz + r.offset_us * interval '1 microsecond'
      FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, kind text, owner uuid, name text, media_type text, offset_us bigint)`,
        [
          JSON.stringify(
            rows.map(row => ({
              id: row.id,
              kind: row.kind,
              owner: row.owner,
              name: row.name,
              media_type: row.mediaType,
              offset_us: row.modified === null ? null : String(row.modified),
            })),
          ),
          mixed,
          new Date(start).toISOString(),
        ],
      );

      const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      function expected({
        sort = 'name',
        order = sort === 'modified' ? 'desc' : 'asc',
        type,
        owner: who,
        from,
        before,
      }) {
        const direction = order === 'asc' ? 1 : -1,
          unknown = order === 'asc' ? Infinity : -Infinity;
        return rows
          .filter(
            row =>
              (!type || row.type === type) &&
              (!who || (who === 'me' ? row.owner === me : who === 'others' ? row.owner !== me : row.owner === who)) &&
              (from === undefined || (row.modified !== null && row.modified >= from)) &&
              (before === undefined || (row.modified !== null && row.modified < before)),
          )
          .sort(
            (a, b) =>
              (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) ||
              direction *
                (sort === 'name' ? compare(a.name, b.name) : compare(a.modified ?? unknown, b.modified ?? unknown)) ||
              direction * compare(a.id, b.id),
          )
          .map(row => row.id);
      }
      const at = offset => new Date(start + Number(offset / 1000n)).toISOString();
      async function walk(input, cookie = owner) {
        const found = [];
        let after,
          pages = 0,
          owners;
        const query = { section: 'mine', folder: mixed, ...input };
        if (input.from !== undefined) {
          delete query.from;
          query.modifiedFrom = at(input.from);
        }
        if (input.before !== undefined) {
          delete query.before;
          query.modifiedBefore = at(input.before);
        }
        do {
          const result = await ok(`/library?${new URLSearchParams({ ...query, ...(after ? { after } : {}) })}`, {
            cookie,
          });
          if (result.next) assert.equal(result.items.length, 100, 'a page with a continuation is full');
          found.push(...result.items.map(item => item.id));
          after = result.next;
          pages++;
          owners ??= result.owners.map(person => person.membershipId).sort();
        } while (after);
        return { found, pages, owners };
      }

      const cases = [
        {},
        { order: 'desc' },
        { sort: 'modified' },
        { sort: 'modified', order: 'asc' },
        { type: 'pdf' },
        { type: 'folder', sort: 'modified' },
        { type: 'document', order: 'desc' },
        { type: 'other', sort: 'modified', order: 'asc' },
        { owner: 'me', sort: 'modified' },
        { owner: 'others' },
        { owner: adminMembership, sort: 'modified', order: 'asc' },
        { from: 10n * hour, before: 20n * hour, sort: 'modified' },
        { from: 10n * hour + 1n, owner: 'others', order: 'desc' },
      ];
      for (const input of cases) {
        const result = await walk(input);
        const want = expected(input);
        assert.deepEqual(
          result.found,
          want,
          `walk ${JSON.stringify(input, (_key, value) => (typeof value === 'bigint' ? String(value) : value))}`,
        );
        assert.equal(result.pages, Math.max(1, Math.ceil(want.length / 100)));
        assert.deepEqual(
          result.owners,
          [adminMembership, me].sort(),
          `owner choices list every owner in the folder before filters apply: ${JSON.stringify(input, (_key, value) => (typeof value === 'bigint' ? String(value) : value))}`,
        );
      }
      assert.equal(expected({}).length, 236);
      assert.equal(
        expected({ type: 'document' }).length,
        38,
        'a .docx sent as octet-stream counts as a document by its extension',
      );

      const editor = await walk({ owner: 'me', sort: 'modified' }, admin);
      assert.deepEqual(
        editor.found,
        expected({ owner: adminMembership, sort: 'modified' }),
        '"me" is the reader, not the folder owner',
      );

      const sample = rows.find(row => row.kind === 'file' && row.modified !== null && row.modified % 3n === 0n);
      const listed = (
        await ok(`/library?${new URLSearchParams({ section: 'mine', folder: mixed, query: sample.name })}`, {
          cookie: owner,
        })
      ).items.find(item => item.id === sample.id);
      assert.equal(listed.modifiedAt, at(sample.modified));
      assert.equal(listed.parentName, 'Mixed');
      const unknown = (
        await ok(`/library?${new URLSearchParams({ section: 'mine', folder: mixed, query: rows[7].name })}`, {
          cookie: owner,
        })
      ).items.find(item => item.id === rows[7].id);
      assert.equal(unknown.modifiedAt, null);

      for (const query of ['type=video', 'owner=someone', 'modifiedFrom=yesterday', 'sort=size', 'order=up']) {
        assert.deepEqual(
          await (await f.call(`${base}/library?section=mine&${query}`, { cookie: owner })).json(),
          { error: 'invalid-request' },
          query,
        );
      }
    } finally {
      await f.close();
    }
  },
);
