import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerGitHubKnowledge } from '../../worker/dist/knowledge-github-composition.js';
import { createGitHubKnowledgeActivities } from '../../worker/dist/knowledge-github-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { githubProviderFixture } from './knowledge-github-provider-fixture.mjs';

// The real GitHub corpus provider and the Knowledge engine across two default-branch heads: the code-file bound holds after reconciliation.
// The bound is scaled down (40 files, 8 listed skips) to keep publication fast; the provider test covers the production 1,000 and 200.
const bound = { files: 40, skipped: 8 };
test(
  'GitHub code reconciliation keeps the code-file bound per repository across head changes',
  { timeout: 600000 },
  async t => {
    const gh = githubProviderFixture();
    let f;
    try {
      f = await knowledgeFixture({ githubCorpus: runtime => gh.provider(runtime, bound) });
      const owner = await gh.connect(f, f.signed.owner, 101, 'owner');
      const worker = createWorkerGitHubKnowledge({ runtime: f.runtime, githubCorpus: gh.provider(f.runtime, bound) });
      const activity = createGitHubKnowledgeActivities(worker);
      const name = (prefix, i) => `${prefix}/${String(i).padStart(4, '0')}.ts`;
      const repo = gh.github.addRepo({
        id: 7010,
        fullName: 'acme/platform',
        readers: [101],
        files: Object.fromEntries(
          Array.from({ length: bound.files }, (_, i) => [name('b', i), `export const bravo${i} = 'bravo';`]),
        ),
      });
      const sourceId = randomUUID();
      const configured = await f.call('/github/sources', {
        method: 'POST',
        body: {
          commandId: sourceId,
          accountId: owner.accountId,
          selection: { repositories: ['acme/platform'], kinds: ['code'], after: gh.after },
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
      async function coverage() {
        return (
          await f.db.platform.query(
            `SELECT
        count(*) FILTER (WHERE d.lexical_publication_id IS NOT NULL)::int AS searchable,
        count(*) FILTER (WHERE d.lexical_publication_id IS NOT NULL AND i.native_id LIKE 'code:7010:b/%')::int AS "searchableB",
        count(*) FILTER (WHERE d.lexical_publication_id IS NOT NULL AND i.native_id LIKE 'code:7010:a/%')::int AS "searchableA",
        count(*) FILTER (WHERE i.native_id LIKE 'code:7010:b/%' AND i.failure='excluded')::int AS "skippedB",
        count(*) FILTER (WHERE i.native_id LIKE 'code:7010:b/%' AND d.tombstoned_at IS NULL AND o.revision_id IS NOT NULL)::int AS "retainedB"
        FROM ${f.table('tf_knowledge_github_items')} i LEFT JOIN ${f.table('tf_knowledge_documents')} d ON d.id=i.document_id
        LEFT JOIN ${f.table('tf_knowledge_github_originals')} o ON o.revision_id=d.observed_revision_id WHERE i.source_id=$1`,
            [sourceId],
          )
        ).rows[0];
      }
      const n = bound.files;
      const full = { searchable: n, searchableB: n, searchableA: 0, skippedB: 0, retainedB: n };
      const displaced = { searchable: n, searchableB: 0, searchableA: n, skippedB: n, retainedB: n };
      const hits = async query => {
        for (let attempt = 0; ; attempt++) {
          const response = await f.call('/search', {
            method: 'POST',
            body: { kind: 'typing', query, filters: { kinds: ['github'], sourceIds: [sourceId] } },
          });
          if (response.status !== 503 || attempt >= 4) {
            assert.equal(response.status, 200, response.bytes.toString());
            return response.json().hits.length;
          }
        }
      };

      await t.test('the first head publishes all its files, up to the bound', async () => {
        assert.equal(await reconcile(), 'ready');
        assert.deepEqual(await coverage(), full);
        assert.ok((await hits('bravo')) > 0);
      });
      for (let i = 0; i < bound.files; i++) repo.files.set(name('a', i), `export const alpha${i} = 'alpha';`);
      await t.test('a failed listing at the new head preserves the published files', async () => {
        gh.github.state.failure = (_user, path) =>
          path.includes('/git/trees/') ? Response.json({ message: 'Server Error' }, { status: 500 }) : null;
        try {
          await f.db.platform.query(
            `UPDATE ${f.table('tf_knowledge_github_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [sourceId],
          );
          const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === sourceId);
          assert.ok(work);
          await activity.processGitHubKnowledge(work);
        } finally {
          gh.github.state.failure = null;
        }
        const state = (
          await f.db.platform.query(
            `SELECT sync_state FROM ${f.table('tf_knowledge_github_sources')} WHERE source_id=$1`,
            [sourceId],
          )
        ).rows[0];
        assert.equal(state.sync_state, 'failed');
        assert.deepEqual(await coverage(), full);
      });
      await t.test(
        'a truncated tree at the new head proves nothing displaced and preserves the published files',
        async () => {
          gh.github.state.truncate = true;
          try {
            await reconcile();
          } finally {
            gh.github.state.truncate = false;
          }
          assert.deepEqual(await coverage(), full);
        },
      );
      await t.test(
        'a complete reconciliation at the new head moves displaced files out of coverage, within the bound',
        async () => {
          assert.equal(await reconcile(), 'ready');
          assert.deepEqual(
            await coverage(),
            displaced,
            'every displaced file, listed or not, leaves coverage as a visible skip with its original retained',
          );
          assert.equal(await hits('bravo'), 0);
          assert.ok((await hits('alpha')) > 0);
          const listed = (await f.call('/github/sources')).json().items.find(item => item.sourceId === sourceId);
          assert.equal(listed.counts.ready, bound.files);
          assert.ok(listed.counts.failed >= bound.files, 'displaced files are counted as skipped');
        },
      );
      await t.test('a further reconciliation at the same head stays within the bound', async () => {
        assert.equal(await reconcile(), 'ready');
        assert.deepEqual(await coverage(), displaced);
      });
    } finally {
      await f?.close();
    }
  },
);
