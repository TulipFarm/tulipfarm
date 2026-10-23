import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createGitHubKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  GitHubCorpusError,
  recordDefaultKnowledgeIntent,
} from '../dist/index.js';

const allKinds = ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'];
const earlierKinds = ['code', 'discussions', 'docs', 'issues', 'pulls'];

async function bounded(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || error?.code !== 'wait_timeout') throw error;
    }
  }
}

// One GitHub account; each repository holds a README and a commit history.
function fakeGitHub(binding) {
  const repos = new Map();
  const lists = [];
  const add = id =>
    repos.set(String(id), {
      fullName: `acme/repo-${id}`,
      commits: [`${id}a`.padEnd(40, '0'), `${id}b`.padEnd(40, '0')],
    });
  const repository = id => ({
    repositoryId: id,
    fullName: repos.get(id).fullName,
    visibility: 'private',
    title: repos.get(id).fullName,
  });
  const observation = (id, nativeId) => ({
    nativeId,
    repositoryId: id,
    kind: nativeId.split(':')[0],
    title: `${repos.get(id).fullName}: ${nativeId}`,
    canonicalURL: `https://github.com/${repos.get(id).fullName}`,
    sourceRevision: nativeId.startsWith('commit:') ? `commit:${nativeId.split(':')[2]}` : 'r1',
    accessedAt: new Date().toISOString(),
    coverage: 'supported',
  });
  const provider = {
    discover: async (_w, _u, accountId) => {
      assert.equal(accountId, binding.accountId);
      return { binding, items: [...repos.keys()].map(repository), nextCursor: null };
    },
    inspectSelection: async (_w, _u, _a, selection) => ({
      binding,
      title: `Chosen: ${selection.repositories.join(', ')}`,
      repositories: selection.repositories.map(name =>
        repository([...repos.keys()].find(id => repos.get(id).fullName === name)),
      ),
    }),
    access: async (_w, _u, _b, id) => ({ ...repository(id), accessedAt: new Date().toISOString(), readable: true }),
    list: async (_w, _u, _b, id, selection, _cursor, history) => {
      lists.push({ id, kinds: selection.kinds, commitHead: history?.commitHead ?? null });
      const repo = repos.get(id);
      const observations = selection.kinds.includes('docs') ? [observation(id, `doc:${id}:README.md`)] : [];
      if (!selection.kinds.includes('commits')) return { observations, nextCursor: null };
      const known = repo.commits.indexOf(history?.commitHead);
      for (const sha of repo.commits.slice(known + 1)) observations.push(observation(id, `commit:${id}:${sha}`));
      return { observations, nextCursor: null, commits: { head: repo.commits.at(-1), retained: known >= 0 } };
    },
    read: async (_w, _u, _b, id, nativeId) => {
      if (!repos.has(id)) throw new GitHubCorpusError('not-found');
      return { ...observation(id, nativeId), markdown: `# ${nativeId}\n\norchid content of ${nativeId}\n` };
    },
  };
  return { repos, lists, add, provider };
}

test(
  'GitHub Knowledge gives chosen sources ownership of their repositories and turns commits on for earlier sources',
  { timeout: 600000 },
  async t => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const stream = await workspaceTableMigrations();
      assert.equal(stream.length, commonCompatibility.maximum);
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
      });
      const accountId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
        [accountId, ws.membershipId, { id: '101', login: 'owner' }],
      );
      const binding = { accountId, accountGeneration: 1, githubUserId: '101', login: 'owner' };
      const fake = fakeGitHub(binding);
      for (let id = 1; id <= 4; id++) fake.add(id);
      const github = createGitHubKnowledge({ runtime, provider: fake.provider, sync: { sleep: async () => {} } });
      const search = createKnowledgeSearch({
        runtime,
        embeddings: createKnowledgeEmbeddings({ runtime, github, config: { kind: 'disabled' } }),
        github,
      });
      const configure = selection =>
        github.configure(ws.id, ws.userId, { commandId: randomUUID(), accountId, selection, memberIds: [] });
      const sync = async sourceId => {
        for (let i = 0; i < 40; i++) {
          await db.platform.query(
            `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [sourceId],
          );
          const work = (await github.due(ws.id)).find(w => w.sourceId === sourceId);
          if (!work) return;
          if ((await github.process(work)).disposition === 'ready') return;
        }
        assert.fail('bounded sync did not complete');
      };
      // Published documents per source; search reads exactly these.
      const live = async sourceId =>
        (
          await db.platform.query(
            `SELECT i.native_id FROM ${table('github_items')} i JOIN ${table('documents')} d ON d.id=i.document_id
            WHERE i.source_id=$1 AND d.tombstoned_at IS NULL AND d.lexical_publication_id IS NOT NULL ORDER BY i.native_id`,
            [sourceId],
          )
        ).rows.map(r => r.native_id);
      const found = async () =>
        (
          await bounded(() =>
            search.search(ws.id, ws.userId, { kind: 'typing', query: 'orchid', filters: { kinds: ['github'] } }),
          )
        ).hits
          .map(hit => hit.title)
          .sort();
      const listed = async sourceId => (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
      const settings = (sourceId, excludedRepositories, kinds = allKinds) =>
        github.settings(ws.id, ws.userId, sourceId, {
          commandId: randomUUID(),
          kinds,
          excludePaths: [],
          after: null,
          excludedRepositories,
        });

      let everything, chosen;
      await t.test('a chosen source takes over a repository the all-repositories source indexes', async () => {
        everything = (await configure({ scope: 'all', repositories: [], kinds: ['docs'] })).sourceId;
        await sync(everything);
        assert.deepEqual(await live(everything), [
          'doc:1:README.md',
          'doc:2:README.md',
          'doc:3:README.md',
          'doc:4:README.md',
        ]);

        chosen = (await configure({ repositories: ['acme/repo-2'], kinds: ['docs'] })).sourceId;
        assert.deepEqual(
          await live(everything),
          ['doc:1:README.md', 'doc:3:README.md', 'doc:4:README.md'],
          'the all-repositories source withdraws the repository at once',
        );
        const before = await listed(everything);
        const handed = before.repositories.find(r => r.repositoryId === '2');
        assert.equal(handed.status, 'indexed-elsewhere');
        assert.deepEqual(handed.indexedBy, { sourceId: chosen, title: 'Chosen: acme/repo-2' });
        assert.equal(before.repositoryCounts.indexedElsewhere, 1);
        assert.equal(before.repositoryCounts.active, 3);

        await sync(chosen);
        fake.lists.length = 0;
        await sync(everything);
        assert.deepEqual(await live(chosen), ['doc:2:README.md']);
        assert.deepEqual(await live(everything), ['doc:1:README.md', 'doc:3:README.md', 'doc:4:README.md']);
        assert.ok(!fake.lists.some(l => l.id === '2'), 'the all-repositories source never lists a repository it skips');
        const titles = await found();
        assert.deepEqual(titles, [...new Set(titles)], 'search returns each repository item once');
        assert.ok(titles.includes('acme/repo-2: doc:2:README.md'));
      });

      await t.test('webhook changes for a skipped repository do not wake the all-repositories source', async () => {
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE source_id=ANY($1::uuid[])`,
          [[everything, chosen]],
        );
        const woken = async ids =>
          (await github.due(ws.id, { repositories: ids, all: false })).map(w => w.sourceId).sort();
        assert.deepEqual(await woken(['2']), [chosen]);
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE source_id=ANY($1::uuid[])`,
          [[everything, chosen]],
        );
        assert.deepEqual(await woken(['3']), [everything]);
        fake.add(5);
        fake.add(6);
        const sixth = (await configure({ repositories: ['acme/repo-6'], kinds: ['docs'] })).sourceId;
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE source_id=ANY($1::uuid[])`,
          [[everything, chosen, sixth]],
        );
        assert.deepEqual(await woken(['6']), [sixth], 'a repository another source owns wakes only that source');
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE source_id=$1`,
          [sixth],
        );
        assert.deepEqual(await woken(['5']), [everything], 'a new repository nobody owns does');
      });

      await t.test('excluding or removing the repository in the chosen source hands it back', async () => {
        await sync(everything);
        assert.ok(!(await live(everything)).includes('doc:6:README.md'));
        assert.ok((await live(everything)).includes('doc:5:README.md'));
        await settings(chosen, ['2'], ['docs']);
        assert.deepEqual(await live(chosen), []);
        assert.equal((await listed(everything)).repositories.find(r => r.repositoryId === '2').status, 'active');
        await sync(everything);
        assert.ok((await live(everything)).includes('doc:2:README.md'), 'the next pass indexes it again');

        await settings(chosen, [], ['docs']);
        assert.ok(!(await live(everything)).includes('doc:2:README.md'), 'including it again moves it back');
        await sync(chosen);
        assert.deepEqual(await live(chosen), ['doc:2:README.md']);

        await github.manage(ws.id, ws.userId, chosen, { commandId: randomUUID(), action: 'remove' });
        assert.equal((await listed(everything)).repositories.find(r => r.repositoryId === '2').indexedBy, null);
        await sync(everything);
        assert.ok((await live(everything)).includes('doc:2:README.md'));
        const titles = await found();
        assert.deepEqual(titles, [...new Set(titles)]);
      });

      await t.test(
        'the all-repositories source keeps a repository its other members could not otherwise read',
        async () => {
          const reader = { userId: randomUUID(), membershipId: randomUUID() };
          await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
            reader.membershipId,
            reader.userId,
          ]);
          await db.platform.query(`INSERT INTO ${table('github_members')} (source_id,membership_id) VALUES ($1,$2)`, [
            everything,
            reader.membershipId,
          ]);
          const own = (await configure({ repositories: ['acme/repo-3'], kinds: ['docs'] })).sourceId;
          assert.ok((await live(everything)).includes('doc:3:README.md'));
          assert.equal((await listed(everything)).repositories.find(r => r.repositoryId === '3').status, 'active');
          await github.manage(ws.id, ws.userId, own, { commandId: randomUUID(), action: 'remove' });
          await db.platform.query(`DELETE FROM ${table('github_members')} WHERE source_id=$1 AND membership_id=$2`, [
            everything,
            reader.membershipId,
          ]);
        },
      );

      await t.test('a disconnected account releases the repositories of its chosen sources', async () => {
        const other = randomUUID();
        await db.platform.query(
          `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
          [other, ws.membershipId, { id: '202', login: 'second' }],
        );
        const own = (await configure({ repositories: ['acme/repo-4'], kinds: ['docs'] })).sourceId;
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET binding=binding||jsonb_build_object('accountId',$2::text,'githubUserId','202') WHERE source_id=$1`,
          [own, other],
        );
        assert.equal(
          (await listed(everything)).repositories.find(r => r.repositoryId === '4').status,
          'indexed-elsewhere',
        );
        await db.platform.query(
          `UPDATE ${table('tf_github_accounts')} SET state='disconnected',credential=NULL WHERE id=$1`,
          [other],
        );
        assert.equal((await listed(everything)).repositories.find(r => r.repositoryId === '4').status, 'active');
        await sync(everything);
        assert.ok((await live(everything)).includes('doc:4:README.md'));
      });

      await t.test('migration 0010 turns commits on only for sources that kept every earlier kind', async () => {
        const full = (await configure({ repositories: ['acme/repo-1'], kinds: earlierKinds })).sourceId;
        const partial = (await configure({ repositories: ['acme/repo-5'], kinds: ['docs', 'issues'] })).sourceId;
        await sync(full);
        await sync(partial);
        assert.deepEqual(await live(full), ['doc:1:README.md']);
        await db.platform.query(
          `UPDATE ${table('github_repositories')} SET commit_head='stale' WHERE source_id=ANY($1::uuid[])`,
          [[full, partial]],
        );
        const { intentId } = await runtime.transaction(ws.id, commonCompatibility, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'github',
            membershipId: ws.membershipId,
            accountKey: accountId,
            accountLabel: 'owner',
          }),
        );
        const planned = randomUUID();
        await db.platform.query(
          `INSERT INTO ${table('default_sources')} (source_id,intent_id,ordinal,selection) VALUES ($1,$2,1,$3)`,
          [planned, intentId, { scope: 'all', repositories: [], kinds: earlierKinds }],
        );
        const migration = (
          await readFile(
            new URL('../../workspace-storage/common/0010_github_knowledge_commits_backfill.sql', import.meta.url),
            'utf8',
          )
        ).replaceAll('{{schema}}', ws.names.schema);
        await db.platform.query(migration);
        await db.platform.query(migration);
        const selection = async sourceId => ({
          github: (
            await db.platform.query(`SELECT selection FROM ${table('github_sources')} WHERE source_id=$1`, [sourceId])
          ).rows[0].selection,
          source: (await db.platform.query(`SELECT selection FROM ${table('sources')} WHERE id=$1`, [sourceId])).rows[0]
            .selection,
          heads: (
            await db.platform.query(`SELECT commit_head FROM ${table('github_repositories')} WHERE source_id=$1`, [
              sourceId,
            ])
          ).rows.map(r => r.commit_head),
        });
        const upgraded = await selection(full);
        assert.deepEqual(upgraded.github.kinds, allKinds);
        assert.equal(
          (
            await db.platform.query(
              `SELECT s.selection=g.selection::text AS same FROM ${table('sources')} s JOIN ${table('github_sources')} g ON g.source_id=s.id WHERE s.id=$1`,
              [full],
            )
          ).rows[0].same,
          true,
          'both selection copies stay canonical so search keeps reading the source',
        );
        assert.deepEqual(upgraded.heads, [null], 'commit tracking restarts');
        const kept = await selection(partial);
        assert.deepEqual(kept.github.kinds, ['docs', 'issues'], 'an owner who cleared kinds keeps the choice');
        assert.deepEqual(kept.heads, ['stale']);
        assert.deepEqual(
          (await db.platform.query(`SELECT selection FROM ${table('default_sources')} WHERE source_id=$1`, [planned]))
            .rows[0].selection.kinds,
          allKinds,
        );
        assert.deepEqual((await listed(full)).selection.kinds, allKinds);

        fake.lists.length = 0;
        await sync(full);
        assert.deepEqual(fake.lists.find(l => l.id === '1').commitHead, null, 'the whole history is listed');
        assert.deepEqual(await live(full), [
          `commit:1:${'1a'.padEnd(40, '0')}`,
          `commit:1:${'1b'.padEnd(40, '0')}`,
          'doc:1:README.md',
        ]);
      });
    } finally {
      await runtime?.close?.();
      await db.close();
    }
  },
);
