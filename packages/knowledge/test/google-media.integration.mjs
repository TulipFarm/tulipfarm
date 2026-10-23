import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createGoogleKnowledge } from '../dist/index.js';
import { pdf } from './fixtures/parser-documents.mjs';

test('a Google scan waiting for recognition is parsed again from its stored original without a new read', async () => {
  const db = await fixture();
  let runtime;
  try {
    await loadPlatformBaseline(db.platform);
    const ws = await db.create(await workspaceTableMigrations());
    const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
    });
    const binding = {
      integrationId: randomUUID(),
      accountId: 'manager-account',
      generation: 1,
      requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    };
    await db.platform.query(
      `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,$4,'connected',$5,'fixture@example.test',$6,'{}')`,
      [
        binding.integrationId,
        ws.userId,
        ws.membershipId,
        binding.generation,
        binding.accountId,
        binding.requiredScopes,
      ],
    );
    const scan = await pdf(['scan']);
    const observation = () => ({
      nativeId: 'scan',
      title: 'Planting calendar',
      canonicalURL: 'https://drive.google.com/file/d/scan',
      sourceRevision: '1',
      accessedAt: new Date().toISOString(),
      kind: 'file',
      mediaType: 'application/pdf',
      parentIds: ['root'],
      coverage: 'supported',
    });
    let reads = 0;
    const provider = {
      discover: async () => ({ binding, items: [], nextCursor: null }),
      inspectSelection: async (_w, _u, s) => ({ binding, selection: s, title: 'Selected folder' }),
      list: async () => ({ observations: [observation()], nextCursor: null }),
      check: async () => observation(),
      read: async () => {
        reads++;
        const o = observation();
        return {
          ...o,
          bytes: scan,
          filename: 'scan.pdf',
          normalizedContent: null,
          metadataBefore: o,
          metadataAfter: o,
        };
      },
    };
    let available = false;
    const calls = [];
    const recognizer = {
      modelId: 'vision-test',
      promptVersion: 'media-v1',
      async recognize(request) {
        calls.push(request.kind);
        return { kind: 'recognized', text: 'Plant tulips in October.', description: 'A planting calendar' };
      },
    };
    const google = createGoogleKnowledge({
      runtime,
      provider,
      recognition: async () => (available ? { recognizer } : undefined),
      recognitionAvailable: async () => available,
    });
    await google.configure(ws.id, ws.userId, {
      commandId: randomUUID(),
      selection: { kind: 'drive-folder', folderId: 'root' },
      memberIds: [],
    });
    const processPage = async () => {
      await db.platform.query(`UPDATE ${table('google_sources')} SET next_attempt_at=clock_timestamp()`);
      const work = (await google.due(ws.id))[0];
      assert.ok(work);
      return (await google.process(work)).disposition;
    };
    const state = async () =>
      (
        await db.platform.query(
          `SELECT w.parsing,d.lexical_publication_id AS publication FROM ${table('documents')} d
            JOIN ${table('work')} w ON w.revision_id=d.observed_revision_id`,
        )
      ).rows[0];

    assert.equal(await processPage(), 'retry');
    assert.equal(await processPage(), 'ready');
    assert.equal((await state()).parsing, 'ocr-unavailable');
    assert.equal(reads, 1);

    available = true;
    await processPage();
    assert.deepEqual(calls, ['page']);
    assert.equal(reads, 1, 'the stored original is parsed again without reading Google');
    const current = await state();
    assert.equal(current.parsing, 'ready');
    const published = await db.platform.query(
      `SELECT p.markdown,f.profile FROM ${table('publications')} p
        JOIN ${table('parse_profiles')} f ON f.publication_id=p.id WHERE p.id=$1`,
      [current.publication],
    );
    assert.match(published.rows[0].markdown, /Plant tulips in October/);
    assert.equal(published.rows[0].profile.ocrModel, 'vision-test');

    await processPage();
    assert.deepEqual(calls, ['page'], 'a recognized revision is not parsed again');
  } finally {
    await runtime?.close();
    await db.close();
  }
});
