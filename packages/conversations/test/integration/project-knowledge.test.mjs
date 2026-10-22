import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveHuman } from '@tulipfarm/access';
import { conversationFixture } from '../fixture.mjs';
import { createProjects, captureProjectContext } from '../../src/projects.ts';
import { docx, paragraph } from '../knowledge-extraction-fixtures.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('project knowledge saves revisions, pins, removes, rejects conflicts and feeds the turn context', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      projects = createProjects(f.runtime);
    const reader = { id: randomUUID(), user: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      reader.id,
      reader.user,
    ]);
    const projectId = randomUUID();
    await projects.create(w.id, w.userId, { id: projectId, name: 'Launch' });
    await projects.edit(w.id, w.userId, projectId, {
      expectedRevision: 0,
      name: 'Launch',
      instructions: 'Answer as the launch team.',
      archived: false,
    });
    await projects.member(w.id, w.userId, projectId, { membershipId: reader.id, role: 'member', removed: false });

    const brief = randomUUID(),
      briefRevision = randomUUID();
    assert.deepEqual(
      await projects.saveKnowledge(w.id, w.userId, projectId, brief, {
        revisionId: briefRevision,
        expectedRevision: null,
        title: 'Brief',
        content: 'Launch date is 12 November.',
      }),
      { id: brief },
    );
    assert.deepEqual(
      await projects.saveKnowledge(w.id, w.userId, projectId, brief, {
        revisionId: briefRevision,
        expectedRevision: null,
        title: 'Brief',
        content: 'Launch date is 12 November.',
      }),
      { id: brief },
    );
    await assert.rejects(
      projects.saveKnowledge(w.id, w.userId, projectId, brief, {
        revisionId: randomUUID(),
        expectedRevision: null,
        title: 'Brief',
        content: 'Other',
      }),
      /project-conflict/,
    );
    const notes = randomUUID();
    await projects.upload(
      w.id,
      w.userId,
      projectId,
      notes,
      { revisionId: randomUUID(), expectedRevision: null, filename: 'pricing.md' },
      Buffer.from('Pricing starts at forty dollars per seat.'),
    );
    await assert.rejects(
      projects.upload(
        w.id,
        w.userId,
        projectId,
        randomUUID(),
        { revisionId: randomUUID(), expectedRevision: null, filename: 'logo.png' },
        Buffer.from([1, 2, 3]),
      ),
      /unsupported-file/,
    );
    await assert.rejects(
      projects.saveKnowledge(w.id, reader.user, projectId, randomUUID(), {
        revisionId: randomUUID(),
        expectedRevision: null,
        title: 'Mine',
        content: 'x',
      }),
      /Resource not found/,
    );

    const nextRevision = randomUUID();
    await projects.saveKnowledge(w.id, w.userId, projectId, brief, {
      revisionId: nextRevision,
      expectedRevision: briefRevision,
      title: 'Brief',
      content: 'Launch date moved to 19 November.',
    });
    await projects.knowledgeState(w.id, w.userId, projectId, brief, { pinned: true, removed: false });
    const detail = await projects.read(w.id, reader.user, projectId);
    assert.deepEqual(
      detail.files.map(file => [file.title, file.pinned, file.filename]),
      [
        ['Brief', true, 'Brief.txt'],
        ['pricing.md', false, 'pricing.md'],
      ],
    );
    assert.equal(detail.files[0].revisionId, nextRevision);
    assert.deepEqual(await projects.source(w.id, reader.user, projectId, briefRevision), {
      title: 'Brief',
      filename: 'Brief.txt',
      content: 'Launch date is 12 November.',
    });

    const context = await f.runtime.transaction(w.id, commonCompatibility, async tx =>
      captureProjectContext(tx, await resolveHuman(tx, reader.user), projectId, 'what is the pricing per seat?'),
    );
    assert.equal(context.instructions, 'Answer as the launch team.');
    assert.deepEqual(
      context.files.map(file => [file.title, file.pinned, file.content]),
      [
        ['Brief', true, 'Launch date moved to 19 November.'],
        ['pricing.md', false, 'Pricing starts at forty dollars per seat.'],
      ],
    );

    await projects.knowledgeState(w.id, w.userId, projectId, notes, { pinned: false, removed: true });
    assert.deepEqual(
      (await projects.read(w.id, w.userId, projectId)).files.map(file => file.title),
      ['Brief'],
    );
    const project = (await projects.read(w.id, w.userId, projectId)).project;
    await projects.edit(w.id, w.userId, projectId, {
      expectedRevision: project.revision,
      name: 'Launch',
      instructions: project.instructions,
      archived: true,
    });
    await assert.rejects(
      projects.saveKnowledge(w.id, w.userId, projectId, randomUUID(), {
        revisionId: randomUUID(),
        expectedRevision: null,
        title: 'Late',
        content: 'x',
      }),
      /project-conflict/,
    );
    await projects.member(w.id, w.userId, projectId, { membershipId: reader.id, role: 'member', removed: true });
    await assert.rejects(projects.source(w.id, reader.user, projectId, briefRevision), /Resource not found/);
  } finally {
    await f.close();
  }
});

test('native Projects uploads retain project storage, authorization and revision access', async () => {
  const f = await conversationFixture();
  try {
    const w = f.workspace,
      projects = createProjects(f.runtime);
    const outsider = { id: randomUUID(), user: randomUUID() };
    await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      outsider.id,
      outsider.user,
    ]);
    const projectId = randomUUID(),
      id = randomUUID(),
      revisionId = randomUUID();
    await projects.create(w.id, w.userId, { id: projectId, name: 'Native documents' });
    const bytes = docx(paragraph('Marketing budget 450'));
    const input = { revisionId, expectedRevision: null, filename: 'budget.docx' };
    await assert.rejects(projects.upload(w.id, outsider.user, projectId, id, input, bytes), /Resource not found/);
    assert.deepEqual(await projects.upload(w.id, w.userId, projectId, id, input, bytes), { id });
    const detail = await projects.read(w.id, w.userId, projectId);
    assert.deepEqual(
      detail.files.map(file => [file.id, file.revisionId, file.filename, file.bytes]),
      [[id, revisionId, 'budget.docx', bytes.length]],
    );
    const saved = await projects.source(w.id, w.userId, projectId, revisionId);
    assert.equal(saved.content.trim(), 'Marketing budget 450');
    await assert.rejects(projects.source(w.id, outsider.user, projectId, revisionId), /Resource not found/);
    await assert.rejects(
      projects.upload(
        w.id,
        w.userId,
        projectId,
        randomUUID(),
        { ...input, revisionId: randomUUID() },
        Buffer.from('broken zip'),
      ),
      /unreadable-file/,
    );
    assert.deepEqual(
      (await projects.read(w.id, w.userId, projectId)).files.map(file => file.id),
      [id],
    );
  } finally {
    await f.close();
  }
});
