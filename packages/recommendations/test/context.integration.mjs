import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveHuman } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createFiles } from '@tulipfarm/files';
import { createProjects } from '@tulipfarm/conversations/projects';
import { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createLocalKnowledge } from '../../knowledge/dist/index.js';
import {
  collectRecommendationContext,
  fallbackRecommendations,
  readSavedRecommendations,
  recommendationPolicy,
} from '../dist/index.js';

test(
  'real permissions bound member context, source revocation, no-op memory and saved-only reads',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    try {
      const w = f.workspace;
      const alice = { membershipId: randomUUID(), userId: randomUUID() };
      const bob = { membershipId: randomUUID(), userId: randomUUID() };
      for (const person of [alice, bob])
        await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
          person.membershipId,
          person.userId,
        ]);
      const objects = new Map();
      const files = createFiles(f.runtime, {
        putIfAbsent: async (key, bytes) => {
          objects.set(key, Buffer.from(bytes));
        },
        read: async key => Buffer.from(objects.get(key)),
        remove: async key => {
          objects.delete(key);
        },
      });
      const projects = createProjects(f.runtime, undefined, files);
      const memory = createPersonalMemoryService(f.runtime);
      const projectId = randomUUID(),
        fileId = randomUUID();
      await memory.save(w.id, alice.userId, {
        content: 'Alice prefers concise customer checklists.',
        expectedRevision: 0,
      });
      await projects.create(w.id, alice.userId, { id: projectId, name: 'Private customer launch' });
      await projects.edit(w.id, alice.userId, projectId, {
        expectedRevision: 0,
        name: 'Private customer launch',
        instructions: 'Ask before changing the launch date.',
        archived: false,
      });
      await projects.member(w.id, alice.userId, projectId, {
        membershipId: bob.membershipId,
        role: 'member',
        removed: false,
      });
      await files.upload(
        w.id,
        alice.userId,
        fileId,
        { name: 'Launch notes.txt', parentId: null, mediaType: 'text/plain' },
        Buffer.from('Private source instruction: the launch date is November 12.'),
      );
      await files.share(w.id, alice.userId, fileId, { kind: 'individual', id: bob.membershipId }, 'viewer');
      const promoted = await projects.addFile(w.id, alice.userId, projectId, { fileId, commandId: randomUUID() });
      await f.db.platform.query(`UPDATE ${f.table('tf_files')} SET object_owner='attachment' WHERE id=$1`, [fileId]);
      const automaticFile = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_files')}
      (id,kind,creator_membership_id,name,object_key,object_owner,media_type,size,sha256,ready)
      VALUES($1,'file',$2,'Excluded automatic chat attachment.txt',$3,'attachment','text/plain',10,$4,true)`,
        [automaticFile, alice.membershipId, randomUUID(), 'b'.repeat(64)],
      );

      const knowledgeFileId = randomUUID(),
        documentId = randomUUID(),
        revisionId = randomUUID(),
        protectedIntegrationId = randomUUID();
      await files.upload(
        w.id,
        bob.userId,
        knowledgeFileId,
        { name: 'Returns.md', parentId: null, mediaType: 'text/markdown' },
        Buffer.from('# Returns\nReturn customer orders within thirty days.'),
      );
      await files.share(w.id, bob.userId, knowledgeFileId, { kind: 'individual', id: alice.membershipId }, 'viewer');
      const knowledge = createLocalKnowledge({ runtime: f.runtime, files });
      await knowledge.save(w.id, alice.userId, {
        commandId: revisionId,
        documentId,
        expectedRevisionId: null,
        title: 'Returns.md',
        input: { kind: 'file', fileId: knowledgeFileId },
      });
      const work = (await knowledge.due(w.id)).find(item => item.revisionId === revisionId);
      assert.ok(work);
      await knowledge.acknowledge(work);
      assert.equal((await knowledge.process(work)).disposition, 'ready');
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_mcp_integrations')}
      (id,ownership,owner_membership_id,name,endpoint,server_identity,auth_method,lifecycle,credential)
      VALUES($1,'personal',$2,'Protected file source','https://example.test/mcp','test-source','none','active','{}')`,
        [protectedIntegrationId, alice.membershipId],
      );
      await f.db.platform.query(`UPDATE ${f.table('tf_knowledge_revisions')} SET sources=$2 WHERE id=$1`, [
        revisionId,
        JSON.stringify([{ kind: 'mcp-integration', integrationId: protectedIntegrationId, authorizationEpoch: 1 }]),
      ]);
      const knowledgeSourceId = (
        await f.db.platform.query(`SELECT source_id FROM ${f.table('tf_knowledge_documents')} WHERE id=$1`, [
          documentId,
        ])
      ).rows[0].source_id;

      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_google_integrations')}
      (id,user_id,membership_id,generation,status,account_id,email,credential,scopes)
      VALUES($1,$2,$3,1,'connected','alice-google','alice@example.test','{}',ARRAY['https://www.googleapis.com/auth/gmail.readonly'])`,
        [randomUUID(), alice.userId, alice.membershipId],
      );
      const installation = randomUUID();
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installations')}
      (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after)
      VALUES($1,'A1','T1','U1',1,'active',ARRAY['chat:write'],'{}',0)`,
        [installation],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_slack_installation_grants')}(installation_id,membership_id) VALUES($1,$2)`,
        [installation, alice.membershipId],
      );
      const collect = user =>
        f.runtime.transaction(w.id, commonCompatibility, async tx =>
          collectRecommendationContext(tx, await resolveHuman(tx, user)),
        );

      const first = await collect(alice.userId);
      assert.equal(first.signals.google, true);
      assert.equal(first.signals.gmail, true);
      assert.equal(first.signals.googleCalendar, false);
      assert.equal(first.signals.slack, true);
      assert.ok(first.context.entries.some(entry => entry.key === `project:${projectId}:${promoted.id}`));
      const firstSourceIds = new Set(first.sources.map(source => source.id));
      for (const id of [
        projectId,
        promoted.id,
        fileId,
        documentId,
        knowledgeSourceId,
        knowledgeFileId,
        protectedIntegrationId,
      ]) {
        assert.ok(firstSourceIds.has(id), `guarded provenance retains ${id}`);
      }
      assert.ok(first.sources.length <= 200);
      assert.ok(
        first.sources.every(source => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(source.id)),
        'saved dependency IDs are actual UUIDs, not model-entry keys',
      );
      assert.equal(
        first.context.entries.some(entry =>
          [knowledgeSourceId, knowledgeFileId, protectedIntegrationId].includes(entry.id),
        ),
        false,
        'provenance-only IDs do not become model input entries',
      );
      assert.equal(first.sources.find(source => source.kind === 'file' && source.id === fileId).revision.length, 64);
      assert.equal(
        first.context.entries.some(entry => entry.kind === 'file' && [fileId, automaticFile].includes(entry.id)),
        false,
      );
      assert.doesNotMatch(JSON.stringify(first), /Excluded automatic chat attachment/);
      assert.match(JSON.stringify(first), /Alice prefers concise/);
      assert.match(JSON.stringify(first), /Ask before changing/);
      const admin = await collect(w.userId);
      assert.equal(admin.signals.google, false);
      assert.equal(admin.signals.slack, false, 'workspace admin is not a Slack-use grant');
      assert.equal(
        admin.context.entries.some(entry => ['memory', 'project', 'file'].includes(entry.kind)),
        false,
      );
      assert.doesNotMatch(JSON.stringify(admin), /Alice prefers|Private customer|Launch notes|November 12/);

      await memory.save(w.id, alice.userId, {
        content: 'Alice prefers concise customer checklists.',
        expectedRevision: 1,
      });
      await f.db.platform.query(
        `UPDATE ${f.table('tf_google_integrations')} SET generation=generation+1 WHERE membership_id=$1`,
        [alice.membershipId],
      );
      const unchanged = await collect(alice.userId);
      assert.equal(
        unchanged.fingerprint,
        first.fingerprint,
        'identical memory saves and credential generation changes are not new model input',
      );
      assert.doesNotMatch(JSON.stringify(unchanged), /Excluded automatic chat attachment/);
      assert.equal(unchanged.sources.find(source => source.kind === 'memory').revision, '2');
      await files.share(w.id, alice.userId, fileId, { kind: 'individual', id: bob.membershipId }, null);
      const revoked = await collect(alice.userId);
      assert.equal(
        revoked.context.entries.some(entry => entry.key === `project:${projectId}:${promoted.id}`),
        false,
        'even the file owner cannot use a project copy after another project reader loses its source',
      );
      assert.doesNotMatch(JSON.stringify(revoked), /Private source instruction/);
      assert.notEqual(revoked.fingerprint, first.fingerprint);
      assert.equal(
        revoked.sources.some(source => source.id === fileId || source.id === promoted.id),
        false,
        'revoked project copies retain no stale dependency IDs',
      );
      assert.ok(
        revoked.sources.some(source => source.id === projectId),
        'the readable project itself remains an input',
      );
      await files.share(w.id, bob.userId, knowledgeFileId, { kind: 'individual', id: alice.membershipId }, null);
      const knowledgeRevoked = await collect(alice.userId);
      for (const id of [documentId, knowledgeSourceId, knowledgeFileId, protectedIntegrationId]) {
        assert.equal(
          knowledgeRevoked.sources.some(source => source.id === id),
          false,
          'unreadable Knowledge originals and protected dependencies are absent',
        );
      }
      await memory.delete(w.id, alice.userId, { expectedRevision: 2 });
      assert.equal(
        (await collect(alice.userId)).context.entries.some(entry => entry.kind === 'memory'),
        false,
      );

      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_recommendation_snapshots')}
      (membership_id,fingerprint,items,onboarding,generation,policy,sources)
      VALUES($1,$2,$3,false,1,$4,'[]')
      ON CONFLICT(membership_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,items=EXCLUDED.items,onboarding=false,generation=1,policy=EXCLUDED.policy,sources='[]'`,
        [alice.membershipId, 'a'.repeat(64), JSON.stringify(fallbackRecommendations), recommendationPolicy],
      );
      const eventsBefore = (
        await f.db.platform.query(`SELECT count(*)::text AS count FROM ${f.table('tf_recommendation_events')}`)
      ).rows[0].count;
      await f.runtime.transaction(w.id, commonCompatibility, async tx => {
        const actor = await resolveHuman(tx, alice.userId);
        const queries = [];
        const readTx = {
          ...tx,
          client: {
            query: async (...args) => {
              queries.push(args[0]);
              return tx.client.query(...args);
            },
          },
        };
        for (let i = 0; i < 10; i++)
          assert.equal((await readSavedRecommendations(readTx, actor.membershipId)).items.length, 5);
        assert.equal(queries.length, 10);
        assert.ok(
          queries.every(
            sql => sql.startsWith('SELECT') && !/tf_(?:projects|files|personal_memory|recommendation_events)/.test(sql),
          ),
        );
      });
      assert.equal(
        (await f.db.platform.query(`SELECT count(*)::text AS count FROM ${f.table('tf_recommendation_events')}`))
          .rows[0].count,
        eventsBefore,
      );
    } finally {
      await f.close();
    }
  },
);
