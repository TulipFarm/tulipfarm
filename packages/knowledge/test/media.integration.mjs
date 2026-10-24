import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { createLocalKnowledge, KnowledgeAdminRequired } from '../dist/index.js';
import { pdf } from './fixtures/parser-documents.mjs';
import { png } from '../../memory-core/test/fixtures/parser-media.mjs';

test('local knowledge reads images through the injected recognizer, caches them and honors the switch', async t => {
  const db = await fixture();
  let runtime;
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const one = await db.create(await workspaceTableMigrations());
    const table = name => qualified(one.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      maxPools: 2,
      connectionsPerPool: 4,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => {
        const workspace = db.workspaces.find(item => item.id === id);
        assert.ok(workspace);
        return { workspaceId: id, generation: 1, connectionString: db.login(workspace) };
      },
    });
    const member = { userId: randomUUID(), membershipId: randomUUID() };
    const admin = { userId: randomUUID(), membershipId: randomUUID() };
    for (const [person, role] of [
      [member, 'member'],
      [admin, 'admin'],
    ])
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
        person.membershipId,
        person.userId,
        role,
      ]);
    const objects = new Map();
    const files = createFiles(runtime, {
      putIfAbsent: async (key, bytes) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      },
      read: async key => Buffer.from(objects.get(key)),
    });
    const scopes = [];
    const calls = [];
    let available = false;
    let images = false;
    let answer = () => ({ kind: 'recognized', text: 'Plant tulips in October.', description: 'A planting calendar' });
    const recognizer = {
      modelId: 'vision-test',
      promptVersion: 'media-v1',
      async recognize(request) {
        calls.push(request.kind);
        return answer(request);
      },
    };
    const api = createLocalKnowledge({
      runtime,
      files,
      recognition: async scope => {
        scopes.push(scope);
        return { ...(available ? { recognizer } : {}), ...(images ? { images } : {}) };
      },
      recognitionAvailable: async () => available,
    });
    const upload = async (title, bytes, name = `${title}.pdf`, mediaType = 'application/pdf') => {
      const fileId = randomUUID();
      await files.upload(one.id, member.userId, fileId, { name, parentId: null, mediaType }, bytes);
      const command = {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title,
        input: { kind: 'file', fileId },
      };
      await api.save(one.id, member.userId, command);
      return command;
    };
    const process = async revisionId => {
      const work = (await api.due(one.id)).find(item => item.revisionId === revisionId);
      assert.ok(work, 'revision is due');
      await api.acknowledge(work);
      return (await api.process(work)).disposition;
    };
    const count = async name => (await db.platform.query(`SELECT count(*)::int AS n FROM ${table(name)}`)).rows[0].n;

    await t.test('the switch is on by default and only admins change it', async () => {
      assert.deepEqual(await api.settings(one.id, member.userId), { mediaRecognition: true, canManage: false });
      assert.deepEqual(await api.settings(one.id, admin.userId), { mediaRecognition: true, canManage: true });
      await assert.rejects(
        api.updateSettings(one.id, member.userId, { mediaRecognition: false }),
        KnowledgeAdminRequired,
      );
    });

    const scan = await upload('Planting calendar', await pdf(['scan']));
    await t.test('without a recognizer a scan waits for recognition', async () => {
      assert.equal(await process(scan.commandId), 'failed');
      const current = await api.get(one.id, member.userId, scan.documentId);
      assert.equal(current.parsing, 'ocr-unavailable');
      assert.equal(scopes.at(-1).revisionId, scan.commandId);
      assert.equal(scopes.at(-1).membershipId, member.membershipId);
      assert.ok(!(await api.due(one.id)).some(item => item.revisionId === scan.commandId));
    });

    await t.test('when recognition becomes available the scan is parsed again with a vision profile', async () => {
      available = true;
      assert.equal(await process(scan.commandId), 'ready');
      assert.deepEqual(calls, ['page']);
      const current = await api.get(one.id, member.userId, scan.documentId);
      assert.equal(current.parsing, 'ready');
      assert.equal(current.gaps, undefined);
      const profile = (
        await db.platform.query(`SELECT profile FROM ${table('parse_profiles')} WHERE publication_id=$1`, [
          current.publicationId,
        ])
      ).rows[0].profile;
      assert.equal(profile.ocr, 'vision');
      assert.equal(profile.ocrModel, 'vision-test');
      const hit = (await api.search(one.id, member.userId, { query: 'tulips October' })).hits.find(
        item => item.citation.documentId === scan.documentId,
      );
      assert.ok(hit);
      assert.deepEqual(hit.location, { kind: 'page', page: 1 });
      assert.equal(await count('recognitions'), 1);
    });

    await t.test('the workspace cache answers the same image without calling the model', async () => {
      const copy = await upload('Planting calendar copy', await pdf(['scan']));
      assert.equal(await process(copy.commandId), 'ready');
      assert.equal(calls.length, 1);
      assert.equal(await count('recognitions'), 1);
    });

    await t.test('model failures are retried and recognition off leaves gaps that come back when on', async () => {
      answer = () => {
        throw new Error('vision model unavailable');
      };
      const failing = await upload('Failing scan', await pdf(['text', 'scan', 'scan']));
      await db.platform.query(`DELETE FROM ${table('recognitions')}`);
      const disposition = await process(failing.commandId);
      assert.notEqual(disposition, 'ready');
      const retried = await api.get(one.id, member.userId, failing.documentId);
      assert.equal(retried.failure, 'provider');
      assert.equal(retried.parsing, 'queued');

      answer = () => ({ kind: 'recognized', text: 'Plant tulips in October.', description: 'A planting calendar' });
      assert.deepEqual(await api.updateSettings(one.id, admin.userId, { mediaRecognition: false }), {
        mediaRecognition: false,
        canManage: true,
      });
      await db.platform.query(`UPDATE ${table('jobs')} SET dispatch_after=clock_timestamp() WHERE revision_id=$1`, [
        failing.commandId,
      ]);
      const before = calls.length;
      assert.equal(await process(failing.commandId), 'ready');
      assert.equal(calls.length, before);
      const gapped = await api.get(one.id, member.userId, failing.documentId);
      assert.equal(gapped.gaps.count, 2);
      assert.ok(gapped.gaps.items.every(gap => gap.reason === 'recognition-unavailable'));
      assert.equal(await count('coverage_gaps'), 2);

      await api.updateSettings(one.id, admin.userId, { mediaRecognition: true });
      assert.equal(await process(failing.commandId), 'ready');
      const complete = await api.get(one.id, member.userId, failing.documentId);
      assert.equal(complete.gaps, undefined);
      assert.notEqual(complete.publicationId, gapped.publicationId);
      assert.ok(!(await api.due(one.id)).some(item => item.revisionId === failing.commandId));
    });

    await t.test('under the images flag a Files image is searchable by text only the image holds', async () => {
      images = true;
      answer = () => ({ kind: 'recognized', text: 'Greenhouse vents open at 28 degrees.', description: '' });
      const photo = await upload('Greenhouse sign', await png(120, 80, '#4a6'), 'sign.png', 'image/png');
      assert.equal(await process(photo.commandId), 'ready');
      const hit = (await api.search(one.id, member.userId, { query: 'greenhouse vents degrees' })).hits.find(
        item => item.citation.documentId === photo.documentId,
      );
      assert.ok(hit, 'the recognised text is indexed for Files search');
      const profile = (
        await db.platform.query(`SELECT profile FROM ${table('parse_profiles')} WHERE publication_id=$1`, [
          (await api.get(one.id, member.userId, photo.documentId)).publicationId,
        ])
      ).rows[0].profile;
      assert.equal(profile.engine, 'image');
      assert.equal(profile.ocrModel, 'vision-test');
      const outsider = (await api.search(one.id, admin.userId, { query: 'greenhouse vents degrees' })).hits;
      assert.ok(
        !outsider.some(item => item.citation.documentId === photo.documentId),
        'recognised text never reaches someone who cannot open the file',
      );
    });

    await t.test('the sweep deletes recognitions no file holds and keeps those a file still holds', async () => {
      const held = await count('recognitions');
      assert.ok(held >= 2);
      const sources = (
        await db.platform.query(`SELECT DISTINCT recognition->>'source' AS source FROM ${table('recognitions')}`)
      ).rows.map(row => row.source);
      const files = (await db.platform.query(`SELECT sha256 FROM ${table('tf_files')} WHERE kind='file'`)).rows.map(
        row => row.sha256,
      );
      assert.ok(
        sources.every(source => files.includes(source)),
        'each recognition records the file it came from',
      );
      const orphan = 'f'.repeat(64);
      const recent = 'e'.repeat(64);
      await db.platform.query(
        `INSERT INTO ${table('recognitions')} (key,recognition,created_at) VALUES
          ($1,$2,clock_timestamp()-interval '2 days'),($3,$4,clock_timestamp())`,
        [
          `${orphan}:vision-test:media-v1`,
          { kind: 'empty', source: orphan },
          `${recent}:vision-test:media-v1`,
          { kind: 'empty', source: recent },
        ],
      );
      await db.platform.query(
        `UPDATE ${table('recognitions')} SET created_at=clock_timestamp()-interval '2 days'
        WHERE key NOT LIKE $1`,
        [`${recent}:%`],
      );
      await api.due(one.id);
      const kept = (await db.platform.query(`SELECT key FROM ${table('recognitions')}`)).rows.map(row => row.key);
      assert.equal(kept.length, held + 1);
      assert.ok(!kept.includes(`${orphan}:vision-test:media-v1`), 'an orphan past the grace period is deleted');
      assert.ok(kept.includes(`${recent}:vision-test:media-v1`), 'a fresh orphan is kept for a read in progress');
    });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
