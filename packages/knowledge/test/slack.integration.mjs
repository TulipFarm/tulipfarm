import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createSlackKnowledge,
  createGoogleKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  SlackCorpusError,
} from '../dist/index.js';
import { createFiles } from '@tulipfarm/files';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';

const ROOT = '1767225600.000100';
// Search has a bounded 1.95 second deadline. Retry only the storage deadline so host load cannot hide an authorization result.
async function bounded(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || error?.code !== 'wait_timeout') throw error;
    }
  }
}
const OTHER = '1767225601.000100';

test(
  'Slack corpus persists through restricted PostgreSQL and enforces reader-own Slack membership',
  { timeout: 300000 },
  async t => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const stream = await workspaceTableMigrations();
      assert.equal(stream.length, commonCompatibility.maximum);
      assert.equal(new Set(stream.map(m => m.name.slice(0, 4))).size, stream.length);
      const ws = await db.create();
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
        input: { kind: 'note', text: 'orchid local survives rollout' },
      });
      for (const work of await local.due(ws.id)) assert.equal((await local.process(work)).disposition, 'ready');

      const users = new Map([[ws.userId, 'UOWNER']]);
      const identities = new Map();
      const installationId = randomUUID();
      const state = {
        conversations: new Map([
          ['CGENERAL', { kind: 'public', title: '#general', members: new Set(['UOWNER', 'UREADER']), archived: false }],
          [
            'GPRIVATE',
            { kind: 'private', title: '#private', members: new Set(['UOWNER', 'UREADER']), archived: false },
          ],
          [
            'DOWNER',
            { kind: 'im', title: 'Direct message with UFRIEND', members: new Set(['UOWNER']), archived: false },
          ],
        ]),
        threads: new Map([
          ['CGENERAL', new Map([[ROOT, { text: 'orchid supplier terms', revision: '1' }]])],
          ['GPRIVATE', new Map([[OTHER, { text: 'orchid private roadmap', revision: '1' }]])],
          ['DOWNER', new Map([[ROOT, { text: 'orchid personal reminder', revision: '1' }]])],
        ]),
        omit: false,
        listError: null,
        accessError: null,
        accessGate: null,
      };
      const checks = [];
      const binding = userId => ({
        installationId,
        installationGeneration: 1,
        identityId: identities.get(userId),
        slackUserId: users.get(userId),
        teamId: 'TTEAM',
      });
      const observation = (conversationId, ts) => ({
        nativeId: `${conversationId}:${ts}`,
        conversationId,
        ts,
        title: `${state.conversations.get(conversationId).title} thread`,
        canonicalURL: `https://app.slack.com/client/TTEAM/${conversationId}/thread/${conversationId}-${ts}`,
        sourceRevision: state.threads.get(conversationId).get(ts).revision,
        accessedAt: new Date().toISOString(),
        coverage: state.threads.get(conversationId).get(ts).coverage ?? 'supported',
      });
      const provider = {
        discover: async (_w, userId) => ({ binding: binding(userId), items: [], nextCursor: null }),
        inspectSelection: async (_w, userId, selection) => ({
          binding: binding(userId),
          title: 'Selected Slack',
          conversations: selection.conversationIds.map(id => ({
            conversationId: id,
            kind: state.conversations.get(id).kind,
            title: state.conversations.get(id).title,
          })),
        }),
        access: async (_w, userId, b, id) => {
          assert.deepEqual(b, binding(userId), 'access always uses the reader own linked identity');
          checks.push({ userId, id });
          const accessedAt = new Date().toISOString();
          if (state.accessGate) await state.accessGate(userId);
          if (state.accessError) {
            const error = state.accessError(userId);
            if (error) throw error;
          }
          const c = state.conversations.get(id);
          if (!c) throw new SlackCorpusError('forbidden');
          return {
            conversationId: id,
            kind: c.kind,
            title: c.title,
            accessedAt,
            member: c.members.has(b.slackUserId),
            archived: c.archived,
          };
        },
        list: async (_w, _u, _b, id) => {
          if (state.listError) throw state.listError;
          return {
            observations: state.omit ? [] : [...state.threads.get(id).keys()].map(ts => observation(id, ts)),
            nextCursor: null,
          };
        },
        read: async (_w, _u, _b, id, ts) => {
          const thread = state.threads.get(id)?.get(ts);
          if (!thread) throw new SlackCorpusError('not-found');
          return {
            ...observation(id, ts),
            markdown: `# Thread\n\n## Message by UOWNER at 2026-01-01T00:00:00.000Z\n\n${thread.text}\n`,
          };
        },
      };
      const slack = createSlackKnowledge({ runtime, provider });
      const disabled = createKnowledgeEmbeddings({ runtime, slack, config: { kind: 'disabled' } });
      const search = createKnowledgeSearch({ runtime, embeddings: disabled, slack });

      const reader = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        reader.membershipId,
        reader.userId,
      ]);
      const admin = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        admin.membershipId,
        admin.userId,
      ]);
      users.set(reader.userId, 'UREADER');
      users.set(admin.userId, 'UADMIN');
      await db.platform.query(
        `INSERT INTO ${table('tf_slack_installations')} (id,app_id,team_id,bot_user_id,generation,state,scopes,bot_credential,accepts_events_after) VALUES ($1,'AAPP','TTEAM','UBOT',1,'active','{chat:write}','{}',0)`,
        [installationId],
      );
      const scopes = [
        'channels:history',
        'channels:read',
        'groups:history',
        'groups:read',
        'im:history',
        'im:read',
        'mpim:history',
        'mpim:read',
      ];
      for (const [userId, membershipId] of [
        [ws.userId, ws.membershipId],
        [reader.userId, reader.membershipId],
        [admin.userId, admin.membershipId],
      ]) {
        const id = randomUUID();
        identities.set(userId, id);
        await db.platform.query(
          `INSERT INTO ${table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,$3,$4,$5,'authorized','{}',$6)`,
          [id, installationId, users.get(userId), userId, membershipId, scopes],
        );
      }
      const input = {
        commandId: randomUUID(),
        selection: {
          kind: 'channels',
          conversationIds: ['CGENERAL', 'GPRIVATE'],
          after: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        },
        memberIds: [reader.membershipId],
      };
      const source = await slack.configure(ws.id, ws.userId, input);
      const sourceId = source.sourceId;
      const live = async () =>
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`,
            [sourceId],
          )
        ).rows[0].n;
      const query = (who, text = 'orchid') =>
        bounded(() =>
          search.search(ws.id, who.userId, {
            kind: 'typing',
            query: text,
            filters: { kinds: ['slack'], sourceIds: [sourceId] },
          }),
        );
      async function sync(id = sourceId) {
        for (let i = 0; i < 12; i++) {
          await db.platform.query(
            `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [id],
          );
          const work = (await slack.due(ws.id)).find(w => w.sourceId === id);
          if (!work) return;
          if ((await slack.process(work)).disposition === 'ready') return;
        }
        assert.fail('bounded sync did not complete');
      }
      const ownerActor = { userId: ws.userId };

      await t.test(
        'configure validates audience, replays idempotently, and publishes thread units with owner proof',
        async () => {
          assert.deepEqual(source.memberIds, [reader.membershipId, ws.membershipId].sort());
          assert.equal((await slack.configure(ws.id, ws.userId, input)).sourceId, sourceId);
          await assert.rejects(
            slack.configure(ws.id, ws.userId, { ...input, memberIds: [] }),
            error => error.code === 'conflict',
          );
          await assert.rejects(
            slack.configure(ws.id, ws.userId, {
              commandId: randomUUID(),
              selection: { kind: 'personal', conversationIds: ['DOWNER'], after: input.selection.after },
              memberIds: [reader.membershipId],
            }),
            AccessDenied,
          );
          await assert.rejects(
            slack.configure(ws.id, ws.userId, {
              ...input,
              commandId: randomUUID(),
              selection: { ...input.selection, after: '2020-01-01' },
            }),
            error => error.code === 'invalid-selection',
          );
          await sync();
          const listed = (await slack.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(listed.syncState, 'ready');
          assert.deepEqual(listed.counts, { total: 2, ready: 2, failed: 0 });
          assert.deepEqual(
            listed.conversations.map(c => [c.conversationId, c.state]),
            [
              ['CGENERAL', 'active'],
              ['GPRIVATE', 'active'],
            ],
          );
          const shared = (await slack.list(ws.id, reader.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(shared.canManage, false);
          assert.equal(shared.selection, null);
          assert.equal(shared.conversations, null);
          assert.equal(shared.title, 'Shared Slack source');
          assert.equal((await query(ownerActor)).hits.length, 2);
          await assert.rejects(
            runtime.transaction(ws.id, commonCompatibility, tx =>
              tx.client.query(`UPDATE ${qualified(tx.schema, 'tf_knowledge_slack_originals')} SET markdown='tampered'`),
            ),
            error => error.code === '42501',
          );
        },
      );

      await t.test(
        'selected readers need their own current Slack membership; admins get no implicit access',
        async () => {
          const denied = await query(reader);
          assert.deepEqual(denied.hits, []);
          assert.equal(denied.coverage, 'partial');
          assert.deepEqual(await slack.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 2,
            unavailable: 0,
            bounded: true,
          });
          assert.ok(checks.filter(c => c.userId === reader.userId).length >= 2);
          const shared = await query(reader);
          assert.equal(shared.hits.length, 2);
          const expiry = (
            await db.platform.query(`SELECT min(expires_at) e FROM ${table('slack_access')} WHERE membership_id=$1`, [
              reader.membershipId,
            ])
          ).rows[0].e;
          assert.ok(Date.parse(shared.validUntil) <= expiry.getTime());
          assert.ok(expiry.getTime() <= Date.now() + 300000);
          const evidence = await slack.evidence(ws.id, reader.userId, shared.hits[0].citation);
          assert.equal(evidence.original.kind, 'slack');
          assert.match(evidence.text, /orchid/);
          assert.match(
            (
              await slack.original(
                ws.id,
                reader.userId,
                shared.hits[0].citation.documentId,
                shared.hits[0].citation.revisionId,
              )
            ).bytes.toString(),
            /orchid/,
          );
          assert.equal((await slack.listDocuments(ws.id, reader.userId, sourceId)).items.length, 2);
          await assert.rejects(
            slack.manage(ws.id, reader.userId, sourceId, { commandId: randomUUID(), action: 'pause' }),
            AccessDenied,
          );
          assert.deepEqual((await query(admin)).hits, []);
          await assert.rejects(slack.refresh(ws.id, admin.userId, sourceId), AccessDenied);
          assert.equal((await slack.list(ws.id, admin.userId)).items.length, 0);
        },
      );

      await t.test(
        'observed denial removes only that reader in that conversation and in-flight checks are fenced',
        async () => {
          state.conversations.get('GPRIVATE').members.delete('UREADER');
          assert.deepEqual(await slack.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 1,
            unavailable: 1,
            bounded: true,
          });
          assert.deepEqual(
            (await query(reader)).hits.map(h => h.title),
            ['#general thread'],
          );
          assert.equal((await query(ownerActor)).hits.length, 2);
          state.conversations.get('GPRIVATE').members.add('UREADER');
          let release, entered;
          const started = new Promise(resolve => {
            entered = resolve;
          });
          const gate = new Promise(resolve => {
            release = resolve;
          });
          state.accessGate = async userId => {
            if (userId === reader.userId) {
              state.accessGate = null;
              entered();
              await gate;
            }
          };
          const inFlight = slack.refresh(ws.id, reader.userId, sourceId);
          await started;
          state.accessError = userId => (userId === reader.userId ? new SlackCorpusError('not-member') : null);
          await slack.refresh(ws.id, reader.userId, sourceId);
          state.accessError = null;
          release();
          const late = await inFlight;
          assert.ok(late.unavailable >= 1, 'the check that started before the denial cannot renew access');
          assert.equal(
            (await query(reader)).hits.length,
            1,
            'only the conversation checked after the denial is readable',
          );
          await slack.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 2);
        },
      );

      await t.test('expiry is bounded and failed checks never renew', async () => {
        await db.platform.query(
          `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1`,
          [reader.membershipId],
        );
        await db.platform.query(
          `UPDATE ${table('slack_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const expired = await query(reader);
        assert.deepEqual(expired.hits, []);
        assert.equal(expired.coverage, 'partial');
        state.accessError = userId => (userId === reader.userId ? new SlackCorpusError('transient') : null);
        assert.deepEqual(await slack.refresh(ws.id, reader.userId, sourceId), {
          refreshed: 0,
          unavailable: 2,
          bounded: true,
        });
        state.accessError = null;
        assert.deepEqual((await query(reader)).hits, []);
        const after = (
          await db.platform.query(`SELECT max(expires_at) e FROM ${table('slack_access')} WHERE membership_id=$1`, [
            reader.membershipId,
          ])
        ).rows[0].e;
        assert.ok(after === null || after.getTime() < Date.now());
        await slack.refresh(ws.id, reader.userId, sourceId);
        assert.equal((await query(reader)).hits.length, 2);
      });

      await t.test(
        'local unlinking, membership removal, selection removal and disconnect revoke immediately',
        async () => {
          const calls = checks.length;
          await db.platform.query(
            `UPDATE ${table('tf_slack_identities')} SET state='revoked',credential=NULL WHERE membership_id=$1`,
            [reader.membershipId],
          );
          assert.deepEqual((await query(reader)).hits, []);
          await assert.rejects(slack.evidence(ws.id, reader.userId, (await query(ownerActor)).hits[0].citation));
          await db.platform.query(
            `UPDATE ${table('tf_slack_identities')} SET state='authorized',credential='{}',authorized_at=clock_timestamp() WHERE membership_id=$1`,
            [reader.membershipId],
          );
          assert.deepEqual(
            (await query(reader)).hits,
            [],
            'relinking requires a fresh check with the new authorization',
          );
          await slack.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 2);
          const afterRelink = checks.length;
          await db.platform.query(
            `INSERT INTO ${table('tf_slack_events')} (id,installation_id,generation,event_id,semantic_key,event_time,payload,disposition) VALUES ($1,$2,1,'Ev1','revoke',0,'{}','lifecycle')`,
            [randomUUID(), installationId],
          );
          await db.platform.query(
            `INSERT INTO ${table('tf_slack_user_revocations')} (installation_id,generation,slack_user_id,event_id) VALUES ($1,1,'UREADER','Ev1')`,
            [installationId],
          );
          assert.deepEqual((await query(reader)).hits, []);
          await db.platform.query(`DELETE FROM ${table('tf_slack_user_revocations')} WHERE slack_user_id='UREADER'`);
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
            reader.membershipId,
          ]);
          await assert.rejects(query(reader));
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            reader.membershipId,
          ]);
          assert.equal((await query(reader)).hits.length, 2);
          await db.platform.query(`DELETE FROM ${table('slack_members')} WHERE source_id=$1 AND membership_id=$2`, [
            sourceId,
            reader.membershipId,
          ]);
          assert.deepEqual((await query(reader)).hits, []);
          await db.platform.query(`INSERT INTO ${table('slack_members')} VALUES ($1,$2)`, [
            sourceId,
            reader.membershipId,
          ]);
          await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET state='revoked' WHERE id=$1`, [
            installationId,
          ]);
          assert.deepEqual((await query(reader)).hits, []);
          assert.deepEqual((await query(ownerActor)).hits, []);
          await db.platform.query(`UPDATE ${table('tf_slack_installations')} SET state='active' WHERE id=$1`, [
            installationId,
          ]);
          assert.equal(checks.length, afterRelink, 'local revocation needs no provider call');
          assert.ok(afterRelink > calls);
        },
      );

      await t.test(
        'partial or failed listings never tombstone; exact reads reconcile edits and deletions',
        async () => {
          state.listError = new SlackCorpusError('rate-limited', 120000);
          await db.platform.query(
            `UPDATE ${table('slack_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [sourceId],
          );
          await slack.process((await slack.due(ws.id)).find(w => w.sourceId === sourceId));
          state.listError = null;
          const failed = (await slack.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(failed.failure, 'rate-limited');
          assert.ok(Date.parse(failed.nextAttemptAt) > Date.now() + 110000);
          assert.equal(await live(), 2);
          state.omit = true;
          await sync();
          state.omit = false;
          assert.equal(await live(), 2);
          state.threads.get('CGENERAL').set(ROOT, { text: 'replacement lilac contract', revision: '2' });
          await sync();
          assert.deepEqual(
            (await query(ownerActor, 'lilac')).hits.map(h => h.title),
            ['#general thread'],
          );
          assert.deepEqual((await query(ownerActor, 'supplier')).hits, []);
          state.threads.get('CGENERAL').delete(ROOT);
          state.omit = true;
          await sync();
          state.omit = false;
          assert.equal(await live(), 1);
          assert.deepEqual((await query(ownerActor, 'lilac')).hits, []);
          state.threads.get('CGENERAL').set(ROOT, { text: 'orchid supplier terms', revision: '3' });
          await sync();
          assert.equal(await live(), 2);
        },
      );

      await t.test(
        'an archived or moved conversation is blocked with an explanation without revoking the source',
        async () => {
          state.conversations.get('GPRIVATE').archived = true;
          await sync();
          const listed = (await slack.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(listed.state, 'active');
          assert.deepEqual(
            listed.conversations.find(c => c.conversationId === 'GPRIVATE'),
            {
              conversationId: 'GPRIVATE',
              kind: 'private',
              title: '#private',
              state: 'unavailable',
              failure: 'archived',
            },
          );
          assert.equal(await live(), 2, 'blocked conversation content is retained, not tombstoned');
          assert.deepEqual(
            (await query(ownerActor)).hits.map(h => h.title),
            ['#general thread'],
          );
          assert.equal((await query(ownerActor)).coverage, 'partial');
          await slack.refresh(ws.id, reader.userId, sourceId);
          assert.deepEqual(
            (await query(reader)).hits.map(h => h.title),
            ['#general thread'],
          );
          state.conversations.get('GPRIVATE').archived = false;
          state.conversations.get('GPRIVATE').members.delete('UOWNER');
          await sync();
          assert.equal(
            (await slack.list(ws.id, ws.userId)).items
              .find(s => s.sourceId === sourceId)
              .conversations.find(c => c.conversationId === 'GPRIVATE').failure,
            'not-member',
          );
          state.conversations.get('GPRIVATE').members.add('UOWNER');
          await sync();
          assert.equal(
            (await slack.list(ws.id, ws.userId)).items
              .find(s => s.sourceId === sourceId)
              .conversations.find(c => c.conversationId === 'GPRIVATE').state,
            'active',
          );
          assert.equal((await query(ownerActor)).hits.length, 2);
        },
      );

      await t.test('hybrid embeddings use the same Slack eligibility', async () => {
        await db.platform.query(
          `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
        );
        const embeddings = createKnowledgeEmbeddings({
          runtime,
          slack,
          config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
          capacity: async () => true,
          provider: async () => ({
            dispatch: 'dispatched',
            requestId: 'slack-test',
            inputTokensUpperBound: 1,
            usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
            result: {
              kind: 'success',
              model: profile.model,
              vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
            },
          }),
        });
        for (let i = 0; i < 20; i++) {
          for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
          if (
            (
              await db.platform.query(
                `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL AND vector_publication_id IS NOT NULL`,
                [sourceId],
              )
            ).rows[0].n === 2
          )
            break;
        }
        const hybrid = createKnowledgeSearch({ runtime, embeddings, slack });
        let owner;
        for (let attempt = 0; attempt < 5; attempt++) {
          owner = await bounded(() =>
            hybrid.search(ws.id, ws.userId, {
              kind: 'submitted',
              commandId: randomUUID(),
              query: 'orchid',
              filters: { kinds: ['slack'], sourceIds: [sourceId] },
            }),
          );
          if (owner.reason !== 'deadline') break;
        }
        assert.equal(owner.mode, 'hybrid', JSON.stringify({ reason: owner.reason, coverage: owner.coverage }));
        assert.equal(owner.hits.length, 2);
        await db.platform.query(
          `UPDATE ${table('slack_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const denied = await bounded(() =>
          hybrid.search(ws.id, reader.userId, {
            kind: 'submitted',
            commandId: randomUUID(),
            query: 'orchid',
            filters: { kinds: ['slack'], sourceIds: [sourceId] },
          }),
        );
        assert.deepEqual(denied.hits, []);
        await hybrid.close();
      });

      await t.test(
        'an oversized thread replacement reports its failure and offers the retained original only as an earlier version',
        async () => {
          const [imported] = (await query(ownerActor, 'supplier')).hits;
          const { documentId, revisionId } = imported.citation;
          state.threads.get('CGENERAL').set(ROOT, {
            text: 'orchid supplier terms with a thousand replies',
            revision: '4',
            coverage: 'thread-too-large',
          });
          await sync();
          const replaced = {
            documentId,
            revisionId,
            title: '#general thread',
            publicationId: null,
            parsing: 'failed',
            embedding: 'pending',
            failure: 'thread-too-large',
            historical: true,
          };
          assert.deepEqual(
            (await slack.listDocuments(ws.id, ws.userId, sourceId)).items.find(item => item.documentId === documentId),
            { ...replaced, canRetry: false },
          );
          assert.deepEqual(await slack.status(ws.id, ws.userId, documentId), replaced);
          assert.match(
            (await slack.original(ws.id, ws.userId, documentId, revisionId)).bytes.toString(),
            /^orchid supplier terms$/m,
          );
          assert.deepEqual((await query(ownerActor, 'supplier')).hits, []);
          await assert.rejects(slack.evidence(ws.id, ws.userId, imported.citation));
          assert.deepEqual(
            (await slack.listDocuments(ws.id, ws.userId, sourceId)).items
              .filter(item => item.documentId !== documentId)
              .map(item => [item.parsing, item.failure, item.historical]),
            [['ready', null, false]],
          );
          state.threads.get('CGENERAL').set(ROOT, { text: 'orchid supplier terms trimmed', revision: '5' });
          await sync();
          const current = await slack.status(ws.id, ws.userId, documentId);
          assert.deepEqual([current.parsing, current.failure, current.historical], ['ready', null, false]);
          assert.equal((await query(ownerActor, 'trimmed')).hits[0].citation.documentId, documentId);
        },
      );

      await t.test('personal conversations are owner-only and the google adapter still composes', async () => {
        const personal = await slack.configure(ws.id, ws.userId, {
          commandId: randomUUID(),
          selection: { kind: 'personal', conversationIds: ['DOWNER'], after: input.selection.after },
          memberIds: [],
        });
        await sync(personal.sourceId);
        const google = createGoogleKnowledge({
          runtime,
          provider: {
            discover: async () => assert.fail(),
            inspectSelection: async () => assert.fail(),
            list: async () => assert.fail(),
            check: async () => assert.fail(),
            read: async () => assert.fail(),
          },
        });
        const combined = createKnowledgeSearch({
          runtime,
          google,
          slack,
          embeddings: createKnowledgeEmbeddings({ runtime, google, slack, config: { kind: 'disabled' } }),
        });
        const mine = await bounded(() =>
          combined.search(ws.id, ws.userId, {
            kind: 'typing',
            query: 'reminder',
            filters: { sourceIds: [personal.sourceId] },
          }),
        );
        assert.equal(mine.hits.length, 1);
        assert.deepEqual(
          (await bounded(() => combined.search(ws.id, reader.userId, { kind: 'typing', query: 'reminder' }))).hits,
          [],
        );
        await assert.rejects(slack.refresh(ws.id, reader.userId, personal.sourceId), AccessDenied);
        await assert.rejects(slack.evidence(ws.id, reader.userId, mine.hits[0].citation));
        assert.equal(
          (await bounded(() => combined.search(ws.id, ws.userId, { kind: 'typing', query: 'orchid local' }))).hits.some(
            h => h.citation.documentId === note.documentId,
          ),
          true,
        );
        await db.platform.query(`INSERT INTO ${table('slack_members')} VALUES ($1,$2)`, [
          personal.sourceId,
          reader.membershipId,
        ]);
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::int n FROM ${table('slack_readers')} WHERE source_id=$1 AND membership_id=$2`,
              [personal.sourceId, reader.membershipId],
            )
          ).rows[0].n,
          0,
          'a forced personal audience row still grants nothing',
        );
        const removal = { commandId: randomUUID(), action: 'remove' };
        await slack.manage(ws.id, ws.userId, personal.sourceId, removal);
        await slack.manage(ws.id, ws.userId, personal.sourceId, removal);
        assert.deepEqual(
          (await bounded(() => combined.search(ws.id, ws.userId, { kind: 'typing', query: 'reminder' }))).hits,
          [],
        );
        await combined.close();
      });
      await search.close();
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
