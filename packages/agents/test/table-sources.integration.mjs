import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import {
  requireTableSources,
  requireTableFiles,
  requireTableImportAttachment,
  requireTableImportReference,
} from '../src/table-sources.ts';
import { createTableImports } from '@tulipfarm/tables/imports';

test('table execution source bridge exposes authority, not conversations, file metadata, or provider credentials', async t => {
  const db = await fixture();
  let migration, runtimeClient;
  t.after(async () => {
    await runtimeClient?.end();
    await migration?.end();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const migrations = await workspaceTableMigrations();
  const ws = await db.create(migrations),
    other = await db.create(migrations);
  const s = `"${ws.names.schema}"`;
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const chat = randomUUID(),
    strangerChat = randomUUID(),
    stranger = randomUUID(),
    file = randomUUID(),
    folder = randomUUID(),
    team = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,'stranger','member')`, [
    stranger,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3),($4,'stranger',$5)`,
    [chat, ws.userId, ws.membershipId, strangerChat, stranger],
  );
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'File readers')`, [team]);
  await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
    ws.membershipId,
    team,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_files(id,kind,name,creator_membership_id,ready) VALUES($1,'folder','Private folder',$2,true)`,
    [folder, stranger],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_files(id,kind,name,parent_id,creator_membership_id,ready,object_key,size,media_type,sha256) VALUES($1,'file','Private file',$2,$3,true,$4,1,'text/plain',$5)`,
    [file, folder, stranger, randomUUID(), 'a'.repeat(64)],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_file_grants(item_id,subject_kind,subject_id,role) VALUES($1,'team',$2,'viewer')`,
    [folder, team],
  );
  migration = await connect(db.login(ws, 'migration'));
  await migration.query(`SET ROLE "${ws.names.customOwner}"`);
  const tx = { client: migration, schema: ws.names.schema, workspaceId: ws.id, commonVersion: migrations.length };
  await requireTableSources(tx, actor, [{ kind: 'private-conversation', conversationId: chat }]);
  await assert.rejects(
    requireTableSources(tx, actor, [{ kind: 'private-conversation', conversationId: strangerChat }]),
  );
  await requireTableFiles(tx, actor, [file]);
  await assert.rejects(requireTableFiles(tx, actor, [folder]));
  await denied(migration, `SELECT title FROM ${s}.tf_conversations`);
  await denied(migration, `SELECT name,object_key FROM ${s}.tf_files`);
  await denied(migration, `SELECT credential FROM ${s}.tf_atlassian_accounts`);
  await denied(migration, `SELECT "${other.names.schema}".tf_table_source_allowed($1,$2,$3)`, [
    actor.membershipId,
    actor.userId,
    { kind: 'private-conversation', conversationId: chat },
  ]);
  const allowed = await migration.query(`SELECT ${s}.tf_table_source_allowed($1,$2,$3) AS allowed`, [
    actor.membershipId,
    actor.userId,
    { kind: 'private-conversation', conversationId: chat },
  ]);
  assert.equal(allowed.rows[0].allowed, true);
  const attachment = randomUUID(),
    message = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, chat, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_attachments(id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id) VALUES($1,$2,$3,$4,'source.csv','text/csv',1,$5,'bound',$6)`,
    [attachment, chat, actor.membershipId, randomUUID(), 'a'.repeat(64), message],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,attachment_id) VALUES($1,$2,0,'attachment',$3)`,
    [chat, message, attachment],
  );
  await requireTableImportAttachment(tx, actor, chat, { attachmentId: attachment, contentDigest: 'a'.repeat(64) });
  await assert.rejects(
    requireTableImportAttachment(tx, actor, chat, { attachmentId: attachment, contentDigest: 'b'.repeat(64) }),
  );
  await db.platform.query(`DELETE FROM ${s}.tf_conversation_parts WHERE attachment_id=$1`, [attachment]);
  await assert.rejects(
    requireTableImportAttachment(tx, actor, chat, { attachmentId: attachment, contentDigest: 'a'.repeat(64) }),
  );
  const turn = randomUUID(),
    resultId = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,sequence,tool,status) VALUES($1,$2,$3,1,'github.issue.read','running')`,
    [resultId, chat, turn],
  );
  const reference = { kind: 'integration', resultId, contentDigest: 'a'.repeat(64) };
  await assert.rejects(requireTableImportReference(tx, actor, chat, reference));
  await db.platform.query(`UPDATE ${s}.tf_conversation_tool_calls SET status='completed' WHERE id=$1`, [resultId]);
  await requireTableImportReference(tx, actor, chat, reference);
  await assert.rejects(requireTableImportReference(tx, actor, strangerChat, reference));
  await db.platform.query(`UPDATE ${s}.tf_conversation_tool_calls SET tool='rows.page' WHERE id=$1`, [resultId]);
  await assert.rejects(requireTableImportReference(tx, actor, chat, reference));
  const content = Buffer.from('key,title\n001,Private ticket\n'),
    objectKey = randomUUID();
  const contentDigest = createHash('sha256').update(content).digest('hex');
  await db.platform.query(`UPDATE ${s}.tf_conversation_attachments SET object_key=$2,size=$3,sha256=$4 WHERE id=$1`, [
    attachment,
    objectKey,
    content.length,
    contentDigest,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_parts(conversation_id,message_id,ordinal,kind,attachment_id) VALUES($1,$2,0,'attachment',$3)`,
    [chat, message, attachment],
  );
  const objects = new Map([[`${ws.id}/${objectKey}`, content]]);
  const bytes = {
    read: async (key, size) => {
      const value = objects.get(key);
      assert.equal(value?.length, size);
      return value;
    },
    putIfAbsent: async (key, value) => {
      if (!objects.has(key)) objects.set(key, value);
    },
  };
  const imports = createTableImports({ attachments: bytes, snapshots: bytes, requireSources: requireTableSources });
  runtimeClient = await connect(db.login(ws));
  const runtimeTx = { ...tx, client: runtimeClient };
  const origin = {
    conversationId: chat,
    turnId: turn,
    sources: [{ kind: 'private-conversation', conversationId: chat }],
  };
  const fileReference = { kind: 'file', attachmentId: attachment, contentDigest };
  assert.deepEqual(
    await imports.prepareFile(
      { transaction: async (_workspace, _range, operation) => operation(runtimeTx) },
      ws.id,
      actor,
      origin,
      fileReference,
      { format: 'csv', delimiter: ',', header: { kind: 'row', row: 1 }, conversions: {}, empty: 'null' },
    ),
    fileReference,
  );
  assert.deepEqual(await imports.readSnapshot(runtimeTx, actor, origin, fileReference), {
    contentDigest,
    sources: origin.sources,
    rows: [{ key: { kind: 'text', value: '001' }, title: { kind: 'text', value: 'Private ticket' } }],
  });
  await db.platform.query(`DELETE FROM ${s}.tf_conversation_parts WHERE attachment_id=$1`, [attachment]);
  await assert.rejects(imports.readSnapshot(runtimeTx, actor, origin, fileReference));
  const github = randomUUID(),
    githubSource = randomUUID(),
    google = randomUUID(),
    atlassian = randomUUID(),
    atlassianSource = randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_integrations(id,owning_team_id,name,credential,creation_intent,created_by) VALUES($1,$2,'Github','{}','{}','{}')`,
    [github, team],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_integration_sources(id,integration_id,owner,repo) VALUES($1,$2,'owner','repo')`,
    [githubSource, github],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_integration_grants(integration_id,team_id,permission) VALUES($1,$2,'read'),($1,$2,'use')`,
    [github, team],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_integration_source_grants(integration_id,source_id,team_id) VALUES($1,$2,$3)`,
    [github, githubSource, team],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_google_integrations(id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES($1,$2,$3,1,'connected','account','fixture@example.com',ARRAY['sheets'],'{}')`,
    [google, actor.userId, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_atlassian_accounts(id,protocol,ownership,owner_membership_id,state,config_hash,identity,credential,expires_at) VALUES($1,'atlassian-rest','personal',$2,'active','hash','{}','{}',now()+interval '1 hour')`,
    [atlassian, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_atlassian_sources(id,account_id,membership_id,name,binding) VALUES($1,$2,$3,'Jira',$4)`,
    [atlassianSource, atlassian, actor.membershipId, { site: 'fixture' }],
  );
  const dependencies = [
    { kind: 'github-source', integrationId: github, sourceId: githubSource, generation: 1, grantsVersion: 1 },
    {
      kind: 'google-integration',
      integrationId: google,
      accountId: 'account',
      membershipId: actor.membershipId,
      generation: 1,
      scopes: ['sheets'],
      requiredScopes: ['sheets'],
    },
    {
      kind: 'atlassian-source',
      accountId: atlassian,
      sourceId: atlassianSource,
      membershipId: actor.membershipId,
      generation: 1,
      grantsVersion: 1,
      binding: '{"site":"fixture"}',
    },
  ];
  await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [actor.membershipId]);
  for (const source of dependencies) {
    await requireTableSources(tx, actor, [source]);
    assert.equal(
      (
        await migration.query(`SELECT ${s}.tf_table_source_allowed($1,$2,$3) AS allowed`, [
          actor.membershipId,
          actor.userId,
          source,
        ])
      ).rows[0].allowed,
      true,
    );
    await assert.rejects(requireTableSources(tx, actor, [{ ...source, generation: 2 }]));
  }
  await denied(migration, `SELECT credential FROM ${s}.tf_google_integrations`);
  await denied(migration, `SELECT credential FROM ${s}.tf_integrations`);
  await db.platform.query(`DELETE FROM ${s}.tf_integration_source_grants WHERE source_id=$1`, [githubSource]);
  await assert.rejects(requireTableSources(tx, actor, [dependencies[0]]));
  await db.platform.query(`UPDATE ${s}.tf_google_integrations SET scopes=ARRAY['drive'] WHERE id=$1`, [google]);
  await assert.rejects(requireTableSources(tx, actor, [dependencies[1]]));
  await db.platform.query(`UPDATE ${s}.tf_atlassian_sources SET binding='{"site":"changed"}' WHERE id=$1`, [
    atlassianSource,
  ]);
  await assert.rejects(requireTableSources(tx, actor, [dependencies[2]]));
  await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=now() WHERE id=$1`, [folder]);
  await assert.rejects(requireTableFiles(tx, actor, [file]));
  await db.platform.query(`UPDATE ${s}.tf_files SET trashed_at=NULL WHERE id=$1`, [folder]);
  await db.platform.query(`DELETE FROM ${s}.tf_member_teams WHERE membership_id=$1`, [ws.membershipId]);
  await assert.rejects(requireTableFiles(tx, actor, [file]));
  await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=now() WHERE id=$1`, [ws.membershipId]);
  await assert.rejects(requireTableSources(tx, actor, [{ kind: 'private-conversation', conversationId: chat }]));
});
