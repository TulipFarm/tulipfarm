import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied, resolveHuman } from '@tulipfarm/access';
import { createFiles } from '../../../files/src/index.ts';
import {
  createProjects,
  captureProjectContext,
  projectCompatibility,
  recheckProjectContext,
} from '../../src/projects.ts';
import { projectContextReminder } from '../../src/project-context.ts';
import { conversationFixture } from '../fixture.mjs';

const brief = 'Launch date is 12 November. Pricing starts at forty dollars per seat.';

async function setup() {
  const f = await conversationFixture();
  const objects = new Map();
  const files = createFiles(f.runtime, {
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => {
      objects.delete(key);
    },
  });
  const projects = createProjects(f.runtime, undefined, files);
  const member = { id: randomUUID(), user: randomUUID() };
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.id,
    member.user,
  ]);
  const w = f.workspace;
  const projectId = randomUUID();
  await projects.create(w.id, w.userId, { id: projectId, name: 'Launch' });
  await projects.member(w.id, w.userId, projectId, { membershipId: member.id, role: 'member', removed: false });
  const upload = async (user, name, content) => {
    const id = randomUUID();
    await files.upload(w.id, user, id, { name, parentId: null, mediaType: 'text/plain' }, Buffer.from(content));
    return id;
  };
  const context = (user, query = 'pricing per seat') =>
    f.runtime.transaction(w.id, projectCompatibility, async tx =>
      captureProjectContext(tx, await resolveHuman(tx, user), projectId, query),
    );
  return { ...f, files, projects, member, projectId, upload, context };
}

test(
  'Add to project requires everyone in the project to read the file, then binds the copy to its source',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w, projects, projectId, member } = f;
      const fileId = await f.upload(w.userId, 'Brief.txt', brief);

      const blocked = await projects.fileAudience(w.id, w.userId, projectId, { fileIds: [fileId] });
      assert.deepEqual(
        {
          ...blocked,
          files: blocked.files.map(file => ({ ...file, missing: file.missing.map(reader => reader.membershipId) })),
        },
        { readers: 2, files: [{ fileId, status: 'audience', missing: [member.id] }] },
        'the file manager learns who in the project cannot read it',
      );
      await assert.rejects(
        projects.addFile(w.id, w.userId, projectId, { fileId, commandId: randomUUID() }),
        /project-file-audience/,
        'an audience mismatch blocks promotion',
      );
      assert.deepEqual(
        (await projects.read(w.id, w.userId, projectId)).files,
        [],
        'a rejected promotion stores nothing',
      );

      const memberFile = await f.upload(member.user, 'Private notes.txt', 'Only mine.');
      await assert.rejects(
        projects.addFile(w.id, w.userId, projectId, { fileId: memberFile, commandId: randomUUID() }),
        AccessDenied,
        'the requester must be able to read the file',
      );

      await f.files.share(w.id, w.userId, fileId, { kind: 'individual', id: member.id }, 'viewer');
      assert.deepEqual(
        await projects.fileAudience(w.id, w.userId, projectId, { fileIds: [fileId] }),
        { readers: 2, files: [{ fileId, status: 'ready' }] },
        'granting access clears the gap on recheck',
      );
      const commandId = randomUUID();
      const added = await projects.addFile(w.id, w.userId, projectId, { fileId, commandId });
      assert.deepEqual(
        await projects.addFile(w.id, w.userId, projectId, { fileId, commandId }),
        added,
        'retrying the same command converges',
      );

      const [entry] = (await projects.read(w.id, member.user, projectId)).files;
      assert.deepEqual(
        { ...entry, updatedAt: 'set', source: { ...entry.source, readAt: 'set' } },
        {
          id: added.id,
          title: 'Brief.txt',
          pinned: false,
          revisionId: added.revisionId,
          filename: 'Brief.txt',
          bytes: Buffer.byteLength(brief),
          updatedAt: 'set',
          source: { kind: 'file', fileId, readAt: 'set', available: true },
          gaps: null,
        },
      );
      const digest = (
        await f.db.platform.query(`SELECT digest FROM ${f.table('tf_project_knowledge_revisions')} WHERE id=$1`, [
          added.revisionId,
        ])
      ).rows[0].digest;
      assert.equal(
        digest,
        createHash('sha256').update(brief).digest('hex'),
        'the revision keeps the content digest of the file it read',
      );
      assert.deepEqual(
        (await f.context(member.user)).files.map(file => file.content),
        [brief],
      );

      await assert.rejects(
        projects.upload(
          w.id,
          w.userId,
          projectId,
          randomUUID(),
          { revisionId: added.revisionId.replace(/^.{8}/, '00000000'), expectedRevision: null, filename: 'fake.txt' },
          Buffer.from('x'),
        ),
        /project-conflict/,
        'an upload cannot claim a source-bound revision id',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'revoked, trashed, and deleted-forever sources are excluded from project context with an explicit marker',
  { timeout: 60000 },
  async () => {
    const f = await setup();
    try {
      const { workspace: w, projects, projectId, member } = f;
      const fileId = await f.upload(w.userId, 'Brief.txt', brief);
      await f.files.share(w.id, w.userId, fileId, { kind: 'individual', id: member.id }, 'viewer');
      const added = await projects.addFile(w.id, w.userId, projectId, { fileId, commandId: randomUUID() });
      await projects.saveKnowledge(w.id, w.userId, projectId, randomUUID(), {
        revisionId: randomUUID(),
        expectedRevision: null,
        title: 'Notes',
        content: 'Seat pricing is reviewed quarterly.',
      });
      const before = await f.context(w.userId);
      assert.deepEqual(before.files.map(file => file.title).sort(), ['Brief.txt', 'Notes']);

      await f.files.share(w.id, w.userId, fileId, { kind: 'individual', id: member.id }, null);
      const revoked = await f.context(w.userId);
      assert.deepEqual(
        revoked.files.map(file => file.title),
        ['Notes'],
        'revocation for any project reader removes the copy, even for the file owner',
      );
      assert.deepEqual(revoked.unavailable, [{ id: added.id, revisionId: added.revisionId, title: 'Brief.txt' }]);
      assert.ok(!projectContextReminder(revoked).includes('November'), 'no revoked content reaches the model');
      assert.equal(JSON.parse(projectContextReminder(revoked)).unavailableSources[0].status, 'source unavailable');
      assert.deepEqual(
        (await projects.read(w.id, w.userId, projectId)).files.find(file => file.id === added.id).source.available,
        false,
      );
      assert.equal(
        (await projects.read(w.id, w.userId, projectId)).files.find(file => file.id === added.id).source.fileId,
        null,
      );
      await assert.rejects(
        projects.source(w.id, w.userId, projectId, added.revisionId),
        /project-source-unavailable/,
        'the saved text cannot be opened around the source rules',
      );

      const stored = await f.runtime.transaction(w.id, projectCompatibility, tx => recheckProjectContext(tx, before));
      assert.deepEqual(
        stored.files.map(file => file.title),
        ['Notes'],
        'a turn’s saved snapshot is rechecked before reuse',
      );
      assert.deepEqual(
        stored.unavailable.map(file => file.title),
        ['Brief.txt'],
      );

      await f.files.share(w.id, w.userId, fileId, { kind: 'individual', id: member.id }, 'viewer');
      assert.deepEqual(
        (await f.context(w.userId)).files.map(file => file.title).sort(),
        ['Brief.txt', 'Notes'],
        'restored access restores the source',
      );

      const captured = await f.context(w.userId);
      await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET sha256=$2 WHERE id=$1`, [
        fileId,
        createHash('sha256').update('Launch moved to January.').digest('hex'),
      ]);
      assert.deepEqual(
        (await f.context(w.userId)).files.map(file => file.title),
        ['Notes'],
        'a changed source is not used by a fresh build',
      );
      const changed = await f.runtime.transaction(w.id, projectCompatibility, tx =>
        recheckProjectContext(tx, captured),
      );
      assert.deepEqual(
        changed.files.map(file => file.title),
        ['Notes'],
        'a saved snapshot drops text whose source content changed since capture',
      );
      assert.deepEqual(
        changed.unavailable.map(file => file.title),
        ['Brief.txt'],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET sha256=$2 WHERE id=$1`, [
        fileId,
        createHash('sha256').update(brief).digest('hex'),
      ]);

      await f.files.trash(w.id, w.userId, fileId, true);
      assert.deepEqual(
        (await f.context(member.user)).unavailable.map(file => file.title),
        ['Brief.txt'],
        'a trashed source is unavailable',
      );
      assert.equal((await f.files.deleteForever(w.id, w.userId, fileId)).state, 'deleted');
      const deleted = await f.context(member.user);
      assert.deepEqual(
        deleted.files.map(file => file.title),
        ['Notes'],
        'a deleted-forever source is never used',
      );
      assert.deepEqual(
        deleted.unavailable.map(file => file.title),
        ['Brief.txt'],
      );
    } finally {
      await f.close();
    }
  },
);
