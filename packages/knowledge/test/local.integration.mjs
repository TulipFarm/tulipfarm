import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { AccessDenied } from '@tulipfarm/access';
import { createKnowledgeSourceFailures, createLocalKnowledge, KnowledgeError } from '../dist/index.js';
import { docx, pdf } from './fixtures/parser-documents.mjs';

test('local knowledge originals, actual parsing, indexed search and durable work', async t => {
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
    const owner = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      owner.membershipId,
      owner.userId,
    ]);
    const objects = new Map();
    let afterRead;
    let reads = 0;
    const files = createFiles(runtime, {
      putIfAbsent: async (key, bytes) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      },
      read: async (key, max) => {
        const bytes = objects.get(key);
        assert.ok(bytes);
        assert.ok(bytes.byteLength <= max);
        reads++;
        const callback = afterRead;
        afterRead = undefined;
        await callback?.();
        return Buffer.from(bytes);
      },
    });
    const api = createLocalKnowledge({ runtime, files });
    const save = (text, overrides = {}) => ({
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Returns handbook',
      input: { kind: 'note', text },
      ...overrides,
    });
    async function run(revisionId) {
      const work = (await api.due(one.id)).find(item => item.revisionId === revisionId);
      assert.ok(work);
      await api.acknowledge(work);
      assert.equal((await api.process(work)).disposition, 'ready');
      return work;
    }
    const text =
      '# Returns\nReturn orders within thirty days. Track OPS-123 at src/orders.ts and https://example.test/a/b?x=1.';
    const input = save(text);
    await t.test('note admission and lost acknowledgement preserve immutable originals and one job', async () => {
      const first = await api.save(one.id, owner.userId, input);
      assert.equal(first.revisionId, input.commandId);
      assert.equal(first.parsing, 'queued');
      assert.equal(first.noteText, text);
      assert.deepEqual(await api.save(one.id, owner.userId, input), first);
      await assert.rejects(
        api.save(one.id, owner.userId, { ...input, title: 'Changed' }),
        error => error instanceof KnowledgeError && error.code === 'conflict',
      );
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::int AS n FROM ${table('jobs')} WHERE revision_id=$1`, [
            input.commandId,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(objects.size, 0);
      assert.equal(Buffer.from((await api.original(one.id, owner.userId, input.documentId)).bytes).toString(), text);
      const login = await connect(db.login(one));
      try {
        await denied(login, `UPDATE ${table('note_originals')} SET bytes='forged' WHERE revision_id=$1`, [
          input.commandId,
        ]);
        await denied(login, `DELETE FROM ${table('note_originals')} WHERE revision_id=$1`, [input.commandId]);
      } finally {
        await login.end();
      }
    });
    let citation;
    await t.test('real parser publication, weighted GIN and punctuation-sensitive identifiers', async () => {
      const work = await run(input.commandId);
      assert.equal((await api.process(work)).disposition, 'ready');
      const current = await api.get(one.id, owner.userId, input.documentId);
      assert.equal(current.parsing, 'ready');
      assert.equal(current.canRetry, false);
      for (const query of ['returns', 'OPS-123', 'src/orders.ts', 'https://example.test/a/b?x=1']) {
        const result = await api.search(one.id, owner.userId, { query });
        assert.equal(result.mode, 'keyword-only');
        assert.equal(result.reason, 'semantic-not-enabled');
        assert.equal(result.hits[0].title, 'Returns handbook');
        assert.match(result.hits[0].text, /thirty days/);
        citation = result.hits[0].citation;
      }
      const result = await api.evidence(one.id, owner.userId, citation);
      assert.deepEqual(result.original, { kind: 'note' });
      assert.match(result.text, /OPS-123/);
      assert.equal((await api.list(one.id, owner.userId)).items[0].documentId, input.documentId);
      assert.deepEqual((await api.search(one.id, one.userId, { query: 'returns' })).hits, []);
      await assert.rejects(api.get(one.id, one.userId, input.documentId), AccessDenied);
      const login = await connect(db.login(one));
      try {
        await login.query('SET enable_seqscan=off');
        for (const [predicate, index, parameter] of [
          ["search_vector @@ websearch_to_tsquery('english',$1)", 'tf_knowledge_search_english_gin', 'returns'],
          ['identifiers @> ARRAY[$1]::text[]', 'tf_knowledge_search_identifiers_gin', 'src/orders.ts'],
        ]) {
          const plan = await login.query(
            `EXPLAIN (ANALYZE,FORMAT JSON) SELECT ordinal FROM ${table('chunks')} WHERE ${predicate}`,
            [parameter],
          );
          assert.match(JSON.stringify(plan.rows), new RegExp(index));
        }
      } finally {
        await login.end();
      }
      const identifierRows = await db.platform.query(
        `SELECT identifiers FROM ${table('chunks')} WHERE publication_id=$1`,
        [citation.publicationId],
      );
      assert.ok(identifierRows.rows[0].identifiers.includes('src/orders.ts'));
      assert.ok(!identifierRows.rows[0].identifiers.includes('srcordersts'));
    });
    await t.test('observed edits invalidate old evidence and tombstones retain bytes', async () => {
      const next = save('# Replacement\nReplacement policy.', {
        documentId: input.documentId,
        expectedRevisionId: input.commandId,
      });
      await api.save(one.id, owner.userId, next);
      await assert.rejects(
        api.evidence(one.id, owner.userId, citation),
        error => error instanceof KnowledgeError && error.code === 'superseded',
      );
      await assert.rejects(
        api.original(one.id, owner.userId, next.documentId, citation.revisionId),
        error => error instanceof KnowledgeError && error.code === 'superseded',
      );
      await assert.rejects(api.original(one.id, one.userId, next.documentId, citation.revisionId), AccessDenied);
      assert.deepEqual(
        Buffer.from((await api.original(one.id, owner.userId, next.documentId, next.commandId)).bytes),
        Buffer.from('# Replacement\nReplacement policy.'),
      );
      assert.deepEqual((await api.search(one.id, owner.userId, { query: 'thirty' })).hits, []);
      await run(next.commandId);
      const removal = { commandId: randomUUID(), documentId: next.documentId, expectedRevisionId: next.commandId };
      assert.equal((await api.remove(one.id, owner.userId, removal)).removed, true);
      assert.equal((await api.remove(one.id, owner.userId, removal)).removed, true);
      await assert.rejects(api.original(one.id, owner.userId, next.documentId), AccessDenied);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('note_originals')} WHERE revision_id=ANY($1::uuid[])`,
            [[input.commandId, next.commandId]],
          )
        ).rows[0].n,
        2,
      );
    });
    await t.test('Files download integrity and current ancestry guard every knowledge read', async () => {
      const folderId = randomUUID(),
        fileId = randomUUID();
      await files.createFolder(one.id, owner.userId, folderId, { name: 'Private folder', parentId: null });
      await files.upload(
        one.id,
        owner.userId,
        fileId,
        { name: 'inventory.md', parentId: folderId, mediaType: 'text/markdown' },
        Buffer.from('# Inventory\nWarehouse inventory is counted weekly.'),
      );
      const fileInput = save('', { title: 'Inventory', input: { kind: 'file', fileId } });
      await api.save(one.id, owner.userId, fileInput);
      await run(fileInput.commandId);
      const hit = (await api.search(one.id, owner.userId, { query: 'warehouse' })).hits[0];
      assert.equal(hit.title, 'Inventory');
      assert.deepEqual((await api.evidence(one.id, owner.userId, hit.citation)).original, { kind: 'file', fileId });
      assert.equal((await api.original(one.id, owner.userId, fileInput.documentId)).filename, 'inventory.md');
      await files.trash(one.id, owner.userId, folderId, true);
      assert.deepEqual((await api.search(one.id, owner.userId, { query: 'warehouse' })).hits, []);
      await assert.rejects(api.get(one.id, owner.userId, fileInput.documentId), AccessDenied);
      await assert.rejects(api.evidence(one.id, owner.userId, hit.citation), AccessDenied);
      await assert.rejects(api.original(one.id, owner.userId, fileInput.documentId), AccessDenied);
      await files.trash(one.id, owner.userId, folderId, false);
      await api.remove(one.id, owner.userId, {
        commandId: randomUUID(),
        documentId: fileInput.documentId,
        expectedRevisionId: fileInput.commandId,
      });
      assert.match(
        Buffer.from((await files.download(one.id, owner.userId, fileId)).bytes).toString(),
        /counted weekly/,
      );
    });
    await t.test(
      'original revision guards reject stale requests before I/O and edits or revocation during I/O',
      async () => {
        const fileId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          fileId,
          { name: 'revision.txt', parentId: null, mediaType: 'text/plain' },
          Buffer.from('Revision A bytes.'),
        );
        const first = save('', { input: { kind: 'file', fileId } });
        await api.save(one.id, owner.userId, first);
        const before = reads;
        await assert.rejects(
          api.original(one.id, owner.userId, first.documentId, randomUUID()),
          error => error instanceof KnowledgeError && error.code === 'superseded',
        );
        assert.equal(reads, before);
        assert.deepEqual(
          Buffer.from((await api.original(one.id, owner.userId, first.documentId, first.commandId)).bytes),
          Buffer.from('Revision A bytes.'),
        );
        const secondFileId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          secondFileId,
          { name: 'revision-b.txt', parentId: null, mediaType: 'text/plain' },
          Buffer.from('Revision B bytes.'),
        );
        const second = save('', {
          documentId: first.documentId,
          expectedRevisionId: first.commandId,
          input: { kind: 'file', fileId: secondFileId },
        });
        afterRead = async () => {
          await api.save(one.id, owner.userId, second);
        };
        await assert.rejects(
          api.original(one.id, owner.userId, first.documentId, first.commandId),
          error => error instanceof KnowledgeError && error.code === 'superseded',
        );
        assert.deepEqual(
          Buffer.from((await api.original(one.id, owner.userId, first.documentId, second.commandId)).bytes),
          Buffer.from('Revision B bytes.'),
        );
        const revoked = save('', { input: { kind: 'file', fileId } });
        await api.save(one.id, owner.userId, revoked);
        afterRead = async () => {
          await api.remove(one.id, owner.userId, {
            documentId: revoked.documentId,
            expectedRevisionId: revoked.commandId,
            commandId: randomUUID(),
          });
        };
        await assert.rejects(api.original(one.id, owner.userId, revoked.documentId, revoked.commandId), AccessDenied);
        assert.deepEqual(
          Buffer.from((await files.download(one.id, owner.userId, fileId)).bytes),
          Buffer.from('Revision A bytes.'),
        );
      },
    );
    await t.test(
      'adding a file already in a person’s Knowledge returns that entry instead of a duplicate',
      async () => {
        const fileId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          fileId,
          { name: 'once.txt', parentId: null, mediaType: 'text/plain' },
          Buffer.from('Added once.'),
        );
        const first = save('', { title: 'once.txt', input: { kind: 'file', fileId } });
        await api.save(one.id, owner.userId, first);
        const again = await api.save(
          one.id,
          owner.userId,
          save('', { title: 'once.txt', input: { kind: 'file', fileId } }),
        );
        assert.equal(again.documentId, first.documentId);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int AS n FROM ${table('revisions')} WHERE original->>'fileId'=$1`,
              [fileId],
            )
          ).rows[0].n,
          1,
        );
        await api.remove(one.id, owner.userId, {
          commandId: randomUUID(),
          documentId: first.documentId,
          expectedRevisionId: first.commandId,
        });
      },
    );
    await t.test('real Office and PDF originals reach search while scans remain terminal and retained', async () => {
      for (const [filename, bytes] of [
        ['harvest.docx', docx()],
        ['harvest.pdf', await pdf(['text'])],
      ]) {
        const fileId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          fileId,
          { name: filename, parentId: null, mediaType: 'application/octet-stream' },
          bytes,
        );
        const item = save('', { title: filename, input: { kind: 'file', fileId } });
        await api.save(one.id, owner.userId, item);
        await run(item.commandId);
        const hits = (await api.search(one.id, owner.userId, { query: 'Harvest apples Tuesday' })).hits;
        assert.ok(hits.some(hit => hit.citation.documentId === item.documentId));
        assert.deepEqual(
          Buffer.from((await api.original(one.id, owner.userId, item.documentId)).bytes),
          Buffer.from(bytes),
        );
      }
      const bytes = await pdf(['text', 'scan']);
      const fileId = randomUUID();
      await files.upload(
        one.id,
        owner.userId,
        fileId,
        { name: 'mixed.pdf', parentId: null, mediaType: 'application/pdf' },
        bytes,
      );
      const item = save('', { title: 'Mixed scan', input: { kind: 'file', fileId } });
      await api.save(one.id, owner.userId, item);
      const work = (await api.due(one.id)).find(entry => entry.revisionId === item.commandId);
      assert.equal((await api.process(work)).disposition, 'failed');
      const current = await api.get(one.id, owner.userId, item.documentId);
      assert.equal(current.parsing, 'ocr-unavailable');
      assert.equal(current.failure, 'ocr-required');
      assert.equal(current.canRetry, false);
      assert.equal(current.publicationId, null);
      await assert.rejects(
        api.retry(one.id, owner.userId, {
          documentId: item.documentId,
          expectedRevisionId: item.commandId,
          commandId: randomUUID(),
        }),
        error => error instanceof KnowledgeError && error.code === 'conflict',
      );
      assert.ok(!(await api.due(one.id)).some(entry => entry.revisionId === item.commandId));
      assert.deepEqual(
        Buffer.from((await api.original(one.id, owner.userId, item.documentId)).bytes),
        Buffer.from(bytes),
      );
      assert.ok(
        !(await api.search(one.id, owner.userId, { query: 'Mixed scan' })).hits.some(
          hit => hit.citation.documentId === item.documentId,
        ),
      );
    });
    await t.test(
      'dispatch acknowledgement recovery changes generation once and retry commands are idempotent',
      async () => {
        const item = save('Dispatch recovery.');
        await api.save(one.id, owner.userId, item);
        const first = (await api.due(one.id)).find(entry => entry.revisionId === item.commandId);
        await api.acknowledge(first);
        await db.platform.query(
          `UPDATE ${table('jobs')} SET dispatch_after=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
          [item.commandId],
        );
        const replacement = (await api.due(one.id)).find(entry => entry.revisionId === item.commandId);
        assert.equal(replacement.generation, first.generation + 1);
        assert.deepEqual(
          (await api.due(one.id)).find(entry => entry.revisionId === item.commandId),
          replacement,
        );
        assert.equal((await api.process(first)).disposition, 'stale');
        await db.platform.query(
          `UPDATE ${table('work')} SET parsing='failed',failure='provider',attempts=1 WHERE revision_id=$1`,
          [item.commandId],
        );
        const command = { documentId: item.documentId, expectedRevisionId: item.commandId, commandId: randomUUID() };
        assert.equal((await api.retry(one.id, owner.userId, command)).parsing, 'queued');
        const generation = (await api.due(one.id)).find(entry => entry.revisionId === item.commandId).generation;
        assert.equal((await api.retry(one.id, owner.userId, command)).parsing, 'queued');
        assert.equal((await api.due(one.id)).find(entry => entry.revisionId === item.commandId).generation, generation);
        await run(item.commandId);
      },
    );
    await t.test('expired SQL leases consume attempts, fence old work and survive a new service instance', async () => {
      const pending = save('# Durable\nA durable lease survives process crashes.');
      await api.save(one.id, owner.userId, pending);
      const old = (await api.due(one.id)).find(item => item.revisionId === pending.commandId);
      assert.ok(old);
      await db.platform.query(`UPDATE ${table('work')} SET attempts=1,parsing='parsing' WHERE revision_id=$1`, [
        pending.commandId,
      ]);
      await db.platform.query(
        `UPDATE ${table('jobs')} SET lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
        [pending.commandId, randomUUID()],
      );
      const restarted = createLocalKnowledge({ runtime, files });
      const replacement = (await restarted.due(one.id)).find(item => item.revisionId === pending.commandId);
      assert.equal(replacement.generation, old.generation + 1);
      assert.equal((await restarted.process(old)).disposition, 'stale');
      assert.equal((await restarted.process(replacement)).disposition, 'ready');
      assert.equal(
        (await db.platform.query(`SELECT attempts FROM ${table('work')} WHERE revision_id=$1`, [pending.commandId]))
          .rows[0].attempts,
        2,
      );
      const capped = save('Crash cap.');
      await api.save(one.id, owner.userId, capped);
      await db.platform.query(`UPDATE ${table('work')} SET attempts=8,parsing='parsing' WHERE revision_id=$1`, [
        capped.commandId,
      ]);
      await db.platform.query(
        `UPDATE ${table('jobs')} SET lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
        [capped.commandId, randomUUID()],
      );
      await restarted.due(one.id);
      assert.equal((await restarted.get(one.id, owner.userId, capped.documentId)).canRetry, false);
      assert.equal((await restarted.get(one.id, owner.userId, capped.documentId)).parsing, 'failed');
    });
    await t.test(
      'unreadable text falls back to raw text, failures are listed and provider errors back off',
      async () => {
        const fileId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          fileId,
          { name: 'ledger.bin', parentId: null, mediaType: 'application/octet-stream' },
          Buffer.from('Orchard ledger: plum shipments leave on Fridays.'),
        );
        const item = save('', { title: 'Orchard ledger', input: { kind: 'file', fileId } });
        await api.save(one.id, owner.userId, item);
        await run(item.commandId);
        const hit = (await api.search(one.id, owner.userId, { query: 'plum shipments Fridays' })).hits.find(
          entry => entry.citation.documentId === item.documentId,
        );
        assert.ok(hit);
        const { source_id: sourceId } = (
          await db.platform.query(`SELECT source_id FROM ${table('documents')} WHERE id=$1`, [item.documentId])
        ).rows[0];
        const failures = createKnowledgeSourceFailures({ runtime });
        const listed = await failures.list(one.id, owner.userId, sourceId);
        assert.equal(listed.sourceId, sourceId);
        assert.equal(listed.truncated, false);
        assert.deepEqual(
          listed.items.find(entry => entry.documentId === item.documentId) && {
            status: listed.items.find(entry => entry.documentId === item.documentId).status,
            reason: listed.items.find(entry => entry.documentId === item.documentId).reason,
          },
          { status: 'raw-text', reason: 'unsupported' },
        );
        const scan = listed.items.find(entry => entry.title === 'Mixed scan');
        assert.equal(scan?.status, 'ocr-unavailable');
        assert.equal(scan?.reason, 'ocr-required');
        assert.ok(
          listed.items.findIndex(entry => entry.status !== 'raw-text') <
            listed.items.indexOf(listed.items.find(entry => entry.status === 'raw-text')),
        );
        const stranger = randomUUID();
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
          randomUUID(),
          stranger,
        ]);
        await assert.rejects(failures.list(one.id, stranger, sourceId), AccessDenied);
        await assert.rejects(failures.list(one.id, owner.userId, randomUUID()), AccessDenied);

        const flakyId = randomUUID();
        await files.upload(
          one.id,
          owner.userId,
          flakyId,
          { name: 'flaky.md', parentId: null, mediaType: 'text/markdown' },
          Buffer.from('Flaky storage note.'),
        );
        const flaky = save('', { title: 'Flaky', input: { kind: 'file', fileId: flakyId } });
        await api.save(one.id, owner.userId, flaky);
        const delays = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          await db.platform.query(
            `UPDATE ${table('jobs')} SET dispatch_after=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
            [flaky.commandId],
          );
          const work = (await api.due(one.id)).find(entry => entry.revisionId === flaky.commandId);
          await api.acknowledge(work);
          afterRead = () => {
            throw new Error('storage unavailable');
          };
          assert.equal((await api.process(work)).disposition, 'retry');
          delays.push(
            (
              await db.platform.query(
                `SELECT extract(epoch FROM dispatch_after-clock_timestamp())::float8 AS s FROM ${table('jobs')} WHERE revision_id=$1`,
                [flaky.commandId],
              )
            ).rows[0].s,
          );
        }
        assert.ok(delays[0] > 20 && delays[0] <= 30, String(delays));
        assert.ok(delays[1] > delays[0] * 1.5 && delays[1] <= 60, String(delays));
        assert.equal((await api.get(one.id, owner.userId, flaky.documentId)).parsing, 'queued');
        await db.platform.query(
          `UPDATE ${table('jobs')} SET dispatch_after=clock_timestamp()-interval '1 second' WHERE revision_id=$1`,
          [flaky.commandId],
        );
        await run(flaky.commandId);
      },
    );
    await t.test('shared local source count and membership incarnation remain exact', async () => {
      const documents = [save('First member note.'), save('Second member note.')];
      for (const item of documents) await api.save(one.id, owner.userId, item);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int AS n FROM ${table('sources')} WHERE owner_membership_id=$1 AND provider='note'`,
            [owner.membershipId],
          )
        ).rows[0].n,
        1,
      );
      await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
        owner.membershipId,
      ]);
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        randomUUID(),
        owner.userId,
      ]);
      assert.deepEqual((await api.list(one.id, owner.userId)).items, []);
      await assert.rejects(api.get(one.id, owner.userId, documents[0].documentId), AccessDenied);
      assert.deepEqual(await api.due(one.id), []);
    });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
