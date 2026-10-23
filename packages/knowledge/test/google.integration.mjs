import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createGoogleKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createKnowledgeSourceFailures,
  createLocalKnowledge,
} from '../dist/index.js';
import { AccessDenied } from '@tulipfarm/access';
import { GoogleCorpusError } from '@tulipfarm/google-workspace/corpus';
import { createFiles } from '@tulipfarm/files';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';

test('Google corpus persists through real restricted PostgreSQL and enforces reader authority', async t => {
  const db = await fixture();
  let runtime;
  try {
    await loadPlatformBaseline(db.platform);
    const stream = await workspaceTableMigrations();
    const ws = await db.create(stream);
    const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const local = createLocalKnowledge({
      runtime,
      files: createFiles(runtime, { putIfAbsent: async () => {}, read: async () => assert.fail('unexpected read') }),
    });
    const note = await local.save(ws.id, ws.userId, {
      commandId: randomUUID(),
      documentId: randomUUID(),
      expectedRevisionId: null,
      title: 'Local orchid',
      input: { kind: 'note', text: 'orchid local note' },
    });
    for (const work of await local.due(ws.id)) assert.equal((await local.process(work)).disposition, 'ready');
    assert.equal(
      (await local.search(ws.id, ws.userId, { query: 'orchid' })).hits[0].citation.documentId,
      note.documentId,
    );
    const reader = { userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      reader.membershipId,
      reader.userId,
    ]);
    const binding = {
      integrationId: randomUUID(),
      accountId: 'manager-account',
      generation: 1,
      requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    };
    const readerBinding = { ...binding, integrationId: randomUUID(), accountId: 'reader-account' };
    async function integration(userId, membershipId, b) {
      await db.platform.query(
        `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,$4,'connected',$5,'fixture@example.test',$6,'{}')`,
        [b.integrationId, userId, membershipId, b.generation, b.accountId, b.requiredScopes],
      );
    }
    await integration(ws.userId, ws.membershipId, binding);
    await integration(reader.userId, reader.membershipId, readerBinding);
    const selection = { kind: 'drive-folder', folderId: 'root' };
    const files = new Map([['one', { text: 'orchid confidential supplier terms', version: '1' }]]);
    let listError = null,
      readGate = null,
      denyReader = false,
      omit = false;
    const checks = [];
    const observation = id => ({
      nativeId: id,
      title: `Google ${id}`,
      canonicalURL: `https://drive.google.com/file/d/${id}`,
      sourceRevision: files.get(id).version,
      accessedAt: new Date().toISOString(),
      kind: 'file',
      mediaType: 'text/plain',
      parentIds: ['root'],
      coverage: 'supported',
    });
    const provider = {
      discover: async () => ({ binding, items: [], nextCursor: null }),
      inspectSelection: async (_w, _u, s) => ({ binding, selection: s, title: 'Selected folder' }),
      list: async () => {
        if (listError) throw listError;
        return { observations: omit ? [] : [...files.keys()].map(observation), nextCursor: null };
      },
      check: async (_w, user, b, _s, id) => {
        checks.push({ user, b });
        if (user === reader.userId && denyReader) throw new GoogleCorpusError('forbidden');
        if (!files.has(id)) throw new GoogleCorpusError('not-found');
        return observation(id);
      },
      read: async (_w, _u, _b, _s, id) => {
        if (readGate) await readGate();
        const o = observation(id);
        return {
          ...o,
          bytes: Buffer.from(files.get(id).text),
          filename: `${id}.txt`,
          normalizedContent: null,
          metadataBefore: o,
          metadataAfter: o,
        };
      },
    };
    const google = createGoogleKnowledge({ runtime, provider });
    const input = { commandId: randomUUID(), selection, memberIds: [reader.membershipId] };
    const source = await google.configure(ws.id, ws.userId, input);
    assert.deepEqual(source.memberIds, [reader.membershipId, ws.membershipId].sort());
    assert.equal((await google.configure(ws.id, ws.userId, input)).sourceId, source.sourceId);
    await assert.rejects(google.configure(ws.id, ws.userId, { ...input, memberIds: [] }));
    await assert.rejects(
      google.configure(ws.id, ws.userId, {
        commandId: randomUUID(),
        selection: { kind: 'gmail', labelId: null, after: '2026-01-01', before: '2026-02-01' },
        memberIds: [reader.membershipId],
      }),
    );
    async function processPage() {
      const work = (await google.due(ws.id))[0];
      assert.ok(work);
      return google.process(work);
    }
    async function restart() {
      await db.platform.query(`UPDATE ${table('google_sources')} SET next_attempt_at=clock_timestamp()`);
    }
    await t.test('native original and lexical publication; automatic P2 discovery and hybrid search', async () => {
      assert.equal((await processPage()).disposition, 'retry');
      assert.equal((await processPage()).disposition, 'ready');
      const sharedSource = (await google.list(ws.id, reader.userId)).items[0];
      assert.equal(sharedSource.sourceId, source.sourceId);
      assert.equal(sharedSource.canManage, false);
      assert.equal(sharedSource.title, 'Shared Google source');
      assert.equal(sharedSource.selection, null);
      assert.equal(sharedSource.counts, null);
      assert.deepEqual(sharedSource.memberIds, []);
      await db.platform.query(
        `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      const embeddings = createKnowledgeEmbeddings({
        runtime,
        google,
        config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
        capacity: async () => true,
        provider: async () => ({
          dispatch: 'dispatched',
          requestId: 'google-test',
          inputTokensUpperBound: 1,
          usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
          result: {
            kind: 'success',
            model: profile.model,
            vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
          },
        }),
      });
      for (let i = 0; i < 5; i++) for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
      const search = createKnowledgeSearch({ runtime, embeddings, google });
      const hit = await search.search(ws.id, ws.userId, {
        kind: 'submitted',
        commandId: randomUUID(),
        query: 'supplier',
        filters: { kinds: ['google'] },
      });
      assert.equal(hit.mode, 'hybrid');
      assert.equal(hit.hits.length, 1);
      const { synced_at: syncedAt } = (
        await db.platform.query(`SELECT synced_at FROM ${table('sources')} WHERE id=$1`, [source.sourceId])
      ).rows[0];
      assert.ok(syncedAt, 'completed provider sync records synced_at');
      assert.equal(hit.hits[0].freshness.sourceSyncedAt, syncedAt.toISOString());
      assert.ok(hit.hits[0].freshness.indexedAt);
      assert.equal(typeof hit.hits[0].freshness.sourceRevision, 'string');
      const sourceFailures = await createKnowledgeSourceFailures({ runtime }).list(ws.id, ws.userId, source.sourceId);
      assert.deepEqual(sourceFailures, {
        sourceId: source.sourceId,
        syncedAt: syncedAt.toISOString(),
        items: [],
        truncated: false,
      });
      await assert.rejects(
        createKnowledgeSourceFailures({ runtime }).list(ws.id, reader.userId, source.sourceId),
        AccessDenied,
      );
      assert.equal(
        (
          await google.original(ws.id, ws.userId, hit.hits[0].citation.documentId, hit.hits[0].citation.revisionId)
        ).bytes.toString(),
        'orchid confidential supplier terms',
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('local_revisions')} l JOIN ${table('revisions')} r ON r.id=l.revision_id JOIN ${table('documents')} d ON d.id=r.document_id WHERE d.source_id=$1`,
            [source.sourceId],
          )
        ).rows[0].n,
        0,
      );
      const denied = await search.search(ws.id, reader.userId, {
        kind: 'typing',
        query: 'orchid',
        filters: { kinds: ['google'] },
      });
      assert.deepEqual(denied.hits, []);
      assert.equal(denied.coverage, 'partial');
      assert.equal((await google.refresh(ws.id, reader.userId, source.sourceId)).refreshed, 1);
      assert.deepEqual(checks.at(-1), { user: reader.userId, b: readerBinding });
      const shared = await search.search(ws.id, reader.userId, {
        kind: 'typing',
        query: 'orchid',
        filters: { kinds: ['google'] },
      });
      assert.equal(shared.hits.length, 1);
      const expiry = (
        await db.platform.query(`SELECT expires_at FROM ${table('access_proofs')} WHERE membership_id=$1`, [
          reader.membershipId,
        ])
      ).rows[0].expires_at;
      assert.ok(Date.parse(shared.validUntil) <= expiry.getTime());
      assert.equal(
        (await google.evidence(ws.id, reader.userId, shared.hits[0].citation)).text,
        'orchid confidential supplier terms',
      );
      assert.equal((await google.status(ws.id, reader.userId, shared.hits[0].citation.documentId)).title, 'Google one');
      await assert.rejects(
        runtime.transaction(ws.id, commonCompatibility, tx =>
          tx.client.query(
            `UPDATE ${qualified(tx.schema, 'tf_knowledge_google_originals')} SET bytes='tampered'::bytea`,
          ),
        ),
        error => error.code === '42501',
      );
      await assert.rejects(
        google.manage(ws.id, reader.userId, source.sourceId, { commandId: randomUUID(), action: 'pause' }),
      );
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET account_id='changed' WHERE id=$1`, [
        readerBinding.integrationId,
      ]);
      assert.deepEqual((await search.search(ws.id, reader.userId, { kind: 'typing', query: 'orchid' })).hits, []);
      await assert.rejects(
        google.original(ws.id, reader.userId, shared.hits[0].citation.documentId, shared.hits[0].citation.revisionId),
      );
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET account_id=$2 WHERE id=$1`, [
        readerBinding.integrationId,
        readerBinding.accountId,
      ]);
      denyReader = true;
      await google.refresh(ws.id, reader.userId, source.sourceId);
      denyReader = false;
      assert.deepEqual((await search.search(ws.id, reader.userId, { kind: 'typing', query: 'orchid' })).hits, []);
      await google.refresh(ws.id, reader.userId, source.sourceId);
      await db.platform.query(
        `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1`,
        [reader.membershipId],
      );
      const expired = await search.search(ws.id, reader.userId, { kind: 'typing', query: 'orchid' });
      assert.deepEqual(expired.hits, []);
      assert.equal(expired.coverage, 'partial');
      await search.close();
    });
    await t.test('partial and failed listings never delete; retry-after persists', async () => {
      await restart();
      listError = new GoogleCorpusError('rate-limited', 120000);
      assert.equal((await processPage()).disposition, 'retry');
      listError = null;
      const status = (await google.list(ws.id, ws.userId)).items[0];
      assert.equal(status.failure, 'rate-limited');
      assert.ok(Date.parse(status.nextAttemptAt) > Date.now() + 110000);
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
            [source.sourceId],
          )
        ).rows[0].n,
        1,
      );
      await restart();
      omit = true;
      await processPage();
      await processPage();
      omit = false;
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
            [source.sourceId],
          )
        ).rows[0].n,
        1,
      );
    });
    await t.test('observed change clears both publications before read; pause fences in-flight work', async () => {
      await restart();
      files.set('one', { text: 'replacement terms', version: '2' });
      let entered, release;
      const started = new Promise(r => (entered = r)),
        gate = new Promise(r => (release = r));
      readGate = async () => {
        entered();
        await gate;
      };
      const pending = processPage();
      await started;
      const row = (
        await db.platform.query(
          `SELECT lexical_publication_id,vector_publication_id FROM ${table('documents')} WHERE source_id=$1`,
          [source.sourceId],
        )
      ).rows[0];
      assert.deepEqual(row, { lexical_publication_id: null, vector_publication_id: null });
      await google.manage(ws.id, ws.userId, source.sourceId, { commandId: randomUUID(), action: 'pause' });
      release();
      assert.equal((await pending).disposition, 'stale');
      readGate = null;
      await google.manage(ws.id, ws.userId, source.sourceId, { commandId: randomUUID(), action: 'resume' });
      await processPage();
      await processPage();
      assert.equal((await google.list(ws.id, ws.userId)).items[0].counts.ready, 1);
      await restart();
      files.delete('one');
      await processPage();
      await processPage();
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
            [source.sourceId],
          )
        ).rows[0].n,
        0,
      );
    });
    await t.test(
      'durable breadth-first page cursor survives instance restart and invalid cursor reconciliation',
      async () => {
        files.set('two', { text: 'durable nested orchid', version: '1' });
        const seen = [];
        let invalid = false;
        const nestedProvider = {
          ...provider,
          list: async (_w, _u, _b, _s, cursor) => {
            seen.push(cursor);
            if (invalid) throw new GoogleCorpusError('invalid-cursor');
            if (!cursor)
              return {
                observations: [{ ...observation('two'), nativeId: 'child', kind: 'folder', coverage: 'folder' }],
                nextCursor: { pageToken: 'page-2', folderId: 'root' },
              };
            if (cursor.pageToken === 'page-2') return { observations: [], nextCursor: null };
            assert.equal(cursor.folderId, 'child');
            return { observations: [observation('two')], nextCursor: null };
          },
        };
        const nested = createGoogleKnowledge({ runtime, provider: nestedProvider });
        const configured = await nested.configure(ws.id, ws.userId, {
          commandId: randomUUID(),
          selection: { kind: 'drive-folder', folderId: 'other-root' },
          memberIds: [],
        });
        async function next(service = nested) {
          const work = (await service.due(ws.id)).find(w => w.sourceId === configured.sourceId);
          assert.ok(work);
          return service.process(work);
        }
        await next();
        const cursor = (
          await db.platform.query(`SELECT cursor FROM ${table('google_sources')} WHERE source_id=$1`, [
            configured.sourceId,
          ])
        ).rows[0].cursor;
        assert.deepEqual(cursor.page, { pageToken: 'page-2', folderId: 'root' });
        assert.deepEqual(cursor.folders, ['child']);
        await next(createGoogleKnowledge({ runtime, provider: nestedProvider }));
        await next();
        await next();
        assert.equal(
          (await nested.list(ws.id, ws.userId)).items.find(s => s.sourceId === configured.sourceId).counts.ready,
          1,
        );
        assert.deepEqual(seen, [
          null,
          { pageToken: 'page-2', folderId: 'root' },
          { pageToken: null, folderId: 'child' },
        ]);
        await db.platform.query(`UPDATE ${table('google_sources')} SET next_attempt_at=now() WHERE source_id=$1`, [
          configured.sourceId,
        ]);
        invalid = true;
        await next();
        invalid = false;
        const reset = (
          await db.platform.query(`SELECT cursor,reconciliation FROM ${table('google_sources')} WHERE source_id=$1`, [
            configured.sourceId,
          ])
        ).rows[0];
        assert.equal(reset.cursor.page, null);
        assert.equal(reset.reconciliation, 3);
        const command = { commandId: randomUUID(), action: 'remove' };
        await nested.manage(ws.id, ws.userId, configured.sourceId, command);
        await nested.manage(ws.id, ws.userId, configured.sourceId, command);
        assert.equal(
          (await nested.list(ws.id, ws.userId)).items.find(s => s.sourceId === configured.sourceId).state,
          'removed',
        );
      },
    );
    await t.test('manager generation and selected local grant invalidate shared reads immediately', async () => {
      await restart();
      await processPage();
      await processPage();
      await google.refresh(ws.id, reader.userId, source.sourceId);
      const embeddings = createKnowledgeEmbeddings({ runtime, google, config: { kind: 'disabled' } });
      const search = createKnowledgeSearch({ runtime, google, embeddings });
      const query = () =>
        search.search(ws.id, reader.userId, {
          kind: 'typing',
          query: 'orchid',
          filters: { sourceIds: [source.sourceId] },
        });
      assert.equal((await query()).hits.length, 1);
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=generation+1 WHERE id=$1`, [
        binding.integrationId,
      ]);
      assert.equal((await query()).hits.length, 0);
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=generation-1 WHERE id=$1`, [
        binding.integrationId,
      ]);
      await db.platform.query(`DELETE FROM ${table('google_members')} WHERE source_id=$1 AND membership_id=$2`, [
        source.sourceId,
        reader.membershipId,
      ]);
      assert.equal((await query()).hits.length, 0);
      await assert.rejects(google.refresh(ws.id, reader.userId, source.sourceId));
      await search.close();
    });
    await t.test('same-account reconnect retry rebinds; different account requires a new source', async () => {
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET generation=2 WHERE id=$1`, [
        binding.integrationId,
      ]);
      binding.generation = 2;
      await google.manage(ws.id, ws.userId, source.sourceId, { commandId: randomUUID(), action: 'retry' });
      assert.equal(
        (
          await db.platform.query(`SELECT binding FROM ${table('google_sources')} WHERE source_id=$1`, [
            source.sourceId,
          ])
        ).rows[0].binding.generation,
        2,
      );
      const originalAccount = binding.accountId;
      binding.accountId = 'another-account';
      await assert.rejects(
        google.manage(ws.id, ws.userId, source.sourceId, { commandId: randomUUID(), action: 'retry' }),
      );
      binding.accountId = originalAccount;
    });
    await t.test('Gmail immutable native bytes use provider Markdown through the P1 parser', async () => {
      binding.requiredScopes = ['https://www.googleapis.com/auth/gmail.readonly'];
      await db.platform.query(`UPDATE ${table('tf_google_integrations')} SET scopes=$2 WHERE id=$1`, [
        binding.integrationId,
        binding.requiredScopes,
      ]);
      files.set('mail', { text: 'unused', version: '1' });
      const native = Buffer.from('{"message":"native retained envelope"}');
      const mailProvider = {
        ...provider,
        list: async () => ({ observations: [{ ...observation('mail'), kind: 'message' }], nextCursor: null }),
        read: async () => {
          const o = { ...observation('mail'), kind: 'message' };
          return {
            ...o,
            bytes: native,
            filename: 'mail.json',
            mediaType: 'application/json',
            normalizedContent: 'Gmail orchid delivery details',
            metadataBefore: o,
            metadataAfter: o,
          };
        },
      };
      const mail = createGoogleKnowledge({ runtime, provider: mailProvider });
      const source = await mail.configure(ws.id, ws.userId, {
        commandId: randomUUID(),
        selection: { kind: 'gmail', labelId: null, after: '2026-01-01', before: '2026-02-01' },
        memberIds: [],
      });
      const work = (await mail.due(ws.id)).find(w => w.sourceId === source.sourceId);
      assert.equal((await mail.process(work)).disposition, 'retry');
      const search = createKnowledgeSearch({
        runtime,
        google: mail,
        embeddings: createKnowledgeEmbeddings({ runtime, google: mail, config: { kind: 'disabled' } }),
      });
      const result = await search.search(ws.id, ws.userId, {
        kind: 'typing',
        query: 'delivery',
        filters: { sourceIds: [source.sourceId] },
      });
      assert.equal(result.hits.length, 1);
      assert.equal(
        (
          await mail.original(ws.id, ws.userId, result.hits[0].citation.documentId, result.hits[0].citation.revisionId)
        ).bytes.toString(),
        native.toString(),
      );
      assert.equal(
        (await mail.evidence(ws.id, ws.userId, result.hits[0].citation)).text,
        'Gmail orchid delivery details',
      );
      await assert.rejects(mail.refresh(ws.id, reader.userId, source.sourceId));
      await search.close();
    });
  } finally {
    await runtime?.close();
    await db.close();
  }
});
