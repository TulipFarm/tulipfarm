import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createDefaultKnowledge,
  createDefaultKnowledgeGate,
  createGitHubKnowledge,
  GitHubCorpusError,
  recordDefaultKnowledgeIntent,
} from '../dist/index.js';
import { githubPathOptedOut } from '../dist/github-contracts.js';

const day = 86_400_000;
const allKinds = ['code', 'commits', 'discussions', 'docs', 'issues', 'pulls'];

// A GitHub account whose repositories each hold docs and issues; tests add repositories between passes.
function fakeGitHub(binding) {
  const repos = new Map();
  const lists = [];
  const add = (id, { docs = {}, issues = {} } = {}) =>
    repos.set(String(id), {
      fullName: `acme/repo-${id}`,
      docs: new Map(Object.entries(docs)),
      issues: new Map(Object.entries(issues)),
    });
  const visible = (id, nativeId, s) => {
    const repo = repos.get(id);
    const [kind, , rest] = nativeId.split(/:(\d+):/);
    if (kind === 'doc') return s.kinds.includes('docs') && repo.docs.has(rest) && !githubPathOptedOut(s, rest);
    const issue = repo.issues.get(rest);
    return s.kinds.includes('issues') && !!issue && (!s.after || issue.at >= Date.parse(s.after));
  };
  const ids = id => [
    ...[...repos.get(id).docs.keys()].map(path => `doc:${id}:${path}`),
    ...[...repos.get(id).issues.keys()].map(number => `issue:${id}:${number}`),
  ];
  const observation = (id, nativeId) => ({
    nativeId,
    repositoryId: id,
    kind: nativeId.startsWith('doc:') ? 'doc' : 'issue',
    title: `${repos.get(id).fullName}: ${nativeId}`,
    canonicalURL: `https://github.com/${repos.get(id).fullName}`,
    sourceRevision: 'r1',
    accessedAt: new Date().toISOString(),
    coverage: 'supported',
  });
  const repository = id => ({
    repositoryId: id,
    fullName: repos.get(id).fullName,
    visibility: 'private',
    title: repos.get(id).fullName,
  });
  const provider = {
    discover: async (_w, _u, accountId, cursor) => {
      assert.equal(accountId, binding.accountId);
      const all = [...repos.keys()].sort((a, b) => Number(a) - Number(b));
      const at = Number(cursor ?? 0);
      return {
        binding,
        items: all.slice(at, at + 100).map(repository),
        nextCursor: at + 100 < all.length ? String(at + 100) : null,
      };
    },
    inspectSelection: async (_w, _u, _a, selection) => ({
      binding,
      title: 'Selected GitHub',
      repositories: selection.repositories.map(name =>
        repository([...repos.keys()].find(id => repos.get(id).fullName === name)),
      ),
    }),
    access: async (_w, _u, _b, id) => ({ ...repository(id), accessedAt: new Date().toISOString(), readable: true }),
    list: async (_w, _u, _b, id, s) => {
      lists.push({ id, selection: s });
      return {
        observations: ids(id)
          .filter(n => visible(id, n, s))
          .map(n => observation(id, n)),
        nextCursor: null,
      };
    },
    read: async (_w, _u, _b, id, nativeId, s) => {
      if (!ids(id).includes(nativeId)) throw new GitHubCorpusError('not-found');
      if (!visible(id, nativeId, s)) throw new GitHubCorpusError('outside-selection');
      return { ...observation(id, nativeId), markdown: `# ${nativeId}\n\norchid content of ${nativeId}\n` };
    },
  };
  return { repos, lists, add, provider };
}

test(
  'GitHub Knowledge indexes every repository and kind by default and members opt out',
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
      const old = Date.now() - 800 * day;
      for (let id = 1; id <= 25; id++)
        fake.add(id, {
          docs: { 'README.md': 'readme', 'docs/guide.md': 'guide', 'vendor/lib.md': 'vendored' },
          issues: { 1: { at: old } },
        });
      // The feature flag is off for everyone: GitHub must neither be held by the gate nor skipped by defaults.
      const disabled = async () => false;
      const gate = createDefaultKnowledgeGate({ runtime, enabled: disabled });
      const github = createGitHubKnowledge({ runtime, provider: fake.provider, gate });
      let clock = new Date(Date.now() + 1000);
      const defaults = createDefaultKnowledge({ runtime, engines: { github }, enabled: disabled, now: () => clock });
      const record = () =>
        runtime.transaction(ws.id, commonCompatibility, tx =>
          recordDefaultKnowledgeIntent(tx, {
            product: 'github',
            membershipId: ws.membershipId,
            accountKey: accountId,
            accountLabel: 'owner',
          }),
        );
      let sourceId;
      const sync = async () => {
        for (let i = 0; i < 200; i++) {
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
      const live = async () =>
        (
          await db.platform.query(
            `SELECT i.native_id FROM ${table('github_items')} i JOIN ${table('documents')} d ON d.id=i.document_id
            WHERE i.source_id=$1 AND d.tombstoned_at IS NULL ORDER BY i.native_id`,
            [sourceId],
          )
        ).rows.map(r => r.native_id);
      const listed = async () => (await github.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);

      await t.test('connecting creates the source at once and its first pass indexes every repository', async () => {
        // Replays the migration backfill for the account connected while GitHub Knowledge was gated.
        const migration = await readFile(
          new URL('../../workspace-storage/common/0006_github_knowledge_opt_out.sql', import.meta.url),
          'utf8',
        );
        const backfill = migration
          .slice(migration.indexOf('INSERT INTO {{schema}}.tf_knowledge_default_intents'))
          .replaceAll('{{schema}}', ws.names.schema);
        await db.platform.query(backfill);
        const [migrated] = (await db.platform.query(`SELECT id FROM ${table('default_intents')}`)).rows;
        const recorded = await record();
        assert.deepEqual(
          recorded,
          { intentId: migrated.id, created: false },
          'the migration backfill and a later connect agree on one intent per account',
        );
        assert.equal((await defaults.due(ws.id)).length, 1, 'the disabled flag does not hold GitHub');
        for (const work of await defaults.due(ws.id)) await defaults.process(work);
        const [intent] = (await defaults.list(ws.id, ws.userId)).items;
        assert.equal(intent.syncState, 'ready');
        sourceId = intent.sources[0].sourceId;
        assert.deepEqual(await gate(ws.id), [], 'the automatic GitHub source is never held');
        const source = await listed();
        assert.deepEqual(source.selection, { scope: 'all', repositories: [], kinds: allKinds });
        await sync();
        const repositories = (await listed()).repositories;
        assert.equal(repositories.length, 25, 'more than 20 repositories are followed');
        assert.ok(repositories.every(r => r.state === 'active' && !r.excluded));
        assert.equal((await live()).length, 25 * 4);
        assert.ok(
          (await live()).includes('issue:7:1'),
          'issues from 800 days ago are indexed: there is no cutoff and no rolling window',
        );
        assert.ok(fake.lists.every(l => l.selection.after === undefined && l.selection.window === undefined));
      });

      await t.test('an opted-out repository stays out while new repositories are still added', async () => {
        await github.settings(ws.id, ws.userId, sourceId, {
          commandId: randomUUID(),
          kinds: allKinds,
          excludePaths: [],
          after: null,
          excludedRepositories: ['3'],
        });
        assert.ok(
          !(await live()).some(id => id.startsWith('doc:3:') || id.startsWith('issue:3:')),
          'excluded content is withdrawn at once',
        );
        fake.add(26, { docs: { 'README.md': 'new' } });
        clock = new Date(clock.getTime() + 2 * 3600_000);
        for (const work of await defaults.due(ws.id)) await defaults.process(work);
        assert.equal((await defaults.list(ws.id, ws.userId)).items[0].sources.length, 1, 'no second source');
        fake.lists.length = 0;
        await sync();
        await sync();
        const repositories = (await listed()).repositories;
        assert.equal(repositories.length, 26);
        assert.deepEqual(
          repositories.filter(r => r.excluded).map(r => r.repositoryId),
          ['3'],
        );
        assert.ok((await live()).includes('doc:26:README.md'), 'the new repository is indexed on the next pass');
        assert.ok(!(await live()).some(id => id.includes(':3:')));
        assert.ok(!fake.lists.some(l => l.id === '3'), 'an excluded repository is never listed');
      });

      await t.test('opt-out path patterns and kinds withdraw matching content; a cutoff is optional', async () => {
        await github.settings(ws.id, ws.userId, sourceId, {
          commandId: randomUUID(),
          kinds: ['docs', 'issues'],
          excludePaths: ['^vendor/', '^docs/'],
          after: null,
          excludedRepositories: ['3'],
        });
        await sync();
        await sync();
        const ids = await live();
        assert.ok(ids.includes('doc:1:README.md'));
        assert.ok(!ids.some(id => id.endsWith(':vendor/lib.md') || id.endsWith(':docs/guide.md')));
        assert.ok(ids.includes('issue:1:1'));
        assert.deepEqual((await listed()).selection.excludePaths, ['^vendor/', '^docs/']);

        await github.settings(ws.id, ws.userId, sourceId, {
          commandId: randomUUID(),
          kinds: ['docs', 'issues'],
          excludePaths: ['^vendor/', '^docs/'],
          after: new Date(Date.now() - 30 * day).toISOString().slice(0, 10),
          excludedRepositories: ['3'],
        });
        await sync();
        await sync();
        assert.ok(!(await live()).some(id => id.startsWith('issue:')), 'a cutoff date opts out older activity');
        await assert.rejects(
          github.settings(ws.id, ws.userId, sourceId, {
            commandId: randomUUID(),
            kinds: ['docs'],
            excludePaths: ['(a+)+$'],
            after: null,
            excludedRepositories: [],
          }),
          'catastrophic patterns are refused',
        );
      });

      await t.test('an account with up to 1,000 repositories is followed without truncation', async () => {
        for (let id = 27; id <= 1005; id++) fake.add(id);
        // New repositories join at the start of a pass; indexing them all is the sync engine's longer job.
        await db.platform.query(
          `UPDATE ${table('github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [sourceId],
        );
        const work = (await github.due(ws.id)).find(w => w.sourceId === sourceId);
        await github.process(work);
        const repositories = (await listed()).repositories;
        assert.equal(repositories.length, 1000);
        assert.equal(repositories.filter(r => r.excluded).length, 1);
      });
    } finally {
      await runtime?.close?.();
      await db.close();
    }
  },
);
