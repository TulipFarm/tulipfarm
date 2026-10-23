import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerGitHubKnowledge } from '../../worker/dist/knowledge-github-composition.js';
import { createGitHubKnowledgeActivities } from '../../worker/dist/knowledge-github-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { githubProviderFixture } from './knowledge-github-provider-fixture.mjs';

// The real GitHub corpus provider and the Knowledge engine index every default-branch commit once, list only newer
// commits on later passes, and relist the whole history after a force push.
test('GitHub commit indexing publishes the default-branch history across pushes', { timeout: 600000 }, async t => {
  const gh = githubProviderFixture();
  let f;
  try {
    f = await knowledgeFixture({ githubCorpus: runtime => gh.provider(runtime) });
    const owner = await gh.connect(f, f.signed.owner, 101, 'owner');
    const worker = createWorkerGitHubKnowledge({ runtime: f.runtime, githubCorpus: gh.provider(f.runtime) });
    const activity = createGitHubKnowledgeActivities(worker);
    const repo = gh.github.addRepo({ id: 7020, fullName: 'acme/history', readers: [101] });
    for (let index = 0; index < 3; index++)
      gh.github.push(repo, {
        message: `Add marigold step ${index}\n\nExplains the marigold rollout.`,
        files: [{ filename: `src/petunia/step-${index}.ts`, status: 'added', additions: 4 }],
      });
    const sourceId = randomUUID();
    const configured = await f.call('/github/sources', {
      method: 'POST',
      body: {
        commandId: sourceId,
        accountId: owner.accountId,
        selection: { repositories: ['acme/history'], kinds: ['commits'], after: gh.after },
        memberIds: [],
      },
    });
    assert.equal(configured.status, 200, configured.bytes.toString());
    async function reconcile() {
      await f.db.platform.query(
        `UPDATE ${f.table('tf_knowledge_github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
        [sourceId],
      );
      const start = (
        await f.db.platform.query(
          `SELECT reconciliation FROM ${f.table('tf_knowledge_github_sources')} WHERE source_id=$1`,
          [sourceId],
        )
      ).rows[0].reconciliation;
      for (let index = 0; index < 200; index++) {
        const state = (
          await f.db.platform.query(
            `SELECT reconciliation,sync_state FROM ${f.table('tf_knowledge_github_sources')} WHERE source_id=$1`,
            [sourceId],
          )
        ).rows[0];
        if (state.reconciliation > start) return state.sync_state;
        const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === sourceId);
        assert.ok(work, 'the source stays due until its reconciliation completes');
        assert.equal(await activity.processGitHubKnowledge(work), undefined);
      }
      assert.fail('bounded fixture did not complete');
    }
    async function items() {
      return (
        await f.db.platform.query(
          `SELECT i.native_id AS "nativeId", i.failure, (d.lexical_publication_id IS NOT NULL AND d.tombstoned_at IS NULL) AS searchable
          FROM ${f.table('tf_knowledge_github_items')} i LEFT JOIN ${f.table('tf_knowledge_documents')} d ON d.id=i.document_id
          WHERE i.source_id=$1 ORDER BY i.native_id`,
          [sourceId],
        )
      ).rows;
    }
    async function head() {
      return (
        await f.db.platform.query(
          `SELECT commit_head FROM ${f.table('tf_knowledge_github_repositories')} WHERE source_id=$1`,
          [sourceId],
        )
      ).rows[0].commit_head;
    }
    const hits = async query => {
      for (let attempt = 0; ; attempt++) {
        const response = await f.call('/search', {
          method: 'POST',
          body: { kind: 'typing', query, filters: { kinds: ['github'], sourceIds: [sourceId] } },
        });
        if (response.status !== 503 || attempt >= 4) {
          assert.equal(response.status, 200, response.bytes.toString());
          return response.json().hits;
        }
      }
    };
    const ids = commits => commits.map(item => `commit:7020:${item.sha}`).toSorted();
    const reads = () =>
      gh.github.calls
        .map(call => /^\/repositories\/7020\/commits\/([a-f0-9]{40})$/.exec(call.path)?.[1])
        .filter(Boolean);

    await t.test('the first pass publishes every commit with its message and changed files', async () => {
      assert.equal(await reconcile(), 'ready');
      const rows = await items();
      assert.deepEqual(
        rows.map(row => row.nativeId),
        ids(repo.history),
      );
      assert.ok(
        rows.every(row => row.searchable && row.failure === null),
        JSON.stringify(rows),
      );
      assert.equal(await head(), repo.history.at(-1).sha);
      assert.ok((await hits('marigold')).length > 0);
      assert.ok((await hits('src/petunia/step-1.ts')).length > 0, 'changed file paths are searchable');
    });
    const known = [...repo.history];
    await t.test('a later pass lists only newer commits and never rereads known ones', async () => {
      gh.github.push(repo, { message: 'Tune the zinnia schedule', files: [{ filename: 'docs/zinnia.md' }] });
      gh.github.push(repo, { message: 'Document zinnia limits' });
      gh.github.calls.length = 0;
      assert.equal(await reconcile(), 'ready');
      assert.ok(
        gh.github.calls.every(call => call.path !== '/repositories/7020/commits'),
        'the indexed head is compared rather than listing the whole history again',
      );
      assert.deepEqual(
        reads().toSorted(),
        repo.history
          .slice(3)
          .map(item => item.sha)
          .toSorted(),
      );
      const rows = await items();
      assert.deepEqual(
        rows.map(row => row.nativeId),
        ids(repo.history),
      );
      assert.ok(rows.every(row => row.searchable));
      assert.equal(await head(), repo.history.at(-1).sha);
      assert.ok((await hits('zinnia')).length > 0);
    });
    await t.test('an unchanged head lists nothing and reads nothing', async () => {
      gh.github.calls.length = 0;
      assert.equal(await reconcile(), 'ready');
      assert.deepEqual(reads(), []);
    });
    await t.test('a force push relists the history and publishes the rewritten commit', async () => {
      repo.history = repo.history.slice(0, 2);
      const rewritten = gh.github.push(repo, { message: 'Rewrite the aster plan' });
      gh.github.calls.length = 0;
      assert.equal(await reconcile(), 'ready');
      assert.ok(reads().includes(rewritten.sha));
      for (const item of known.slice(0, 2)) assert.ok(!reads().includes(item.sha), 'retained commits are not reread');
      const live = (await items()).filter(row => row.searchable).map(row => row.nativeId);
      assert.ok(live.includes(`commit:7020:${rewritten.sha}`));
      for (const id of ids(known.slice(0, 2))) assert.ok(live.includes(id));
      assert.equal(await head(), rewritten.sha);
      assert.ok((await hits('aster')).length > 0);
    });
  } finally {
    await f?.close();
  }
});
