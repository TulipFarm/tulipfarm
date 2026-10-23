import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createGitHubKnowledge,
  createSlackKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  GitHubCorpusError,
} from '../dist/index.js';
import { createFiles } from '@tulipfarm/files';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';
import { parseKnowledgeDocument, KnowledgeParseError } from '../dist/parser.js';

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

test(
  'GitHub corpus persists through restricted PostgreSQL and enforces reader-own GitHub repository access',
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
        input: { kind: 'note', text: 'orchid local survives rollout' },
      });
      for (const work of await local.due(ws.id)) assert.equal((await local.process(work)).disposition, 'ready');

      const accounts = new Map();
      const state = {
        repos: new Map([
          [
            '7001',
            {
              fullName: 'acme/handbook',
              visibility: 'private',
              readers: new Set(['101', '202']),
              items: new Map([
                [
                  'doc:7001:docs/supplier.md',
                  {
                    kind: 'doc',
                    title: 'acme/handbook: docs/supplier.md',
                    text: 'orchid supplier terms',
                    revision: 'blob:1',
                  },
                ],
                [
                  'issue:7001:4',
                  {
                    kind: 'issue',
                    title: 'acme/handbook#4: orchid shipment',
                    text: 'orchid shipment delayed',
                    revision: 'issue:1',
                  },
                ],
              ]),
            },
          ],
          [
            '7002',
            {
              fullName: 'acme/leadership',
              visibility: 'private',
              readers: new Set(['101', '202']),
              items: new Map([
                [
                  'doc:7002:README.md',
                  {
                    kind: 'doc',
                    title: 'acme/leadership: README.md',
                    text: 'orchid private roadmap',
                    revision: 'blob:9',
                  },
                ],
              ]),
            },
          ],
        ]),
        omit: false,
        listError: null,
        accessError: null,
        accessGate: null,
        beforeRead: null,
      };
      const checks = [],
        reads = [];
      const observation = (repositoryId, nativeId) => {
        const item = state.repos.get(repositoryId).items.get(nativeId);
        return {
          nativeId,
          repositoryId,
          kind: item.kind,
          title: item.title,
          canonicalURL: `https://github.com/${state.repos.get(repositoryId).fullName}`,
          sourceRevision: item.revision,
          accessedAt: new Date().toISOString(),
          coverage: item.coverage ?? 'supported',
        };
      };
      const own = (userId, b) => {
        const account = [...accounts.values()].find(a => a.accountId === b.accountId);
        assert.equal(account?.userId, userId, 'every provider call uses the caller own linked account');
      };
      const provider = {
        discover: async () => assert.fail('not used'),
        inspectSelection: async (_w, userId, accountId, selection) => {
          const account = [...accounts.values()].find(a => a.accountId === accountId);
          return {
            binding: {
              accountId,
              accountGeneration: account.generation,
              githubUserId: account.githubUserId,
              login: account.login,
            },
            title: 'Selected GitHub',
            repositories: selection.repositories.map(name => {
              const [id, repo] = [...state.repos.entries()].find(([, r]) => r.fullName === name);
              return { repositoryId: id, fullName: repo.fullName, visibility: repo.visibility, title: repo.fullName };
            }),
          };
        },
        access: async (_w, userId, b, id) => {
          own(userId, b);
          checks.push({ userId, id, accountId: b.accountId });
          const accessedAt = new Date().toISOString();
          if (state.accessGate) await state.accessGate(userId);
          if (state.accessError) {
            const error = state.accessError(userId, b);
            if (error) throw error;
          }
          const repo = state.repos.get(id);
          return {
            repositoryId: id,
            fullName: repo.fullName,
            visibility: repo.visibility,
            title: repo.fullName,
            accessedAt,
            readable: repo.readers.has(b.githubUserId),
          };
        },
        list: async (_w, userId, b, id) => {
          own(userId, b);
          if (state.listError) throw state.listError;
          return {
            observations: state.omit
              ? []
              : [...state.repos.get(id).items.keys()].map(nativeId => observation(id, nativeId)),
            nextCursor: null,
          };
        },
        read: async (_w, userId, b, id, nativeId) => {
          own(userId, b);
          reads.push({ userId, id, nativeId });
          state.beforeRead?.(id, nativeId);
          const item = state.repos.get(id).items.get(nativeId);
          if (!item) throw new GitHubCorpusError('not-found');
          return {
            ...observation(id, nativeId),
            markdown: `# ${item.title}\n\nGitHub repository at commit abc.\n\n${item.text}\n`,
          };
        },
      };
      const github = createGitHubKnowledge({ runtime, provider });
      const disabled = createKnowledgeEmbeddings({ runtime, github, config: { kind: 'disabled' } });
      const search = createKnowledgeSearch({ runtime, embeddings: disabled, github });

      const member = async role => {
        const who = { userId: randomUUID(), membershipId: randomUUID() };
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,$3)`, [
          who.membershipId,
          who.userId,
          role,
        ]);
        return who;
      };
      const reader = await member('member');
      const admin = await member('admin');
      const outsider = await member('member');
      async function link(userId, membershipId, githubUserId, login, key = userId) {
        const accountId = randomUUID();
        await db.platform.query(
          `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
          [accountId, membershipId, { id: githubUserId, login }],
        );
        accounts.set(key, { accountId, userId, generation: 1, githubUserId, login });
        return accountId;
      }
      const ownerAccount = await link(ws.userId, ws.membershipId, '101', 'owner');
      await link(reader.userId, reader.membershipId, '202', 'reader');
      await link(admin.userId, admin.membershipId, '303', 'admin');
      await link(outsider.userId, outsider.membershipId, '202', 'outsider-same-github');
      state.repos.get('7001').readers.add('303');
      const input = {
        commandId: randomUUID(),
        accountId: ownerAccount,
        selection: {
          repositories: ['acme/handbook', 'acme/leadership'],
          kinds: ['docs', 'issues'],
          after: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        },
        memberIds: [reader.membershipId],
      };
      const source = await github.configure(ws.id, ws.userId, input);
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
            filters: { kinds: ['github'], sourceIds: [sourceId] },
          }),
        );
      async function sync(id = sourceId) {
        for (let i = 0; i < 12; i++) {
          await db.platform.query(
            `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [id],
          );
          const work = (await github.due(ws.id)).find(w => w.sourceId === id);
          if (!work) return;
          const result = await github.process(work);
          if (result.disposition === 'ready') return result;
        }
        assert.fail('bounded sync did not complete');
      }
      const ownerActor = { userId: ws.userId };
      const titles = async who => (await query(who, 'acme')).hits.map(h => h.title).sort();

      await t.test(
        'configure validates audience, replays idempotently, and publishes repository items with owner proof',
        async () => {
          assert.deepEqual(source.memberIds, [reader.membershipId, ws.membershipId].sort());
          assert.equal((await github.configure(ws.id, ws.userId, input)).sourceId, sourceId);
          await assert.rejects(
            github.configure(ws.id, ws.userId, { ...input, memberIds: [] }),
            error => error.code === 'conflict',
          );
          await assert.rejects(
            github.configure(ws.id, ws.userId, {
              ...input,
              commandId: randomUUID(),
              selection: { ...input.selection, after: '2999-01-01' },
            }),
            error => error.code === 'invalid-selection',
          );
          await assert.rejects(
            github.configure(ws.id, reader.userId, { ...input, commandId: randomUUID() }),
            error => error.code === 'stale-integration',
            'another member account cannot be bound',
          );
          await sync();
          const listed = (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(listed.syncState, 'ready');
          assert.deepEqual(listed.counts, { total: 3, ready: 3, failed: 0 });
          assert.deepEqual(
            listed.repositories.map(r => [r.repositoryId, r.fullName, r.state]),
            [
              ['7001', 'acme/handbook', 'active'],
              ['7002', 'acme/leadership', 'active'],
            ],
          );
          const shared = (await github.list(ws.id, reader.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(shared.canManage, false);
          assert.equal(shared.selection, null);
          assert.equal(shared.repositories, null);
          assert.equal(shared.title, 'Shared GitHub source');
          assert.equal((await query(ownerActor)).hits.length, 3);
          await assert.rejects(
            runtime.transaction(ws.id, commonCompatibility, tx =>
              tx.client.query(
                `UPDATE ${qualified(tx.schema, 'tf_knowledge_github_originals')} SET markdown='tampered'`,
              ),
            ),
            error => error.code === '42501',
          );
        },
      );

      await t.test(
        'list/read revision drift cannot publish mismatched content and the next reconciliation recovers',
        async () => {
          const nativeId = 'doc:7001:docs/supplier.md';
          const item = state.repos.get('7001').items.get(nativeId);
          const original = { ...item };
          try {
            item.revision = 'blob:drift-listed';
            state.beforeRead = (repositoryId, id) => {
              if (repositoryId === '7001' && id === nativeId) {
                item.revision = 'blob:drift-fetched';
                item.text = 'drift content must match the observed revision';
                state.beforeRead = null;
              }
            };
            await sync();
            const receipt = (
              await db.platform.query(
                `SELECT i.failure,d.lexical_publication_id FROM ${table('github_items')} i
          JOIN ${table('documents')} d ON d.id=i.document_id WHERE i.source_id=$1 AND i.native_id=$2`,
                [sourceId, nativeId],
              )
            ).rows[0];
            assert.equal(receipt.failure, 'source-changed');
            assert.equal(receipt.lexical_publication_id, null);
            assert.equal(
              (
                await db.platform.query(
                  `SELECT count(*)::int n FROM ${table('revisions')} r
          JOIN ${table('documents')} d ON d.id=r.document_id
          WHERE d.source_id=$1 AND r.source_revision IN ('blob:drift-listed','blob:drift-fetched')`,
                  [sourceId],
                )
              ).rows[0].n,
              0,
            );
            await sync();
            const recovered = (
              await db.platform.query(
                `SELECT i.failure,r.source_revision,d.lexical_publication_id FROM ${table('github_items')} i
          JOIN ${table('documents')} d ON d.id=i.document_id JOIN ${table('revisions')} r ON r.id=d.observed_revision_id
          WHERE i.source_id=$1 AND i.native_id=$2`,
                [sourceId, nativeId],
              )
            ).rows[0];
            assert.equal(recovered.failure, null);
            assert.equal(recovered.source_revision, 'blob:drift-fetched');
            assert.ok(recovered.lexical_publication_id);
          } finally {
            state.beforeRead = null;
            Object.assign(item, original);
            await sync();
          }
        },
      );

      const retainedDocument = async nativeId =>
        (
          await db.platform.query(
            `SELECT d.id,d.tombstoned_at,d.retain_until,
      (d.lexical_publication_id IS NOT NULL) AS published,(d.vector_publication_id IS NOT NULL) AS vector_published,
      i.seen_generation,r.state AS repository_state,r.failure AS repository_failure,
      g.reconciliation,g.sync_state,g.lease_token,g.cursor->>'phase' AS phase,
      (SELECT count(*)::int FROM ${table('access_proofs')} p WHERE p.document_id=d.id) AS proofs
      FROM ${table('github_items')} i JOIN ${table('documents')} d ON d.id=i.document_id
      JOIN ${table('github_repositories')} r ON r.source_id=i.source_id AND r.repository_id=i.repository_id
      JOIN ${table('github_sources')} g ON g.source_id=i.source_id WHERE i.source_id=$1 AND i.native_id=$2`,
            [sourceId, nativeId],
          )
        ).rows[0];
      async function reconcileDocument(nativeId) {
        const before = await retainedDocument(nativeId);
        const calls = reads.filter(read => read.nativeId === nativeId).length;
        assert.equal((await sync()).disposition, 'ready');
        const after = await retainedDocument(nativeId);
        assert.equal(after.reconciliation, before.reconciliation + 1);
        assert.equal(after.sync_state, 'ready');
        assert.equal(after.phase, 'listing');
        assert.equal(after.lease_token, null);
        return { ...after, reads: reads.filter(read => read.nativeId === nativeId).length - calls };
      }
      function unchangedTombstone(before, after) {
        assert.equal(after.id, before.id);
        assert.equal(after.published, false);
        assert.equal(after.vector_published, false);
        assert.equal(after.proofs, 0);
        assert.deepEqual(after.tombstoned_at, before.tombstoned_at);
        assert.deepEqual(after.retain_until, before.retain_until);
      }

      await t.test(
        'missing documents are read once, retain their first tombstone deadline, and are rediscovered by listing',
        async () => {
          const nativeId = 'doc:7001:docs/supplier.md';
          const items = state.repos.get('7001').items;
          const original = items.get(nativeId);
          try {
            const initial = await retainedDocument(nativeId);
            assert.equal(initial.published, true);
            assert.equal(initial.tombstoned_at, null);
            assert.equal(initial.retain_until, null);
            items.delete(nativeId);
            const missing = await reconcileDocument(nativeId);
            assert.equal(missing.reads, 1);
            assert.equal(missing.published, false);
            assert.equal(missing.vector_published, false);
            assert.equal(missing.proofs, 0);
            assert.ok(missing.tombstoned_at instanceof Date);
            assert.ok(Math.abs(missing.retain_until - missing.tombstoned_at - 30 * 86400000) < 1000);
            const repeated = await reconcileDocument(nativeId);
            assert.equal(repeated.reads, 0);
            assert.equal(repeated.seen_generation, missing.seen_generation);
            unchangedTombstone(missing, repeated);
            items.set(nativeId, { ...original, revision: 'blob:restored' });
            const restored = await reconcileDocument(nativeId);
            assert.equal(restored.reads, 1);
            assert.equal(restored.id, initial.id);
            assert.equal(restored.published, true);
            assert.ok(restored.proofs > 0);
            assert.equal(restored.seen_generation, repeated.reconciliation);
            assert.equal(restored.tombstoned_at, null);
            assert.equal(restored.retain_until, null);
          } finally {
            items.set(nativeId, original);
            await sync();
          }
        },
      );

      await t.test(
        'a repeated listed-not-found result is idempotent and revoked repository access cannot restore publication',
        async () => {
          const nativeId = 'doc:7001:docs/supplier.md';
          const repository = state.repos.get('7001');
          const original = repository.items.get(nativeId);
          try {
            repository.items.delete(nativeId);
            const missing = await reconcileDocument(nativeId);
            assert.equal(missing.reads, 1);
            repository.items.set(nativeId, original);
            state.beforeRead = (_repositoryId, id) => {
              if (id === nativeId) throw new GitHubCorpusError('not-found');
            };
            const listedButMissing = await reconcileDocument(nativeId);
            assert.equal(
              listedButMissing.reads,
              1,
              'listing still triggers a read rather than trusting the listed item',
            );
            unchangedTombstone(missing, listedButMissing);
            state.beforeRead = null;
            repository.readers.delete('101');
            const denied = await reconcileDocument(nativeId);
            assert.equal(
              denied.reads,
              0,
              'provider content is not read after the owner repository check denies access',
            );
            assert.equal(denied.repository_state, 'unavailable');
            assert.equal(denied.repository_failure, 'forbidden');
            unchangedTombstone(missing, denied);
            repository.readers.add('101');
            const restored = await reconcileDocument(nativeId);
            assert.equal(restored.reads, 1);
            assert.equal(restored.repository_state, 'active');
            assert.equal(restored.repository_failure, null);
            assert.equal(restored.published, true);
            assert.ok(restored.proofs > 0);
            assert.equal(restored.tombstoned_at, null);
            assert.equal(restored.retain_until, null);
          } finally {
            state.beforeRead = null;
            repository.readers.add('101');
            repository.items.set(nativeId, original);
            await sync();
          }
        },
      );

      await t.test(
        'long imports renew the owner proof before publication without extending stale evidence',
        async () => {
          const temporary = await github.configure(ws.id, ws.userId, {
            ...input,
            commandId: randomUUID(),
            selection: { ...input.selection, repositories: ['acme/handbook'] },
          });
          let expired = false;
          const importer = createGitHubKnowledge({
            runtime,
            provider,
            parseDocument: async value => {
              const parsed = await parseKnowledgeDocument(value);
              if (!expired) {
                expired = true;
                await db.platform.query(
                  `UPDATE ${table('github_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE source_id=$1`,
                  [temporary.sourceId],
                );
                await db.platform.query(
                  `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE document_id IN (SELECT id FROM ${table('documents')} WHERE source_id=$1)`,
                  [temporary.sourceId],
                );
              }
              return parsed;
            },
          });
          try {
            const before = checks.length;
            const work = (await importer.due(ws.id)).find(w => w.sourceId === temporary.sourceId);
            await importer.process(work);
            const retained = (await importer.list(ws.id, ws.userId)).items.find(s => s.sourceId === temporary.sourceId);
            assert.deepEqual(retained.counts, { total: 2, ready: 2, failed: 0 });
            assert.ok(
              checks.length - before >= 3,
              'initial renewal, page check and a fresh provider check after parsing',
            );
            const proof = (
              await db.platform.query(
                `SELECT expires_at-observed_at AS lifetime FROM ${table('github_access')} WHERE source_id=$1`,
                [temporary.sourceId],
              )
            ).rows[0];
            assert.equal(proof.lifetime.minutes, 5);
          } finally {
            await github.manage(ws.id, ws.userId, temporary.sourceId, { commandId: randomUUID(), action: 'remove' });
          }
        },
      );

      await t.test('renewal respects a revoked repository and does not publish parsed content', async () => {
        const temporary = await github.configure(ws.id, ws.userId, {
          ...input,
          commandId: randomUUID(),
          selection: { ...input.selection, repositories: ['acme/handbook'] },
        });
        const importer = createGitHubKnowledge({
          runtime,
          provider,
          parseDocument: async value => {
            const parsed = await parseKnowledgeDocument(value);
            await db.platform.query(
              `UPDATE ${table('github_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE source_id=$1`,
              [temporary.sourceId],
            );
            state.repos.get('7001').readers.delete('101');
            return parsed;
          },
        });
        try {
          await importer.process((await importer.due(ws.id)).find(w => w.sourceId === temporary.sourceId));
          const retained = (await importer.list(ws.id, ws.userId)).items.find(s => s.sourceId === temporary.sourceId);
          assert.equal(retained.counts.ready, 0);
          assert.equal(retained.repositories[0].failure, 'forbidden');
          assert.equal((await importer.health(ws.id)).failedSources, 1);
        } finally {
          state.repos.get('7001').readers.add('101');
          await github.manage(ws.id, ws.userId, temporary.sourceId, { commandId: randomUUID(), action: 'remove' });
        }
      });

      await t.test(
        'automatic retries are bounded and explicit retry reprocesses unchanged failed revisions',
        async () => {
          const temporary = await github.configure(ws.id, ws.userId, {
            ...input,
            commandId: randomUUID(),
            selection: { ...input.selection, repositories: ['acme/handbook'] },
          });
          let parses = 0;
          const importer = createGitHubKnowledge({
            runtime,
            provider,
            parseDocument: async () => {
              parses++;
              throw new KnowledgeParseError('resource-limited', { reason: 'timeout' });
            },
          });
          const run = async () => {
            await db.platform.query(
              `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
              [temporary.sourceId],
            );
            const work = (await importer.due(ws.id)).find(w => w.sourceId === temporary.sourceId);
            return importer.process(work);
          };
          try {
            for (let i = 0; i < 10; i++) await run();
            assert.equal(parses, 6, 'each of two revisions is attempted at most three times');
            assert.equal((await importer.health(ws.id)).failedItems, 2);
            await db.platform.query(
              `UPDATE ${table('work')} w SET failure='resource-limited' FROM ${table('documents')} d WHERE d.source_id=$1 AND w.revision_id=d.observed_revision_id`,
              [temporary.sourceId],
            );
            const retry = { commandId: randomUUID(), action: 'retry' };
            await github.manage(ws.id, ws.userId, temporary.sourceId, retry);
            await sync(temporary.sourceId);
            const ready = (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === temporary.sourceId);
            assert.deepEqual(ready.counts, { total: 2, ready: 2, failed: 0 });
            await github.manage(ws.id, ws.userId, temporary.sourceId, retry);
            assert.equal(
              (
                await db.platform.query(
                  `SELECT sum(w.attempts)::int n FROM ${table('work')} w JOIN ${table('documents')} d ON d.observed_revision_id=w.revision_id WHERE d.source_id=$1`,
                  [temporary.sourceId],
                )
              ).rows[0].n,
              2,
              'replayed retry does not reset attempts',
            );
            assert.equal((await github.health(ws.id)).failedItems, 0);
            for (const syncState of ['syncing', 'queued', 'ready']) {
              await db.platform.query(
                `UPDATE ${table('github_sources')} SET sync_state=$2,next_attempt_at=now()-interval '16 minutes' WHERE source_id=$1`,
                [temporary.sourceId, syncState],
              );
              assert.equal(
                (await github.health(ws.id)).stalledSources,
                1,
                'overdue recurring work stays visible even before a worker claims it',
              );
            }
          } finally {
            await github.manage(ws.id, ws.userId, temporary.sourceId, { commandId: randomUUID(), action: 'remove' });
          }
        },
      );

      await t.test(
        'selected readers need their own current GitHub access; admins and unselected members get nothing',
        async () => {
          const denied = await query(reader);
          assert.deepEqual(denied.hits, []);
          assert.equal(denied.coverage, 'partial');
          assert.deepEqual(await github.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 2,
            unavailable: 0,
            bounded: true,
          });
          assert.ok(checks.filter(c => c.userId === reader.userId).length >= 2);
          const shared = await query(reader);
          assert.equal(shared.hits.length, 3);
          const expiry = (
            await db.platform.query(`SELECT min(expires_at) e FROM ${table('github_access')} WHERE membership_id=$1`, [
              reader.membershipId,
            ])
          ).rows[0].e;
          assert.ok(Date.parse(shared.validUntil) <= expiry.getTime());
          assert.ok(expiry.getTime() <= Date.now() + 300000);
          const evidence = await github.evidence(ws.id, reader.userId, shared.hits[0].citation);
          assert.equal(evidence.original.kind, 'github');
          assert.match(evidence.text, /orchid/);
          assert.match(
            (
              await github.original(
                ws.id,
                reader.userId,
                shared.hits[0].citation.documentId,
                shared.hits[0].citation.revisionId,
              )
            ).bytes.toString(),
            /orchid/,
          );
          assert.equal((await github.listDocuments(ws.id, reader.userId, sourceId)).items.length, 3);
          await assert.rejects(
            github.manage(ws.id, reader.userId, sourceId, { commandId: randomUUID(), action: 'pause' }),
            AccessDenied,
          );
          assert.deepEqual((await query(admin)).hits, [], 'admins have no implicit access even with GitHub access');
          await assert.rejects(github.refresh(ws.id, admin.userId, sourceId), AccessDenied);
          assert.equal((await github.list(ws.id, admin.userId)).items.length, 0);
          assert.deepEqual(
            (await query(outsider)).hits,
            [],
            'a private repository is never workspace-public, even for a member with the same GitHub access',
          );
          await assert.rejects(github.refresh(ws.id, outsider.userId, sourceId), AccessDenied);
          await assert.rejects(github.evidence(ws.id, admin.userId, shared.hits[0].citation));
        },
      );

      await t.test(
        'observed denial removes only that reader in that repository and in-flight checks are fenced',
        async () => {
          state.repos.get('7002').readers.delete('202');
          assert.deepEqual(await github.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 1,
            unavailable: 1,
            bounded: true,
          });
          assert.equal(
            (await query(reader)).hits.every(h => h.title.startsWith('acme/handbook')),
            true,
          );
          assert.equal((await query(reader)).hits.length, 2);
          assert.equal((await query(ownerActor)).hits.length, 3);
          state.repos.get('7002').readers.add('202');
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
          const inFlight = github.refresh(ws.id, reader.userId, sourceId);
          await started;
          state.accessError = userId => (userId === reader.userId ? new GitHubCorpusError('unauthenticated') : null);
          await github.refresh(ws.id, reader.userId, sourceId);
          state.accessError = null;
          release();
          const late = await inFlight;
          assert.ok(late.unavailable >= 1, 'the check that started before the denial cannot renew access');
          assert.ok((await query(reader)).hits.length < 3, 'only repositories checked after the denial are readable');
          await github.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 3);
        },
      );

      await t.test('expiry is bounded and failed checks never renew', async () => {
        await db.platform.query(
          `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1`,
          [reader.membershipId],
        );
        await db.platform.query(
          `UPDATE ${table('github_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const expired = await query(reader);
        assert.deepEqual(expired.hits, []);
        assert.equal(expired.coverage, 'partial');
        for (const code of ['transient', 'rate-limited']) {
          state.accessError = userId => (userId === reader.userId ? new GitHubCorpusError(code) : null);
          const result = await github.refresh(ws.id, reader.userId, sourceId);
          assert.equal(result.refreshed, 0);
          assert.deepEqual((await query(reader)).hits, []);
        }
        state.accessError = null;
        const after = (
          await db.platform.query(`SELECT max(expires_at) e FROM ${table('github_access')} WHERE membership_id=$1`, [
            reader.membershipId,
          ])
        ).rows[0].e;
        assert.ok(after === null || after.getTime() < Date.now());
        await github.refresh(ws.id, reader.userId, sourceId);
        assert.equal((await query(reader)).hits.length, 3);
      });

      await t.test(
        'a reader with several accounts is proved by whichever own account can read the repository',
        async () => {
          state.repos.get('7001').readers.delete('202');
          assert.deepEqual(await github.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 1,
            unavailable: 1,
            bounded: true,
          });
          await link(reader.userId, reader.membershipId, '204', 'reader-work', 'reader-work');
          state.repos.get('7001').readers.add('204');
          assert.deepEqual(await github.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 2,
            unavailable: 0,
            bounded: true,
          });
          assert.equal((await query(reader)).hits.length, 3);
          const work = accounts.get('reader-work').accountId;
          assert.ok(checks.some(c => c.userId === reader.userId && c.accountId === work));
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET state='disconnected',generation=generation+1,credential=NULL WHERE id=$1`,
            [work],
          );
          accounts.delete('reader-work');
          assert.equal(
            (await query(reader)).hits.length,
            1,
            'disconnecting the proving account hides its repository immediately',
          );
          state.repos.get('7001').readers.add('202');
          await github.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 3);
        },
      );

      await t.test(
        'local disconnect, reconnect, membership removal, audience removal and owner disconnect revoke immediately',
        async () => {
          const calls = checks.length;
          const readerAccount = accounts.get(reader.userId).accountId;
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET state='disconnected',generation=generation+1,credential=NULL WHERE id=$1`,
            [readerAccount],
          );
          assert.deepEqual((await query(reader)).hits, []);
          await assert.rejects(github.evidence(ws.id, reader.userId, (await query(ownerActor)).hits[0].citation));
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET state='active',credential='{}' WHERE id=$1`,
            [readerAccount],
          );
          accounts.get(reader.userId).generation = 2;
          assert.deepEqual(
            (await query(reader)).hits,
            [],
            'reconnecting needs a fresh check with the new account generation',
          );
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET expires_at=now()-interval '1 second' WHERE id=$1`,
            [readerAccount],
          );
          await assert.rejects(
            github.refresh(ws.id, reader.userId, sourceId),
            AccessDenied,
            'an expired token cannot prove access',
          );
          await db.platform.query(`UPDATE ${table('tf_github_accounts')} SET expires_at=NULL WHERE id=$1`, [
            readerAccount,
          ]);
          await github.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 3);
          const afterRelink = checks.length;
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
            reader.membershipId,
          ]);
          await assert.rejects(query(reader));
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            reader.membershipId,
          ]);
          assert.equal((await query(reader)).hits.length, 3);
          await db.platform.query(`DELETE FROM ${table('github_members')} WHERE source_id=$1 AND membership_id=$2`, [
            sourceId,
            reader.membershipId,
          ]);
          assert.deepEqual((await query(reader)).hits, []);
          await db.platform.query(`INSERT INTO ${table('github_members')} VALUES ($1,$2)`, [
            sourceId,
            reader.membershipId,
          ]);
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET state='disconnected',credential=NULL WHERE id=$1`,
            [ownerAccount],
          );
          assert.deepEqual((await query(reader)).hits, []);
          assert.deepEqual((await query(ownerActor)).hits, []);
          await db.platform.query(
            `UPDATE ${table('tf_github_accounts')} SET state='active',credential='{}' WHERE id=$1`,
            [ownerAccount],
          );
          assert.equal(checks.length, afterRelink, 'local revocation needs no provider call');
          assert.ok(afterRelink > calls);
          assert.equal((await query(reader)).hits.length, 3);
        },
      );

      await t.test('partial or failed listings never tombstone; renames and deletions reconcile', async () => {
        state.listError = new GitHubCorpusError('rate-limited', 120000);
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [sourceId],
        );
        await github.process((await github.due(ws.id)).find(w => w.sourceId === sourceId));
        state.listError = null;
        const failed = (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(failed.failure, 'rate-limited');
        assert.ok(Date.parse(failed.nextAttemptAt) > Date.now() + 110000);
        assert.equal(await live(), 3);
        state.omit = true;
        await sync();
        state.omit = false;
        assert.equal(await live(), 3, 'an empty listing alone never deletes');
        const items = state.repos.get('7001').items;
        items.set('doc:7001:docs/vendors.md', {
          ...items.get('doc:7001:docs/supplier.md'),
          title: 'acme/handbook: docs/vendors.md',
          text: 'lilac vendor terms',
          revision: 'blob:2',
        });
        items.delete('doc:7001:docs/supplier.md');
        await sync();
        assert.deepEqual(
          (await query(ownerActor, 'lilac')).hits.map(h => h.title),
          ['acme/handbook: docs/vendors.md'],
        );
        assert.deepEqual(
          (await query(ownerActor, 'supplier')).hits,
          [],
          'the old path is tombstoned after an exact not-found read',
        );
        items.get('issue:7001:4').text = 'issue edited magnolia';
        items.get('issue:7001:4').revision = 'issue:2';
        await sync();
        assert.equal((await query(ownerActor, 'magnolia')).hits.length, 1);
        items.delete('issue:7001:4');
        await sync();
        assert.deepEqual((await query(ownerActor, 'magnolia')).hits, []);
        assert.equal(await live(), 2);
      });

      await t.test(
        'one inaccessible repository is blocked with a reason without revoking or failing the source',
        async () => {
          state.repos.get('7002').readers.delete('101');
          await sync();
          const listed = (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(listed.state, 'active');
          assert.equal(listed.syncState, 'ready');
          assert.deepEqual(
            listed.repositories.find(r => r.repositoryId === '7002'),
            {
              repositoryId: '7002',
              fullName: 'acme/leadership',
              visibility: 'private',
              title: 'acme/leadership',
              state: 'unavailable',
              failure: 'forbidden',
              excluded: false,
            },
          );
          assert.equal(await live(), 2, 'blocked repository content is retained, not tombstoned');
          assert.deepEqual(await titles(ownerActor), ['acme/handbook: docs/vendors.md']);
          assert.equal((await query(ownerActor)).coverage, 'partial');
          await github.refresh(ws.id, reader.userId, sourceId);
          assert.deepEqual(await titles(reader), ['acme/handbook: docs/vendors.md']);
          state.repos.get('7002').readers.add('101');
          state.repos.get('7002').fullName = 'acme/board';
          await sync();
          await github.manage(ws.id, ws.userId, sourceId, { commandId: randomUUID(), action: 'retry' });
          await sync();
          const retried = (await github.list(ws.id, ws.userId)).items
            .find(s => s.sourceId === sourceId)
            .repositories.find(r => r.repositoryId === '7002');
          assert.deepEqual(
            [retried.state, retried.fullName],
            ['active', 'acme/board'],
            'a renamed repository is tracked by its stable ID',
          );
          assert.equal((await query(ownerActor, 'acme')).hits.length, 2);
        },
      );

      await t.test('hybrid embeddings use the same GitHub eligibility', async () => {
        await db.platform.query(
          `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
        );
        const embeddings = createKnowledgeEmbeddings({
          runtime,
          github,
          config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
          capacity: async () => true,
          provider: async () => ({
            dispatch: 'dispatched',
            requestId: 'github-test',
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
        const hybrid = createKnowledgeSearch({ runtime, embeddings, github });
        let owner;
        for (let attempt = 0; attempt < 5; attempt++) {
          owner = await bounded(() =>
            hybrid.search(ws.id, ws.userId, {
              kind: 'submitted',
              commandId: randomUUID(),
              query: 'orchid',
              filters: { kinds: ['github'], sourceIds: [sourceId] },
            }),
          );
          if (owner.reason !== 'deadline') break;
        }
        assert.equal(owner.mode, 'hybrid', JSON.stringify({ reason: owner.reason, coverage: owner.coverage }));
        assert.equal(owner.hits.length, 2);
        await db.platform.query(
          `UPDATE ${table('github_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const denied = await bounded(() =>
          hybrid.search(ws.id, reader.userId, {
            kind: 'submitted',
            commandId: randomUUID(),
            query: 'orchid',
            filters: { kinds: ['github'], sourceIds: [sourceId] },
          }),
        );
        assert.deepEqual(denied.hits, []);
        await hybrid.close();
      });

      await t.test(
        'an oversized replacement reports its failure and offers the retained original only as an earlier version',
        async () => {
          const items = state.repos.get('7001').items;
          const vendors = items.get('doc:7001:docs/vendors.md');
          const [imported] = (await query(ownerActor, 'lilac')).hits;
          const { documentId, revisionId } = imported.citation;
          items.set('doc:7001:docs/vendors.md', {
            ...vendors,
            text: 'lilac vendor terms with a large appendix',
            revision: 'blob:3',
            coverage: 'too-large',
          });
          await sync();
          const replaced = {
            documentId,
            revisionId,
            title: 'acme/handbook: docs/vendors.md',
            publicationId: null,
            parsing: 'failed',
            embedding: 'pending',
            failure: 'too-large',
            historical: true,
          };
          assert.deepEqual(
            (await github.listDocuments(ws.id, ws.userId, sourceId)).items.find(item => item.documentId === documentId),
            { ...replaced, canRetry: false },
          );
          assert.deepEqual(await github.status(ws.id, ws.userId, documentId), replaced);
          assert.match(
            (await github.original(ws.id, ws.userId, documentId, revisionId)).bytes.toString(),
            /^lilac vendor terms$/m,
          );
          assert.deepEqual((await query(ownerActor, 'lilac')).hits, []);
          await assert.rejects(github.evidence(ws.id, ws.userId, imported.citation));
          assert.deepEqual(
            (await github.listDocuments(ws.id, ws.userId, sourceId)).items
              .filter(item => item.documentId !== documentId)
              .map(item => [item.parsing, item.failure, item.historical]),
            [['ready', null, false]],
          );
          items.set('doc:7001:docs/vendors.md', { ...vendors, text: 'lilac vendor terms renewed', revision: 'blob:4' });
          await sync();
          const current = await github.status(ws.id, ws.userId, documentId);
          assert.deepEqual([current.parsing, current.failure, current.historical], ['ready', null, false]);
          assert.equal((await query(ownerActor, 'renewed')).hits[0].citation.documentId, documentId);
        },
      );

      await t.test('removal is idempotent and other adapters still compose', async () => {
        const slack = createSlackKnowledge({
          runtime,
          provider: {
            discover: async () => assert.fail(),
            inspectSelection: async () => assert.fail(),
            access: async () => assert.fail(),
            list: async () => assert.fail(),
            read: async () => assert.fail(),
          },
        });
        const combined = createKnowledgeSearch({
          runtime,
          slack,
          github,
          embeddings: createKnowledgeEmbeddings({ runtime, slack, github, config: { kind: 'disabled' } }),
        });
        assert.equal(
          (await bounded(() => combined.search(ws.id, ws.userId, { kind: 'typing', query: 'orchid local' }))).hits.some(
            h => h.citation.documentId === note.documentId,
          ),
          true,
        );
        const removal = { commandId: randomUUID(), action: 'remove' };
        await github.manage(ws.id, ws.userId, sourceId, removal);
        await github.manage(ws.id, ws.userId, sourceId, removal);
        assert.deepEqual(
          (
            await bounded(() =>
              combined.search(ws.id, ws.userId, { kind: 'typing', query: 'lilac', filters: { kinds: ['github'] } }),
            )
          ).hits,
          [],
        );
        await assert.rejects(
          github.manage(ws.id, ws.userId, sourceId, { commandId: randomUUID(), action: 'resume' }),
          error => error.code === 'conflict',
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
