import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createGitHubKnowledge,
  createKnowledgeAgentTools,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createKnowledgeSourceFailures,
  GitHubCorpusError,
} from '../dist/index.js';

const allKinds = ['code', 'discussions', 'docs', 'issues', 'pulls'];
const itemKinds = { doc: 'docs', issue: 'issues' };

// Search has a bounded deadline. Retry only the storage deadline so host load cannot hide an authorization result.
async function bounded(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || error?.code !== 'wait_timeout') throw error;
    }
  }
}

// A GitHub connection whose repositories, per-kind permissions, scope and credential the test changes between passes.
function fakeGitHub() {
  const account = { generation: 1, revoked: false };
  const repos = new Map();
  const add = (id, name) =>
    repos.set(String(id), {
      fullName: name,
      readable: true,
      scoped: true,
      denied: new Set(),
      items: new Map([
        [`doc:${id}:README.md`, `orchid readme of ${name}`],
        [`issue:${id}:1`, `orchid issue of ${name}`],
      ]),
    });
  const credential = b => {
    if (account.revoked || b.accountGeneration !== account.generation)
      throw new GitHubCorpusError('reconnect-required');
  };
  const repository = id => ({
    repositoryId: id,
    fullName: repos.get(id).fullName,
    visibility: 'private',
    title: repos.get(id).fullName,
  });
  const observation = (id, nativeId, kind) => ({
    nativeId,
    repositoryId: id,
    kind,
    title: `${repos.get(id).fullName}: ${nativeId}`,
    canonicalURL: `https://github.com/${repos.get(id).fullName}`,
    sourceRevision: nativeId.endsWith('/denied') ? 'denied' : 'r1',
    accessedAt: new Date().toISOString(),
    coverage: nativeId.endsWith('/denied') ? 'denied' : 'supported',
  });
  const provider = {
    discover: async (_w, _u, _accountId, cursor) => {
      assert.equal(cursor, undefined);
      return {
        binding: { accountId: account.id, accountGeneration: account.generation, githubUserId: '101', login: 'owner' },
        items: [...repos.keys()].map(repository),
        nextCursor: null,
      };
    },
    inspectSelection: async () => assert.fail('not used'),
    access: async (_w, _u, b, id) => {
      credential(b);
      const repo = repos.get(id);
      if (!repo.scoped) throw new GitHubCorpusError('insufficient-scope');
      return { ...repository(id), accessedAt: new Date().toISOString(), readable: repo.readable };
    },
    list: async (_w, _u, b, id) => {
      credential(b);
      const repo = repos.get(id);
      if (!repo.readable) throw new GitHubCorpusError('forbidden');
      const observations = [];
      for (const kind of ['doc', 'issue'])
        if (repo.denied.has(itemKinds[kind])) observations.push(observation(id, `${kind}:${id}:/denied`, kind));
        else
          for (const nativeId of repo.items.keys())
            if (nativeId.startsWith(`${kind}:`)) observations.push(observation(id, nativeId, kind));
      return { observations, nextCursor: null };
    },
    read: async (_w, _u, b, id, nativeId) => {
      credential(b);
      const repo = repos.get(id);
      const text = repo.items.get(nativeId);
      if (!text || repo.denied.has(itemKinds[nativeId.split(':')[0]])) throw new GitHubCorpusError('not-found');
      return {
        ...observation(id, nativeId, nativeId.split(':')[0]),
        markdown: `# ${repo.fullName}: ${nativeId}\n\n${text}\n`,
      };
    },
  };
  return { account, repos, add, provider };
}

test(
  'GitHub Knowledge reports reconnects, missing permissions and lost access, and follows renames by ID',
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
      const fake = fakeGitHub();
      const accountId = randomUUID();
      fake.account.id = accountId;
      await db.platform.query(
        `INSERT INTO ${table('tf_github_accounts')} (id,owner_membership_id,generation,state,config_hash,identity,scopes,credential) VALUES ($1,$2,1,'active','fixture',$3,'{repo,read:user}','{}')`,
        [accountId, ws.membershipId, { id: '101', login: 'owner' }],
      );
      fake.add(7001, 'acme/handbook');
      fake.add(7002, 'acme/roadmap');
      fake.add(7003, 'acme/private-notes');
      fake.repos.get('7003').scoped = false;

      const github = createGitHubKnowledge({ runtime, provider: fake.provider });
      const search = createKnowledgeSearch({
        runtime,
        embeddings: createKnowledgeEmbeddings({ runtime, github, config: { kind: 'disabled' } }),
        github,
      });
      const tools = createKnowledgeAgentTools({ runtime, search });
      const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
      const { sourceId } = await github.configure(ws.id, ws.userId, {
        commandId: randomUUID(),
        accountId,
        selection: { scope: 'all', repositories: [], kinds: allKinds },
        memberIds: [],
      });
      const pass = async () => {
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [sourceId],
        );
        const work = (await github.due(ws.id)).find(w => w.sourceId === sourceId);
        return work ? (await github.process(work)).disposition : null;
      };
      const sync = async () => {
        for (let i = 0; i < 40; i++) if ((await pass()) === 'ready') return;
        assert.fail('bounded sync did not complete');
      };
      const listed = async () => (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
      const statuses = async () =>
        Object.fromEntries(
          (await listed()).repositories.map(r => [r.repositoryId, [r.status, r.fullName, r.missingKinds]]),
        );
      const found = async () =>
        (
          await bounded(() =>
            search.search(ws.id, ws.userId, {
              kind: 'typing',
              query: 'orchid',
              filters: { kinds: ['github'], sourceIds: [sourceId] },
            }),
          )
        ).hits
          .map(hit => hit.title)
          .sort();
      const tombstoned = async () =>
        (
          await db.platform.query(
            `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NOT NULL`,
            [sourceId],
          )
        ).rows[0].n;
      const notice = async () => {
        const { result } = await bounded(() =>
          tools.search(ws.id, actor, { query: 'orchid' }, { commandId: randomUUID() }),
        );
        return { notices: result.notices ?? [], instruction: result.instruction };
      };

      await t.test('a repository the connection sees without the repo scope needs permission', async () => {
        await sync();
        const source = await listed();
        assert.equal(source.connection, 'connected');
        assert.equal(source.accountId, accountId);
        assert.deepEqual(await statuses(), {
          7001: ['active', 'acme/handbook', []],
          7002: ['active', 'acme/roadmap', []],
          7003: ['needs-permission', 'acme/private-notes', allKinds],
        });
        assert.deepEqual(source.repositoryCounts, { active: 2, excluded: 0, needsPermission: 1, accessLost: 0 });
        assert.equal((await github.health(ws.id)).permissionRepositories, 1);
        const stale = await notice();
        assert.deepEqual(stale.notices, ['github-access-needs-attention']);
        assert.match(stale.instruction, /GitHub knowledge may be out of date/);
        assert.match(stale.instruction, /\[Reconnect GitHub\]\(#github-reconnect\)/);
        const only = await bounded(() =>
          tools.search(ws.id, actor, { query: 'orchid', kind: 'note' }, { commandId: randomUUID() }),
        );
        assert.equal(only.result.notices, undefined, 'searches limited to other sources carry no GitHub notice');

        fake.repos.get('7003').scoped = true;
        await sync();
        assert.equal((await statuses())[7003][0], 'active');
        assert.equal((await found()).length, 6);
        assert.deepEqual((await notice()).notices, []);
        assert.equal((await github.health(ws.id)).permissionRepositories, 0);
      });

      await t.test('an unreadable kind is reported, hidden from search and restored when access returns', async () => {
        fake.repos.get('7002').denied.add('issues');
        await sync();
        assert.deepEqual((await statuses())[7002], ['needs-permission', 'acme/roadmap', ['issues']]);
        assert.deepEqual((await listed()).repositoryCounts, {
          active: 2,
          excluded: 0,
          needsPermission: 1,
          accessLost: 0,
        });
        assert.deepEqual((await listed()).counts, { total: 6, ready: 5, failed: 0 }, 'markers are not items');
        const titles = await found();
        assert.equal(titles.length, 5);
        assert.ok(!titles.includes('acme/roadmap: issue:7002:1'));
        assert.ok(titles.includes('acme/roadmap: doc:7002:README.md'), 'readable kinds keep syncing');
        assert.equal(await tombstoned(), 0, 'hidden content is kept for when access returns');
        assert.deepEqual((await notice()).notices, ['github-access-needs-attention']);
        const failures = createKnowledgeSourceFailures({ runtime });
        assert.deepEqual(
          (await failures.list(ws.id, ws.userId, sourceId)).items,
          [],
          'denied markers are not failures',
        );
        await db.platform.query(
          `INSERT INTO ${table('github_items')} (source_id,native_id,repository_id,kind,source_revision,seen_generation,failure)
           VALUES ($1,'doc:7001:assets/huge.md','7001','doc','r1',0,'too-large'),($1,'doc:7001:gone.md','7001','doc','r1',0,'forbidden')`,
          [sourceId],
        );
        assert.deepEqual(
          (await failures.list(ws.id, ws.userId, sourceId)).items.map(
            ({ id, documentId, status, reason, observedAt }) => ({
              id,
              documentId,
              status,
              reason,
              observedAt,
            }),
          ),
          [
            {
              id: 'github:doc:7001:assets/huge.md',
              documentId: null,
              status: 'failed',
              reason: 'too-large',
              observedAt: null,
            },
            { id: 'github:doc:7001:gone.md', documentId: null, status: 'failed', reason: 'provider', observedAt: null },
          ],
        );
        await db.platform.query(
          `DELETE FROM ${table('github_items')} WHERE source_id=$1 AND native_id IN ('doc:7001:assets/huge.md','doc:7001:gone.md')`,
          [sourceId],
        );

        fake.repos.get('7002').denied.clear();
        await sync();
        assert.deepEqual((await statuses())[7002], ['active', 'acme/roadmap', []]);
        assert.equal(
          (await github.health(ws.id)).permissionRepositories,
          0,
          'a marker from an earlier pass no longer applies',
        );
        assert.equal((await found()).length, 6);
        assert.deepEqual((await notice()).notices, []);
      });

      await t.test('a repository that becomes unreadable loses access, stays hidden, then returns', async () => {
        fake.repos.get('7001').readable = false;
        await sync();
        const source = await listed();
        assert.equal(source.syncState, 'ready', 'other repositories keep syncing');
        assert.deepEqual((await statuses())[7001], ['access-lost', 'acme/handbook', []]);
        assert.deepEqual(source.repositoryCounts, { active: 2, excluded: 0, needsPermission: 0, accessLost: 1 });
        assert.equal((await github.health(ws.id)).lostRepositories, 1);
        assert.ok((await found()).every(title => !title.startsWith('acme/handbook')));
        assert.equal(await tombstoned(), 0);
        assert.deepEqual((await notice()).notices, ['github-access-needs-attention']);

        fake.repos.get('7001').readable = true;
        await sync();
        assert.deepEqual((await statuses())[7001], ['active', 'acme/handbook', []]);
        assert.equal((await found()).length, 6);
        assert.equal((await github.health(ws.id)).lostRepositories, 0);
      });

      await t.test('a renamed or transferred repository keeps its ID and its indexed content', async () => {
        const documents = async () =>
          (
            await db.platform.query(
              `SELECT i.native_id,i.document_id FROM ${table('github_items')} i WHERE i.source_id=$1 AND i.repository_id='7001' ORDER BY i.native_id`,
              [sourceId],
            )
          ).rows;
        const before = await documents();
        fake.repos.get('7001').fullName = 'new-owner/handbook';
        await sync();
        assert.deepEqual((await statuses())[7001], ['active', 'new-owner/handbook', []]);
        assert.equal((await listed()).repositories.length, 3, 'a rename is not a new repository');
        assert.deepEqual(await documents(), before, 'documents keep their identity');
        assert.equal(await tombstoned(), 0);
        assert.equal((await found()).length, 6);
      });

      await t.test('a rejected credential asks for a reconnect and syncing resumes after reconnecting', async () => {
        await db.platform.query(
          `UPDATE ${table('tf_github_accounts')} SET state='reconnect-required',generation=2,credential=NULL WHERE id=$1`,
          [accountId],
        );
        fake.account.revoked = true;
        fake.account.generation = 2;
        assert.notEqual(await pass(), 'ready');
        const source = await listed();
        assert.equal(source.connection, 'reconnect-required');
        assert.equal(source.accountId, accountId);
        assert.equal((await github.health(ws.id)).reconnectSources, 1);
        const stale = await notice();
        assert.deepEqual(stale.notices, ['github-access-needs-attention']);
        assert.match(stale.instruction, /#github-reconnect/);

        await db.platform.query(
          `UPDATE ${table('tf_github_accounts')} SET state='active',generation=3,credential='{}' WHERE id=$1`,
          [accountId],
        );
        fake.account.revoked = false;
        fake.account.generation = 3;
        await sync();
        const resumed = await listed();
        assert.equal(resumed.connection, 'connected');
        assert.equal(resumed.syncState, 'ready');
        assert.equal(
          (await db.platform.query(`SELECT binding FROM ${table('github_sources')} WHERE source_id=$1`, [sourceId]))
            .rows[0].binding.accountGeneration,
          3,
          'the source follows the reconnected account',
        );
        assert.equal((await github.health(ws.id)).reconnectSources, 0);
        assert.deepEqual((await notice()).notices, []);
        assert.equal((await found()).length, 6);
      });
    } finally {
      await runtime?.close?.();
      await db.close();
    }
  },
);
