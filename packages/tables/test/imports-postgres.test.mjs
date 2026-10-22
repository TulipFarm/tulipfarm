import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { AccessDenied } from '@tulipfarm/access';
import { createTableImports, requireImportFiles } from '../../tables/dist/imports.js';

test(
  'imports bind real SQL ownership, immutable bytes, completed receipts, source revocation and independent Files authority',
  { skip: !process.env.IMPORTS_TEST_DATABASE_URL },
  async () => {
    const destination = new URL(process.env.IMPORTS_TEST_DATABASE_URL);
    assert.equal(destination.hostname, '127.0.0.1');
    assert.equal(destination.port, '55483');
    assert.equal(destination.search, '');
    const client = new Client({ connectionString: process.env.IMPORTS_TEST_DATABASE_URL });
    await client.connect();
    const schema = `imports_test_${randomUUID().replaceAll('-', '')}`;
    const s = `"${schema}"`;
    const id = randomUUID;
    const tx = { client, schema, workspaceId: id(), commonVersion: 57 };
    const runtime = {
      transaction: async (workspaceId, range, operation) => {
        assert.equal(workspaceId, tx.workspaceId);
        assert.ok(tx.commonVersion >= range.minimum && tx.commonVersion <= range.maximum);
        await client.query('BEGIN');
        try {
          const result = await operation(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    };
    const actor = { kind: 'human', userId: id(), membershipId: id() };
    const origin = { conversationId: id(), turnId: id(), sources: [] };
    const attachmentId = id(),
      objectKey = id(),
      messageId = id(),
      resultId = id(),
      fileId = id(),
      folderId = id(),
      integrationId = id(),
      sourceId = id();
    const content = Buffer.from('id,title\n001,Private ticket\n');
    const reference = { kind: 'file', attachmentId, contentDigest: createHash('sha256').update(content).digest('hex') };
    const objects = new Map([[`${tx.workspaceId}/${objectKey}`, content]]);
    const store = {
      putIfAbsent: async (key, bytes) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      },
      read: async (key, length) => {
        const bytes = objects.get(key);
        if (!bytes || bytes.length !== length) throw new Error('private-storage-value');
        return Buffer.from(bytes);
      },
    };
    const adapter = createTableImports({
      attachments: store,
      snapshots: store,
      requireSources: async (tx, actor, sources) => {
        for (const source of sources)
          if (source.kind === 'github-source') {
            const result = await tx.client.query(
              `SELECT 1 FROM ${s}.source_access WHERE id=$1 AND membership_id=$2 AND allowed`,
              [source.sourceId, actor.membershipId],
            );
            if (!result.rowCount) throw new AccessDenied();
          }
      },
    });
    const selection = {
      format: 'csv',
      delimiter: ',',
      header: { kind: 'row', row: 1 },
      conversions: {},
      empty: 'null',
    };
    try {
      await client.query(`CREATE SCHEMA ${s};
      CREATE TABLE ${s}.tf_authorization_lock(id integer); INSERT INTO ${s}.tf_authorization_lock VALUES(1);
      CREATE TABLE ${s}.tf_memberships(id uuid,user_id text,role text,removed_at timestamptz);
      CREATE TABLE ${s}.tf_conversations(id uuid,kind text,owner_user_id text,owner_membership_id uuid);
      CREATE TABLE ${s}.tf_conversation_turns(id uuid,conversation_id uuid,source_message_id uuid,status text);
      CREATE TABLE ${s}.tf_conversation_messages(id uuid,conversation_id uuid,author_kind text,membership_id uuid);
      CREATE TABLE ${s}.tf_conversation_attachments(id uuid,conversation_id uuid,membership_id uuid,sha256 text,state text,object_key uuid,size integer,message_id uuid);
      CREATE TABLE ${s}.tf_conversation_parts(attachment_id uuid,conversation_id uuid,message_id uuid);
      CREATE TABLE ${s}.tf_conversation_tool_calls(id uuid,conversation_id uuid,turn_id uuid,tool text,status text);
      CREATE TABLE ${s}.source_access(id uuid,membership_id uuid,allowed boolean);
      CREATE TABLE ${s}.tf_common_migrations(name text);
      CREATE TABLE ${s}.tf_table_import_objects(object_key text PRIMARY KEY,membership_id uuid,conversation_id uuid,turn_id uuid,kind text,reference_id uuid,last_used_at timestamptz,cleanup_pending_at timestamptz);
      CREATE TABLE ${s}.tf_files(id uuid,kind text,creator_membership_id uuid,parent_id uuid,name text,object_key uuid,media_type text,size integer,sha256 text,ready boolean,trashed_at timestamptz);
      ALTER TABLE ${s}.tf_files ADD COLUMN created_at timestamptz DEFAULT clock_timestamp();
      CREATE TABLE ${s}.tf_file_grants(item_id uuid,subject_kind text,subject_id uuid,role text);
      CREATE TABLE ${s}.tf_member_teams(membership_id uuid,team_id uuid);
      CREATE TABLE ${s}.tf_teams(id uuid);`);
      await client.query(`INSERT INTO ${s}.tf_memberships VALUES($1,$2,'member',NULL)`, [
        actor.membershipId,
        actor.userId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversations VALUES($1,'private',$2,$3)`, [
        origin.conversationId,
        actor.userId,
        actor.membershipId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversation_turns VALUES($1,$2,$3,'processing')`, [
        origin.turnId,
        origin.conversationId,
        messageId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversation_messages VALUES($1,$2,'human',$3)`, [
        messageId,
        origin.conversationId,
        actor.membershipId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversation_attachments VALUES($1,$2,$3,$4,'bound',$5,$6,$7)`, [
        attachmentId,
        origin.conversationId,
        actor.membershipId,
        reference.contentDigest,
        objectKey,
        content.length,
        messageId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversation_parts VALUES($1,$2,$3)`, [
        attachmentId,
        origin.conversationId,
        messageId,
      ]);
      await client.query(`INSERT INTO ${s}.tf_conversation_tool_calls VALUES($1,$2,$3,'github.issue.read','running')`, [
        resultId,
        origin.conversationId,
        origin.turnId,
      ]);
      await client.query(`INSERT INTO ${s}.source_access VALUES($1,$2,true)`, [sourceId, actor.membershipId]);
      await adapter.prepareFile(runtime, tx.workspaceId, actor, origin, reference, selection);
      assert.deepEqual(await adapter.readSnapshot(tx, actor, origin, reference), {
        contentDigest: reference.contentDigest,
        sources: [{ kind: 'private-conversation', conversationId: origin.conversationId }],
        rows: [{ id: { kind: 'text', value: '001' }, title: { kind: 'text', value: 'Private ticket' } }],
      });
      await assert.rejects(
        adapter.prepareFile(runtime, tx.workspaceId, actor, origin, reference, { ...selection, empty: 'text' }),
        /snapshot-conflict/,
      );
      await assert.rejects(adapter.readSnapshot(tx, { ...actor, membershipId: id() }, origin, reference), AccessDenied);
      await assert.rejects(
        adapter.readSnapshot(tx, actor, { ...origin, conversationId: id() }, reference),
        AccessDenied,
      );
      objects.set(`${tx.workspaceId}/${objectKey}`, Buffer.from(content.toString().replace('001', '999')));
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, reference), /digest-mismatch/);
      objects.set(`${tx.workspaceId}/${objectKey}`, content);
      await client.query(`DELETE FROM ${s}.tf_conversation_parts`);
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, reference), AccessDenied);
      const sources = [{ kind: 'github-source', integrationId, sourceId, generation: 1, grantsVersion: 1 }];
      const captured = await adapter.captureIntegration(
        runtime,
        { workspaceId: tx.workspaceId, actor, origin, resultId, tool: 'github.issue.read' },
        { format: 'object', path: [], columns: ['number', 'title'], conversions: { number: 'numeric' }, empty: 'null' },
        async () => ({ result: { number: 42, title: 'Saved title' }, sources }),
      );
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, captured), AccessDenied);
      await client.query(`UPDATE ${s}.tf_conversation_tool_calls SET status='completed'`);
      assert.deepEqual((await adapter.readSnapshot(tx, actor, origin, captured)).rows, [
        { number: { kind: 'numeric', value: '42' }, title: { kind: 'text', value: 'Saved title' } },
      ]);
      const matrixId = id();
      await client.query(`INSERT INTO ${s}.tf_conversation_tool_calls VALUES($1,$2,$3,'google.read','running')`, [
        matrixId,
        origin.conversationId,
        origin.turnId,
      ]);
      const googleSources = [
        {
          kind: 'google-integration',
          integrationId,
          accountId: 'fixture',
          membershipId: actor.membershipId,
          generation: 1,
          scopes: ['sheets'],
          requiredScopes: ['sheets'],
        },
      ];
      const matrix = await adapter.captureIntegration(
        runtime,
        { workspaceId: tx.workspaceId, actor, origin, resultId: matrixId, tool: 'google.read' },
        {
          format: 'matrix',
          path: ['data', 'values'],
          header: { kind: 'row', row: 1 },
          conversions: { count: 'numeric' },
          empty: 'null',
        },
        async () => ({
          result: {
            data: {
              values: [
                ['id', 'count'],
                ['002', '7'],
              ],
            },
          },
          sources: googleSources,
        }),
      );
      await client.query(`UPDATE ${s}.tf_conversation_tool_calls SET status='completed' WHERE id=$1`, [matrixId]);
      assert.deepEqual((await adapter.readSnapshot(tx, actor, origin, matrix)).rows, [
        { id: { kind: 'text', value: '002' }, count: { kind: 'numeric', value: '7' } },
      ]);
      const uncaptured = id();
      await client.query(`INSERT INTO ${s}.tf_conversation_tool_calls VALUES($1,$2,$3,'atlassian.read','completed')`, [
        uncaptured,
        origin.conversationId,
        origin.turnId,
      ]);
      await assert.rejects(
        adapter.readSnapshot(tx, actor, origin, {
          kind: 'integration',
          resultId: uncaptured,
          contentDigest: 'a'.repeat(64),
        }),
        /snapshot-unavailable/,
      );
      await assert.rejects(
        adapter.readSnapshot(tx, actor, origin, { ...captured, contentDigest: '0'.repeat(64) }),
        /digest-mismatch/,
      );
      await client.query(`UPDATE ${s}.source_access SET allowed=false`);
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, captured), AccessDenied);
      await client.query(`UPDATE ${s}.source_access SET allowed=true`);
      await client.query(`UPDATE ${s}.tf_conversation_tool_calls SET turn_id=$1 WHERE id=$2`, [id(), resultId]);
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, captured), AccessDenied);
      await client.query(`UPDATE ${s}.tf_conversation_tool_calls SET turn_id=$1 WHERE id=$2`, [
        origin.turnId,
        resultId,
      ]);
      const key = [...objects.keys()].find(key => key.endsWith(`result-${resultId}.json`));
      objects.delete(key);
      await assert.rejects(
        adapter.readSnapshot(tx, actor, origin, captured),
        error => error.message === 'import-unavailable' && !JSON.stringify(error).includes('private-storage-value'),
      );
      const { filesMigration } = await import('@tulipfarm/files/migrations');
      await client.query(`INSERT INTO ${s}.tf_common_migrations VALUES($1)`, [filesMigration]);
      await client.query(
        `INSERT INTO ${s}.tf_files VALUES($1,'folder',$3,NULL,'Parent',NULL,NULL,NULL,NULL,true,NULL),($2,'file',$3,$1,'Private filename',$4,'text/plain',1,$5,true,NULL)`,
        [folderId, fileId, id(), id(), 'a'.repeat(64)],
      );
      await assert.rejects(requireImportFiles(tx, actor, [fileId]), AccessDenied);
      await client.query(`INSERT INTO ${s}.tf_file_grants VALUES($1,'individual',$2,'viewer')`, [
        folderId,
        actor.membershipId,
      ]);
      await requireImportFiles(tx, actor, [fileId]);
      await assert.rejects(requireImportFiles(tx, actor, [folderId]), AccessDenied);
      await client.query(`UPDATE ${s}.tf_files SET trashed_at=clock_timestamp() WHERE id=$1`, [folderId]);
      await assert.rejects(requireImportFiles(tx, actor, [fileId]), AccessDenied);
      await client.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp()`);
      await assert.rejects(adapter.readSnapshot(tx, actor, origin, reference), AccessDenied);
    } finally {
      await client.query(`DROP SCHEMA ${s} CASCADE`);
      await client.end();
    }
  },
);
