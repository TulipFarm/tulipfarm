import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createFiles } from '@tulipfarm/files';
import { AccessDenied } from '@tulipfarm/access';
import {
  createKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
} from '../dist/index.js';

test(
  'Knowledge search hides a generated file once its recorded sources stop being readable',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, search;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const one = await db.create(await workspaceTableMigrations());
      const table = name => qualified(one.names.schema, name);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        maxPools: 2,
        connectionsPerPool: 4,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => {
          assert.equal(id, one.id);
          return { workspaceId: id, generation: 1, connectionString: db.login(one) };
        },
      });
      const reader = { userId: randomUUID(), membershipId: randomUUID() };
      const actor = { kind: 'human', ...reader };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        reader.membershipId,
        reader.userId,
      ]);
      const objects = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, bytes) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        },
        read: async key => Buffer.from(objects.get(key)),
        remove: async key => {
          objects.delete(key);
        },
      });
      const local = createLocalKnowledge({ runtime, files });
      const knowledge = createKnowledge({ runtime });
      search = createKnowledgeSearch({
        runtime,
        embeddings: createKnowledgeEmbeddings({ runtime, config: { kind: 'disabled' } }),
      });
      const text = 'orchid provenance sentinel';
      const fileId = randomUUID(),
        documentId = randomUUID(),
        revisionId = randomUUID();
      await files.upload(
        one.id,
        reader.userId,
        fileId,
        { name: 'Result.txt', parentId: null, mediaType: 'text/plain' },
        Buffer.from(text),
      );
      await local.save(one.id, reader.userId, {
        commandId: revisionId,
        documentId,
        expectedRevisionId: null,
        title: 'Result.txt',
        input: { kind: 'file', fileId },
      });
      await knowledge.publishLexical(one.id, actor, {
        id: randomUUID(),
        documentId,
        revisionId,
        markdown: `${text}\n`,
        pages: 0,
        tokens: 3,
        chunks: [{ heading: '', text, tokens: 3, offset: { kind: 'passage' } }],
      });
      const submitted = { kind: 'submitted', commandId: randomUUID(), query: 'orchid' };
      const before = await search.search(one.id, reader.userId, submitted);
      assert.deepEqual(
        before.hits.map(hit => hit.text),
        [text],
      );

      // Skill execution records these sources for the files it creates; an unavailable source models one the reader lost.
      const skillId = randomUUID(),
        skillRevision = 'a'.repeat(64),
        invocationId = randomUUID();
      await db.platform.query(
        `WITH skill AS (INSERT INTO ${table('tf_workspace_skills')} (id,creator_id,saved_revision,active_revision,enabled) VALUES ($1,$2,$3,$3,true) RETURNING id)
      INSERT INTO ${table('tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) SELECT id,$3,$4,$2 FROM skill`,
        [skillId, reader.membershipId, skillRevision, { name: 'Fixture', instructions: 'Fixture procedure.' }],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_skill_invocations')} (id,membership_id,skill_id,revision,request,sources,scope) VALUES ($1,$2,$3,$4,'{}','[]','{}')`,
        [invocationId, reader.membershipId, skillId, skillRevision],
      );
      await db.platform.query(
        `INSERT INTO ${table('tf_file_skill_sources')} (file_id,invocation_id,sources) VALUES ($1,$2,$3)`,
        [fileId, invocationId, JSON.stringify([{ kind: 'unavailable' }])],
      );

      await assert.rejects(files.download(one.id, reader.userId, fileId), AccessDenied);
      await assert.rejects(local.evidence(one.id, reader.userId, before.hits[0].citation), AccessDenied);
      const fresh = await search.search(one.id, reader.userId, { ...submitted, commandId: randomUUID() });
      assert.deepEqual(fresh.hits, [], 'a new search omits the generated file');
      assert.equal(fresh.coverage, 'partial');
      assert.deepEqual(
        (await search.search(one.id, reader.userId, submitted)).hits,
        [],
        'replaying the earlier search omits it too',
      );
      assert.deepEqual((await search.search(one.id, reader.userId, { kind: 'typing', query: 'orch' })).hits, []);
    } finally {
      await search?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
