import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerGitHubKnowledge } from '../../worker/dist/knowledge-github-composition.js';
import { createGitHubKnowledgeActivities } from '../../worker/dist/knowledge-github-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { githubProviderFixture } from './knowledge-github-provider-fixture.mjs';

// The real GitHub corpus provider and the Knowledge engine index every default-branch file: no allowlist, built-in
// exclusion or count cap, large files in parts, binaries as placeholders, long paths by hash, truncated trees walked.
test('GitHub code indexing publishes every default-branch file across head changes', { timeout: 600000 }, async t => {
  const gh = githubProviderFixture();
  let f;
  try {
    f = await knowledgeFixture({ githubCorpus: runtime => gh.provider(runtime) });
    const owner = await gh.connect(f, f.signed.owner, 101, 'owner');
    const worker = createWorkerGitHubKnowledge({ runtime: f.runtime, githubCorpus: gh.provider(f.runtime) });
    const activity = createGitHubKnowledgeActivities(worker);
    const longPath = `${Array.from({ length: 12 }, (_, i) => `level-${i}-${'d'.repeat(90)}`).join('/')}/deep.ts`;
    const repo = gh.github.addRepo({
      id: 7010,
      fullName: 'acme/platform',
      readers: [101],
      files: {
        'src/index.ts': "export const bravo = 'bravo';",
        '.env.example': 'BRAVO_TOKEN=placeholder',
        'node_modules/pkg/index.js': "module.exports = 'bravo';",
        'dist/app.min.js': "var bravo='bravo';",
        'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
        'data/big.csv': 'bravo,1\n'.repeat(40 * 1024),
        [longPath]: "export const deepBravo = 'bravo';",
      },
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
    async function items() {
      return (
        await f.db.platform.query(
          `SELECT i.native_id AS "nativeId", i.path, i.failure, (d.lexical_publication_id IS NOT NULL AND d.tombstoned_at IS NULL) AS searchable
          FROM ${f.table('tf_knowledge_github_items')} i LEFT JOIN ${f.table('tf_knowledge_documents')} d ON d.id=i.document_id
          WHERE i.source_id=$1 ORDER BY i.native_id`,
          [sourceId],
        )
      ).rows;
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
    const hashed = `code:7010:/h/${createHash('sha256').update(longPath).digest('hex')}`;
    const first = [
      'code:7010:.env.example',
      'code:7010:/h/',
      'code:7010:/p/2/data/big.csv',
      'code:7010:/p/3/data/big.csv',
      'code:7010:assets/logo.png',
      'code:7010:data/big.csv',
      'code:7010:dist/app.min.js',
      'code:7010:node_modules/pkg/index.js',
      'code:7010:src/index.ts',
    ];

    await t.test(
      'the first head publishes every file, with parts, a binary placeholder and a hashed path',
      async () => {
        assert.equal(await reconcile(), 'ready');
        const rows = await items();
        assert.deepEqual(
          rows.map(row => (row.nativeId.startsWith('code:7010:/h/') ? 'code:7010:/h/' : row.nativeId)).toSorted(),
          first,
        );
        assert.ok(
          rows.every(row => row.searchable && row.failure === null),
          JSON.stringify(rows.filter(row => !row.searchable || row.failure)),
        );
        const deep = rows.find(row => row.nativeId.startsWith('code:7010:/h/'));
        assert.equal(deep.nativeId, hashed);
        assert.equal(deep.path, longPath, 'the full path is kept to read a hashed ID');
        assert.equal(rows.find(row => row.nativeId === 'code:7010:/p/2/data/big.csv').path, 'data/big.csv');
        assert.ok((await hits('bravo')).length > 0);
        assert.ok((await hits('OCR')).length > 0, 'the binary placeholder is searchable');
      },
    );
    for (let i = 0; i < 30; i++)
      repo.files.set(`pkg/m${String(i).padStart(2, '0')}/alpha.ts`, `export const alpha${i} = 'alpha';`);
    await t.test('a listing that keeps failing at the new head preserves the published files', async () => {
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
          `SELECT sync_state,failure FROM ${f.table('tf_knowledge_github_sources')} WHERE source_id=$1`,
          [sourceId],
        )
      ).rows[0];
      // The repository is isolated for this pass; the source finishes it and retries the repository next pass.
      assert.deepEqual({ ...state }, { sync_state: 'ready', failure: 'transient' });
      assert.equal((await items()).filter(row => row.searchable).length, first.length);
    });
    await t.test('a truncated tree at the new head is walked and every file is published', async () => {
      gh.github.state.truncate = true;
      try {
        assert.equal(await reconcile(), 'ready');
      } finally {
        gh.github.state.truncate = false;
      }
      const rows = await items();
      assert.equal(rows.length, first.length + 30);
      assert.ok(rows.every(row => row.searchable && row.failure === null));
      assert.ok((await hits('alpha')).length > 0);
      assert.ok((await hits('bravo')).length > 0);
      const listed = (await f.call('/github/sources')).json().items.find(item => item.sourceId === sourceId);
      assert.equal(listed.counts.ready, first.length + 30);
    });
    await t.test('files deleted at a later head leave coverage', async () => {
      repo.files.delete('node_modules/pkg/index.js');
      repo.files.set('data/big.csv', 'bravo,1\n');
      assert.equal(await reconcile(), 'ready');
      const rows = await items();
      const live = rows.filter(row => row.searchable).map(row => row.nativeId);
      assert.ok(!live.includes('code:7010:node_modules/pkg/index.js'));
      assert.ok(!live.includes('code:7010:/p/2/data/big.csv'), 'parts beyond a shrunken file leave coverage');
      assert.ok(live.includes('code:7010:data/big.csv'));
    });
  } finally {
    await f?.close();
  }
});
