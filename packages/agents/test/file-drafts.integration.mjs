import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAuthoringDrafts } from '../src/drafts.ts';
import { createChatTools } from '../src/tools.ts';
import { createFiles, FileError } from '../../files/src/index.ts';
import { AgentError } from '../src/saved-contracts.ts';

async function setup(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const w = await db.create(await workspaceTableMigrations());
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const chats = createConversations(runtime),
    chatId = randomUUID();
  await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
  async function tool(call) {
    const sent = await chats.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Tidy my files.' }],
    });
    let output;
    const executor = createConversationExecutor(runtime, async ({ executeTool }) => {
      output = (
        await executeTool(
          call.tool,
          false,
          context => createChatTools(context.runtime).invokeWithSources(context, call),
          [],
          call,
        )
      ).result;
      return { text: 'Review the card.', sources: [] };
    });
    await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    return output;
  }
  const drafts = createAuthoringDrafts(runtime);
  async function approve(proposed) {
    assert.equal((await drafts.read(w.id, w.userId, chatId, proposed.draftId)).status, 'pending');
    const decision = { commandId: randomUUID(), digest: proposed.digest, decision: 'save' };
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    await drafts.decide(w.id, w.userId, chatId, proposed.draftId, decision);
    return drafts.read(w.id, w.userId, chatId, proposed.draftId);
  }
  return { db, w, runtime, chatId, drafts, tool, approve, table: name => qualified(w.names.schema, name) };
}

function library(runtime, w) {
  const objects = new Map();
  const files = createFiles(runtime, {
    putIfAbsent: async (key, body) => void objects.set(key, Buffer.from(body)),
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  });
  return {
    files,
    folder: (name, parentId = null, user = w.userId) =>
      files.createFolder(w.id, user, randomUUID(), { name, parentId }),
    upload: (name, parentId = null, user = w.userId) =>
      files.upload(w.id, user, randomUUID(), { name, parentId, mediaType: 'text/plain' }, Buffer.from('notes')),
  };
}

test('chat finds, renames, moves, trashes and restores files only after the human approves each card', async t => {
  const { db, w, runtime, chatId, drafts, tool, approve, table } = await setup(t);
  const { files, folder, upload } = library(runtime, w);
  const archive = await folder('Archive');
  const plan = await upload('Plan.txt');
  const notes = await upload('Notes.txt');
  const where = async id => {
    const [row] = (
      await db.platform.query(
        `SELECT name, parent_id AS "parentId", trashed_at IS NOT NULL AS trashed FROM ${table('tf_files')} WHERE id=$1`,
        [id],
      )
    ).rows;
    return row;
  };

  const top = await tool({ tool: 'files.list', folderId: null });
  assert.deepEqual(top.items.map(item => item.name).sort(), ['Archive', 'Notes.txt', 'Plan.txt']);
  assert.equal(top.items.find(item => item.id === plan.id).role, 'manager');
  assert.deepEqual(
    (await tool({ tool: 'files.list', query: 'plan' })).items.map(item => item.id),
    [plan.id],
  );

  assert.equal((await tool({ tool: 'files.rename', fileId: plan.id, name: 'Plan.txt' })).error, 'no-change');
  assert.equal((await tool({ tool: 'files.rename', fileId: plan.id, name: 'a/b' })).error, 'invalid-name');
  assert.equal((await tool({ tool: 'files.trash', fileIds: [plan.id, plan.id] })).error, 'invalid-arguments');
  assert.equal((await tool({ tool: 'files.trash', fileIds: [randomUUID()] })).error, 'file-not-found');
  assert.equal((await tool({ tool: 'files.restore', fileIds: [plan.id] })).error, 'file-not-trashed');

  const rename = await tool({ tool: 'files.rename', fileId: plan.id, name: 'Launch plan.txt' });
  const card = await drafts.read(w.id, w.userId, chatId, rename.draftId);
  assert.equal(card.proposal.kind, 'files');
  assert.deepEqual(card.proposal.input.change, { kind: 'rename', name: 'Launch plan.txt' });
  assert.equal((await where(plan.id)).name, 'Plan.txt', 'proposing renames nothing');
  assert.equal((await approve(rename)).status, 'saved');
  assert.equal((await where(plan.id)).name, 'Launch plan.txt');

  const move = await tool({ tool: 'files.move', fileIds: [plan.id, notes.id], folderId: archive.id });
  assert.deepEqual((await drafts.read(w.id, w.userId, chatId, move.draftId)).proposal.input.change, {
    kind: 'move',
    parentId: archive.id,
    parentName: 'Archive',
  });
  assert.equal((await where(notes.id)).parentId, null, 'proposing moves nothing');
  assert.equal((await approve(move)).status, 'saved');
  assert.deepEqual([(await where(plan.id)).parentId, (await where(notes.id)).parentId], [archive.id, archive.id]);
  assert.equal((await tool({ tool: 'files.move', fileIds: [archive.id], folderId: archive.id })).error, 'invalid-move');

  const stale = await tool({ tool: 'files.rename', fileId: notes.id, name: 'Old notes.txt' });
  await files.rename(w.id, w.userId, notes.id, 'Renamed elsewhere.txt');
  assert.equal((await drafts.read(w.id, w.userId, chatId, stale.draftId)).status, 'stale');
  await drafts
    .decide(w.id, w.userId, chatId, stale.draftId, { commandId: randomUUID(), digest: stale.digest, decision: 'save' })
    .catch(() => {});
  assert.equal((await where(notes.id)).name, 'Renamed elsewhere.txt');

  const trash = await tool({ tool: 'files.trash', fileIds: [archive.id] });
  assert.equal((await where(archive.id)).trashed, false, 'proposing trashes nothing');
  assert.equal((await approve(trash)).status, 'saved');
  assert.equal((await where(archive.id)).trashed, true);
  assert.deepEqual((await tool({ tool: 'files.list', folderId: null })).items, []);
  assert.deepEqual(
    (await tool({ tool: 'files.list', trash: true })).items.map(item => item.id),
    [archive.id],
  );
  assert.equal((await tool({ tool: 'files.rename', fileId: archive.id, name: 'Old' })).error, 'file-trashed');

  const restore = await tool({ tool: 'files.restore', fileIds: [archive.id] });
  assert.equal((await approve(restore)).status, 'saved');
  assert.equal((await where(archive.id)).trashed, false);
  assert.deepEqual((await tool({ tool: 'files.list', folderId: archive.id })).items.map(item => item.name).sort(), [
    'Launch plan.txt',
    'Renamed elsewhere.txt',
  ]);

  const other = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,'other','member')`, [
    other,
  ]);
  const [{ id: mine }] = (
    await db.platform.query(`SELECT id FROM ${table('tf_memberships')} WHERE user_id=$1`, [w.userId])
  ).rows;
  const shared = await upload('Shared.txt', null, 'other');
  await files.share(w.id, 'other', shared.id, { kind: 'individual', id: mine }, 'viewer');
  assert.equal(
    (await tool({ tool: 'files.list', query: 'shared' })).items.find(item => item.id === shared.id).role,
    'viewer',
  );
  const refused = await tool({ tool: 'files.trash', fileIds: [shared.id] });
  assert.equal(refused.error, 'file-manager-required');
  const hidden = await upload('Hidden.txt', null, 'other');
  const unseen = await tool({ tool: 'files.trash', fileIds: [hidden.id] });
  assert.equal(unseen.error, 'file-not-found');
  assert.equal(JSON.stringify(unseen).includes('Hidden'), false, 'an item the human cannot see is never named');
});

test('chat lists every team with its people, without plan documents, and hides people the asker cannot see', async t => {
  const flagsOff = process.env.FEATURE_FLAGS_OFF;
  process.env.FEATURE_FLAGS_OFF = 'plan-documents';
  t.after(() =>
    flagsOff === undefined ? delete process.env.FEATURE_FLAGS_OFF : (process.env.FEATURE_FLAGS_OFF = flagsOff),
  );
  const { db, w, tool, table } = await setup(t);
  const [{ id: mine }] = (
    await db.platform.query(`SELECT id FROM ${table('tf_memberships')} WHERE user_id=$1`, [w.userId])
  ).rows;
  const [ana, ben, gone] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, user] of [
    [ana, 'ana'],
    [ben, 'ben'],
    [gone, 'gone'],
  ])
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      id,
      user,
    ]);
  await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [gone]);
  const [{ id: admins }] = (await db.platform.query(`SELECT id FROM ${table('tf_teams')} WHERE name='_admin'`)).rows;
  const [ops, sales] = [randomUUID(), randomUUID()];
  for (const [id, name] of [
    [ops, 'Ops'],
    [sales, 'Sales'],
  ])
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,$2)`, [id, name]);
  for (const [team, member, role] of [
    [ops, mine, 'manager'],
    [ops, ana, 'member'],
    [ops, gone, 'member'],
    [sales, ben, 'member'],
  ])
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (team_id,membership_id,role) VALUES ($1,$2,$3)`, [
      team,
      member,
      role,
    ]);
  const people = result =>
    Object.fromEntries(
      result.teams.map(team => [
        team.name,
        Array.isArray(team.people) ? team.people.map(person => [person.membershipId, person.role]) : team.people,
      ]),
    );

  const pendingEmail = 'pending@example.test';
  await db.platform.query(
    `INSERT INTO ${table('tf_invitations')} (id,issuer_membership_id,kind,email,token_hash,assignments)
     VALUES ($1,$2,'email',$3,$4,$5)`,
    [
      randomUUID(),
      mine,
      pendingEmail,
      '0'.repeat(64),
      { teams: [{ id: ops, name: 'Ops', role: 'member' }], policies: [] },
    ],
  );
  const asAdmin = await tool({ tool: 'members.find' });
  assert.equal(asAdmin.error, undefined, 'the lookup does not depend on plan documents');
  assert.deepEqual(
    asAdmin.pendingInvitations.map(invite => [invite.email, invite.status, invite.teams]),
    [[pendingEmail, 'pending', [{ name: 'Ops', role: 'member' }]]],
    'an admin sees open invitations and the teams they join',
  );
  assert.equal(asAdmin.pendingInvitationCount, 1);
  assert.deepEqual([asAdmin.memberCount, asAdmin.teamCount, asAdmin.truncated], [3, 3, false]);
  const filtered = await tool({ tool: 'members.find', query: 'Ops and Sales' });
  assert.equal(filtered.scope, 'filtered');
  assert.deepEqual([filtered.memberCount, filtered.teamCount], [0, 2]);
  assert.deepEqual([filtered.workspaceMemberCount, filtered.workspaceTeamCount], [3, 3]);
  assert.equal(asAdmin.scope, 'workspace');
  const adminView = people(asAdmin);
  assert.deepEqual(
    [adminView.Ops, adminView.Sales],
    [
      [
        [mine, 'manager'],
        [ana, 'member'],
      ],
      [[ben, 'member']],
    ],
  );
  assert.ok(Array.isArray(adminView['Workspace admins']), 'the admins team shows under its display name');
  assert.deepEqual(
    (await tool({ tool: 'members.find', query: 'workspace admins' })).teams.map(team => team.teamId),
    [admins],
  );

  await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member' WHERE id=$1`, [mine]);
  const asMember = await tool({ tool: 'members.find' });
  assert.equal(asMember.pendingInvitations, 'not-visible');
  assert.ok(!JSON.stringify(asMember).includes(pendingEmail));
  const memberView = people(asMember);
  assert.deepEqual(
    [memberView.Ops, memberView.Sales],
    [
      [
        [mine, 'manager'],
        [ana, 'member'],
      ],
      'not-visible',
    ],
    'a member sees who is in their own teams only',
  );
});

test('chat finds members and teams, and shares a file only through a reviewed card that is still current', async t => {
  const { db, w, runtime, chatId, drafts, tool, approve, table } = await setup(t);
  const { files, upload } = library(runtime, w);
  const people = Array.from({ length: 22 }, () => randomUUID());
  for (const [index, id] of people.entries())
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      id,
      `person-${index}`,
    ]);
  const teams = Array.from({ length: 21 }, () => randomUUID());
  for (const [index, id] of teams.entries())
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,$2)`, [id, `Design ${index}`]);
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Finance')`, [randomUUID()]);

  const design = await tool({ tool: 'members.find', query: '  DESIGN ' });
  assert.equal(design.teams.length, 20, 'at most twenty teams');
  assert.ok(design.teams.every(team => team.name.startsWith('Design')));
  assert.deepEqual(design.members, []);
  assert.equal(design.truncated, true);
  const everyone = await tool({ tool: 'members.find', query: 'unnamed' });
  assert.equal(everyone.members.length, 20, 'at most twenty members');
  assert.deepEqual(Object.keys(everyone.members[0]).sort(), ['email', 'membershipId', 'name']);
  assert.equal(everyone.truncated, true);
  const finance = await tool({ tool: 'members.find', query: 'finance' });
  assert.deepEqual(
    [finance.members, finance.teams.map(team => team.name), finance.truncated],
    [[], ['Finance'], false],
  );

  const file = await upload('Plan.pdf');
  const [first, second] = people;
  const subject = id => ({ kind: 'individual', id });
  // The harness skips the model-facing schema, so the role default is passed explicitly.
  const share = (subjects, role = 'viewer') => tool({ tool: 'files.share', fileId: file.id, subjects, role });
  assert.equal((await share([subject(first), subject(first)])).error, 'invalid-arguments');
  assert.equal((await share([subject(randomUUID())])).error, 'subject-not-found');

  const proposed = await share([subject(first), { kind: 'team', id: teams[0] }]);
  const card = await drafts.read(w.id, w.userId, chatId, proposed.draftId);
  assert.equal(card.proposal.kind, 'file-share');
  assert.deepEqual(
    card.proposal.input.subjects.map(entry => [entry.kind, entry.id, entry.current]),
    [
      ['individual', first, null],
      ['team', teams[0], null],
    ],
  );
  assert.equal(card.proposal.input.role, 'viewer');
  assert.deepEqual([card.proposal.input.before.count, card.proposal.input.added.count], [1, 1]);
  await assert.rejects(files.read(w.id, 'person-0', file.id), 'proposing shares nothing');

  await files.share(w.id, w.userId, file.id, subject(second), 'viewer');
  assert.equal((await drafts.read(w.id, w.userId, chatId, proposed.draftId)).status, 'stale', 'sharing changed since');
  await assert.rejects(
    drafts.decide(w.id, w.userId, chatId, proposed.draftId, {
      commandId: randomUUID(),
      digest: proposed.digest,
      decision: 'save',
    }),
    error => error instanceof AgentError && error.code === 'draft-stale',
  );
  await assert.rejects(files.read(w.id, 'person-0', file.id));
  await assert.rejects(
    files.shareReviewed(w.id, w.userId, file.id, [subject(first)], 'viewer', card.proposal.input.fingerprint),
    error => error instanceof FileError && error.code === 'conflict',
  );

  const already = await share([subject(second)]);
  assert.equal(already.error, 'no-change');
  assert.equal(already.alreadyShared.length, 1);

  const current = await share([subject(first), subject(second)], 'editor');
  assert.equal((await approve(current)).status, 'saved');
  assert.equal((await files.read(w.id, 'person-0', file.id)).role, 'editor');
  assert.equal((await files.read(w.id, 'person-1', file.id)).role, 'editor', 'a reviewed share raises a lower grant');
  await assert.rejects(files.read(w.id, 'person-2', file.id), 'only the reviewed people gain access');
});
