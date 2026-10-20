import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test('Files directory, owner names, grants, and moves over authenticated HTTP', { timeout: 180000 }, async () => {
  const f = await knowledgeFixture();
  try {
    const base = `/v1/workspaces/${f.workspace.id}/files`;
    const member = await f.signed.signIn();
    const memberMembership = randomUUID(),
      team = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      memberMembership,
      member.id,
    ]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Purchasing')`, [team]);
    await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      memberMembership,
      team,
    ]);
    const names = [
      [f.signed.owner.id, 'Olivia Owner'],
      [f.signed.admin.id, 'Ada Admin'],
      [member.id, 'Milo Member'],
    ];
    for (const [id, name] of names) await f.db.platform.query('UPDATE app.users SET name=$2 WHERE id=$1', [id, name]);
    const emails = Object.fromEntries(
      (
        await f.db.platform.query('SELECT id, email FROM app.users WHERE id = ANY($1)', [names.map(([id]) => id)])
      ).rows.map(row => [row.id, row.email]),
    );
    const owner = f.signed.owner.cookie,
      admin = f.signed.admin.cookie;
    const call = (path, options = {}) => f.call(`${base}${path}`, options);
    const ok = async (path, options) => {
      const result = await call(path, options);
      assert.equal(result.status, 200, `${path}: ${result.bytes.toString()}`);
      return result.json();
    };
    const folder = async (name, parentId = null, cookie = owner) =>
      (await ok(`/${randomUUID()}/folder`, { method: 'PUT', cookie, body: { name, parentId } })).id;
    const share = (id, subject, role, cookie = owner) =>
      ok(`/${id}/sharing`, { method: 'PUT', cookie, body: { subject, role } });
    const person = { kind: 'individual', id: memberMembership },
      purchasing = { kind: 'team', id: team };
    const shared = async cookie => (await ok('/library?section=shared', { cookie })).items.map(item => item.name);

    const contracts = await folder('Contracts');
    assert.deepEqual(
      await ok(`/${contracts}/directory`),
      {
        members: [
          { membershipId: f.workspace.membershipId, name: 'Olivia Owner', email: emails[f.signed.owner.id] },
          { membershipId: f.adminMembership, name: 'Ada Admin', email: emails[f.signed.admin.id] },
          { membershipId: memberMembership, name: 'Milo Member', email: emails[member.id] },
        ],
        teams: [{ id: team, name: 'Purchasing' }],
      },
      'a file manager sees every active member and team by name',
    );
    assert.equal(
      (await call(`/${contracts}/directory`, { cookie: admin })).status,
      404,
      'workspace admin status grants no directory read on a private file',
    );
    assert.equal((await call(`/${contracts}/directory`, { cookie: member.cookie })).status, 404);
    assert.equal(
      (await call(`/${contracts}/details`, { cookie: admin })).status,
      404,
      'workspace admin status grants no details read',
    );

    await share(contracts, person, 'viewer');
    assert.deepEqual(await shared(member.cookie), ['Contracts'], 'a direct grant adds the folder to Shared with me');
    const page = await ok('/library?section=shared', { cookie: member.cookie });
    assert.deepEqual(
      page.owners,
      [{ membershipId: f.workspace.membershipId, name: 'Olivia Owner' }],
      'the library names each owner on the page',
    );
    assert.equal(
      (await call(`/${contracts}/directory`, { cookie: member.cookie })).status,
      404,
      'a viewer cannot read the directory',
    );
    await share(contracts, person, 'editor');
    assert.equal(
      (await call(`/${contracts}/directory`, { cookie: member.cookie })).status,
      404,
      'an editor cannot read the directory',
    );
    await share(contracts, person, null);
    assert.deepEqual(await shared(member.cookie), [], 'removing the grant removes the folder from Shared with me');

    await share(contracts, purchasing, 'manager');
    assert.deepEqual(await shared(member.cookie), ['Contracts'], 'a team grant reaches its members');
    assert.equal(
      (await ok(`/${contracts}/directory`, { cookie: member.cookie })).members.length,
      3,
      'a team manager can pick members to share with',
    );
    const nested = await folder('Supplier terms', contracts);
    assert.deepEqual(await ok(`/${nested}/details`, { cookie: member.cookie }), {
      item: {
        id: nested,
        kind: 'folder',
        name: 'Supplier terms',
        parentId: contracts,
        creatorMembershipId: f.workspace.membershipId,
        mediaType: null,
        size: null,
        trashed: false,
        role: 'manager',
        deletion: null,
      },
      owner: { membershipId: f.workspace.membershipId, name: 'Olivia Owner' },
      path: [
        {
          id: contracts,
          kind: 'folder',
          name: 'Contracts',
          parentId: null,
          creatorMembershipId: f.workspace.membershipId,
          mediaType: null,
          size: null,
          trashed: false,
          role: 'manager',
          deletion: null,
        },
      ],
      pathRestricted: false,
    });
    const sharing = await ok(`/${nested}/sharing`, { cookie: member.cookie });
    assert.deepEqual(
      sharing.inherited,
      [
        {
          kind: 'ownership',
          source: { kind: 'readable', id: contracts, name: 'Contracts' },
          owner: { membershipId: f.workspace.membershipId, active: true },
        },
        {
          kind: 'grant',
          source: { kind: 'readable', id: contracts, name: 'Contracts' },
          grant: { subject: purchasing, role: 'manager' },
        },
      ],
      'inherited access names its source folder',
    );
    await share(contracts, purchasing, null);
    assert.deepEqual(await shared(member.cookie), [], 'removing the team grant removes the folder');

    const hidden = await folder('Owner private');
    const branch = await folder('Shared branch', hidden);
    await share(branch, person, 'viewer');
    const restricted = await ok(`/${branch}/details`, { cookie: member.cookie });
    assert.deepEqual(
      [restricted.path, restricted.pathRestricted],
      [[], true],
      'details conceal ancestors the reader cannot open',
    );

    const draft = await folder('Draft');
    const destination = await folder('Team space');
    await share(destination, person, 'viewer');
    const preview = await ok(`/${draft}/move-audience`, { method: 'POST', body: { parentId: destination } });
    const roles = audience => Object.fromEntries(audience.map(entry => [entry.membershipId, entry.role]));
    assert.deepEqual(
      preview.subtree.map(entry => [roles(entry.before.audience), roles(entry.after.audience)]),
      [
        [
          { [f.workspace.membershipId]: 'manager' },
          { [f.workspace.membershipId]: 'manager', [memberMembership]: 'viewer' },
        ],
      ],
      'the audience review shows who gains access before the move',
    );
    await share(destination, { kind: 'individual', id: f.adminMembership }, 'viewer');
    const stale = await call(`/${draft}/parent`, {
      method: 'PUT',
      body: { parentId: destination, fingerprint: preview.fingerprint },
    });
    assert.deepEqual(
      [stale.status, stale.json()],
      [409, { error: 'file-conflict' }],
      'an audience change after review rejects the stale fingerprint',
    );
    assert.equal((await ok(`/${draft}/details`)).item.parentId, null, 'a rejected move keeps the item in place');
    const fresh = await ok(`/${draft}/move-audience`, { method: 'POST', body: { parentId: destination } });
    assert.deepEqual(roles(fresh.subtree[0].after.audience), {
      [f.workspace.membershipId]: 'manager',
      [f.adminMembership]: 'viewer',
      [memberMembership]: 'viewer',
    });
    assert.deepEqual(
      await ok(`/${draft}/parent`, { method: 'PUT', body: { parentId: destination, fingerprint: fresh.fingerprint } }),
      { id: draft, parentId: destination },
    );
    assert.deepEqual(
      (await ok(`/library?section=shared&folder=${destination}`, { cookie: member.cookie })).items.map(
        item => item.name,
      ),
      ['Draft'],
      'the moved folder inherits the destination audience',
    );
    assert.equal(
      (await call(`/${draft}/move-audience`, { method: 'POST', cookie: member.cookie, body: { parentId: null } }))
        .status,
      404,
      'a viewer cannot move the item',
    );

    await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at = now() WHERE id = $1`, [
      f.adminMembership,
    ]);
    const adminFolder = await f.db.platform.query(
      `INSERT INTO ${f.table('tf_files')} (id,kind,creator_membership_id,parent_id,name,ready) VALUES ($1,'folder',$2,NULL,'Left behind',true) RETURNING id`,
      [randomUUID(), f.adminMembership],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_file_grants')} (item_id,subject_kind,subject_id,role) VALUES ($1,'individual',$2,'viewer')`,
      [adminFolder.rows[0].id, memberMembership],
    );
    const left = await ok('/library?section=shared', { cookie: member.cookie });
    assert.deepEqual(
      [left.items.map(item => item.name), left.owners],
      [
        ['Left behind', 'Shared branch', 'Team space'],
        [{ membershipId: f.workspace.membershipId, name: 'Olivia Owner' }],
      ],
      'a removed member is not named; the client labels them a former member',
    );
    assert.deepEqual(
      (await ok(`/${contracts}/directory`)).members.map(entry => entry.name),
      ['Olivia Owner', 'Milo Member'],
      'the directory lists only active members',
    );
  } finally {
    await f.close();
  }
});
