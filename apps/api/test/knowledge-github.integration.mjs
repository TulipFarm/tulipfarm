import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerGitHubKnowledge } from '../../worker/dist/knowledge-github-composition.js';
import { createGitHubKnowledgeActivities } from '../../worker/dist/knowledge-github-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { githubProviderFixture } from './knowledge-github-provider-fixture.mjs';

test('authenticated GitHub corpus HTTP uses each member own linked GitHub account', { timeout: 180000 }, async t => {
  const gh = githubProviderFixture();
  let f;
  try {
    f = await knowledgeFixture({ githubCorpus: gh.provider });
    const owner = await gh.connect(f, f.signed.owner, 101, 'owner');
    let reader = await gh.connect(f, f.signed.admin, 202, 'reader');
    const worker = createWorkerGitHubKnowledge({ runtime: f.runtime, githubCorpus: gh.provider(f.runtime) });
    const activity = createGitHubKnowledgeActivities(worker);
    const readerOptions = { cookie: f.signed.admin.cookie };
    const configure = {
      commandId: randomUUID(),
      accountId: owner.accountId,
      selection: { repositories: ['acme/handbook', 'acme/leadership'], kinds: ['docs', 'issues'], after: gh.after },
      memberIds: [f.adminMembership],
    };
    const sourceId = configure.commandId;
    // Search has a bounded deadline; retry only storage-deadline 503s so host load cannot masquerade as an authorization result.
    const search = async (options = {}, id = sourceId, query = 'orchid') => {
      for (let attempt = 0; ; attempt++) {
        const response = await f.call('/search', {
          ...options,
          method: 'POST',
          body: { kind: 'typing', query, filters: { kinds: ['github'], sourceIds: [id] } },
        });
        if (response.status !== 503 || attempt >= 4) return response;
      }
    };
    async function processSource(id = sourceId) {
      for (let index = 0; index < 10; index++) {
        const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === id);
        if (!work) return;
        assert.equal(await activity.processGitHubKnowledge(work), undefined);
      }
      assert.fail('bounded fixture did not complete');
    }
    let ownerHits;
    await t.test('authentication, origin and input validation precede provider calls', async () => {
      const before = gh.github.calls.length;
      assert.equal((await f.call(`/github/discover?accountId=${owner.accountId}`, { cookie: '' })).status, 401);
      assert.equal(
        (
          await f.call('/github/sources', {
            method: 'POST',
            body: configure,
            headers: { origin: 'https://untrusted.test' },
          })
        ).status,
        403,
      );
      assert.equal((await f.call('/github/discover?accountId=not-a-uuid')).status, 400);
      assert.equal(
        (await f.call('/github/sources', { method: 'POST', body: { ...configure, extra: true } })).status,
        400,
      );
      assert.equal(
        (
          await f.call('/github/sources', {
            method: 'POST',
            body: {
              ...configure,
              selection: { ...configure.selection, repositories: ['acme/leadership', 'acme/handbook'] },
            },
          })
        ).status,
        400,
      );
      assert.equal(gh.github.calls.length, before);
      assert.equal((await f.call(`/v1/workspaces/${f.other.id}/knowledge/github/sources`)).status, 404);
      const members = await f.call('/github/members');
      assert.equal(members.status, 200, members.bytes.toString());
      assert.deepEqual(
        members
          .json()
          .members.map(member => member.id)
          .sort(),
        [f.workspace.membershipId, f.adminMembership].sort(),
      );
    });
    await t.test('discovery lists only repositories the caller own account can read', async () => {
      const mine = await f.call(`/github/discover?accountId=${owner.accountId}`);
      assert.equal(mine.status, 200, mine.bytes.toString());
      assert.deepEqual(
        mine.json().items.map(item => [item.repositoryId, item.fullName, item.visibility]),
        [
          ['7001', 'acme/handbook', 'private'],
          ['7002', 'acme/leadership', 'private'],
        ],
      );
      assert.deepEqual(
        (await f.call(`/github/discover?accountId=${reader.accountId}`, readerOptions))
          .json()
          .items.map(item => item.fullName),
        ['acme/handbook'],
      );
      const borrowed = await f.call(`/github/discover?accountId=${owner.accountId}`, readerOptions);
      assert.equal(borrowed.status, 409);
      assert.equal(borrowed.json().error, 'github-not-linked');
      assert.ok(
        gh.github.calls
          .filter(call => call.path === '/user/repos')
          .every(call => ['owner', 'reader'].includes(call.user)),
      );
    });
    await t.test('setup, background sync, generic and GitHub evidence, and safe Markdown download', async () => {
      const configured = await f.call('/github/sources', { method: 'POST', body: configure });
      assert.equal(configured.status, 200, configured.bytes.toString());
      assert.equal(configured.json().canManage, true);
      assert.equal((await f.call('/github/sources', { method: 'POST', body: configure })).json().sourceId, sourceId);
      await processSource();
      const listed = (await f.call('/github/sources')).json().items[0];
      assert.equal(listed.syncState, 'ready');
      assert.deepEqual(listed.counts, { total: 4, ready: 4, failed: 0 });
      ownerHits = (await search()).json().hits;
      assert.equal(ownerHits.length, 4);
      for (const prefix of ['', '/github']) {
        const evidence = await f.call(`${prefix}/evidence`, { method: 'POST', body: ownerHits[0].citation });
        assert.equal(evidence.status, 200, evidence.bytes.toString());
        assert.equal(evidence.json().original.kind, 'github');
        const download = await f.call(
          `${prefix}/documents/${ownerHits[0].citation.documentId}/original?revisionId=${ownerHits[0].citation.revisionId}`,
        );
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
        assert.match(
          download.headers.get('content-disposition'),
          /^attachment; filename="document"; filename\*=UTF-8''github-document\.md$/,
        );
        assert.match(
          download.bytes.toString(),
          /GitHub (repository acme\/\w+ \(ID 700\d\), file `[^`]+` at commit [a-f0-9]{40}|issue acme\/handbook#1 by @octo)/,
        );
      }
      const documents = await f.call(`/github/sources/${sourceId}/documents`);
      assert.equal(documents.status, 200, documents.bytes.toString());
      assert.equal(documents.json().items.length, 4);
      assert.ok(documents.json().items.every(item => Date.parse(item.validUntil) <= Date.now() + 300000));
      assert.equal((await f.call(`/github/documents/${ownerHits[0].citation.documentId}`)).json().parsing, 'ready');
    });
    await t.test(
      'a selected reader sees only repositories their own account can read, after their own check',
      async () => {
        const shared = (await f.call('/github/sources', readerOptions)).json().items[0];
        assert.equal(shared.canManage, false);
        assert.equal(shared.selection, null);
        assert.equal(shared.repositories, null);
        const before = (await search(readerOptions)).json();
        assert.deepEqual(before.hits, []);
        assert.equal(before.coverage, 'partial');
        const refreshed = await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
        assert.equal(refreshed.status, 200, refreshed.bytes.toString());
        assert.deepEqual(refreshed.json(), { refreshed: 1, unavailable: 1, bounded: true });
        assert.ok(
          gh.github.calls.filter(call => call.path === '/repositories/7002').some(call => call.user === 'reader'),
        );
        const visible = (await search(readerOptions)).json().hits;
        assert.equal(visible.length, 3);
        assert.ok(visible.every(hit => hit.title.startsWith('acme/handbook')));
        const privateHit = ownerHits.find(hit => hit.title.startsWith('acme/leadership'));
        assert.equal(
          (await f.call('/evidence', { ...readerOptions, method: 'POST', body: privateHit.citation })).status,
          404,
        );
        assert.equal(
          (
            await f.call(
              `/documents/${privateHit.citation.documentId}/original?revisionId=${privateHit.citation.revisionId}`,
              readerOptions,
            )
          ).status,
          404,
        );
        assert.equal((await f.call(`/github/documents/${privateHit.citation.documentId}`, readerOptions)).status, 404);
        assert.equal(
          (
            await f.call(`/github/sources/${sourceId}/manage`, {
              ...readerOptions,
              method: 'POST',
              body: { commandId: randomUUID(), action: 'pause' },
            })
          ).status,
          404,
        );
      },
    );
    await t.test('local disconnect, reconnect and GitHub-side removal revoke reader access', async () => {
      await reader.disconnect();
      assert.deepEqual((await search(readerOptions)).json().hits, []);
      assert.equal(
        (await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).status,
        404,
      );
      reader = await gh.connect(f, f.signed.admin, 202, 'reader', reader.accountId);
      assert.deepEqual(
        (await search(readerOptions)).json().hits,
        [],
        'reconnecting does not resurrect proofs from the old account generation',
      );
      await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
      assert.equal((await search(readerOptions)).json().hits.length, 3);
      gh.github.state.repos.get(7001).readers.delete(202);
      assert.deepEqual(
        (await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).json(),
        { refreshed: 0, unavailable: 2, bounded: true },
      );
      assert.deepEqual((await search(readerOptions)).json().hits, []);
      gh.github.state.repos.get(7001).readers.add(202);
      await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
      assert.equal((await search(readerOptions)).json().hits.length, 3);
      gh.github.state.failure = user =>
        user.login === 'reader' ? Response.json({ message: 'Bad credentials' }, { status: 401 }) : null;
      await f.call(`/github/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
      gh.github.state.failure = null;
      assert.deepEqual(
        (await search(readerOptions)).json().hits,
        [],
        'a rejected token invalidates the account and grants nothing',
      );
      const accounts = await f.db.platform.query(`SELECT state FROM ${f.table('tf_github_accounts')} WHERE id=$1`, [
        reader.accountId,
      ]);
      assert.equal(accounts.rows[0].state, 'reconnect-required');
    });
    await t.test('an unselected admin gets no implicit access to a private-only source', async () => {
      const privateId = randomUUID();
      const created = await f.call('/github/sources', {
        method: 'POST',
        body: {
          commandId: privateId,
          accountId: owner.accountId,
          selection: { repositories: ['acme/handbook'], kinds: ['docs'], after: gh.after },
          memberIds: [],
        },
      });
      assert.equal(created.status, 200, created.bytes.toString());
      await processSource(privateId);
      assert.equal((await search({}, privateId)).json().hits.length, 2);
      assert.deepEqual((await search(readerOptions, privateId)).json().hits, []);
      assert.equal(
        (await f.call(`/github/sources/${privateId}/refresh`, { ...readerOptions, method: 'POST' })).status,
        404,
      );
      assert.equal(
        (await f.call('/github/sources', readerOptions)).json().items.some(item => item.sourceId === privateId),
        false,
      );
    });
    await t.test('provider rate limits, renamed and inaccessible selections map to bounded errors', async () => {
      gh.github.state.failure = (user, path) =>
        user.login === 'owner' && path === '/user/repos'
          ? new Response('{}', { status: 429, headers: { 'retry-after': '3' } })
          : null;
      const limited = await f.call(`/github/discover?accountId=${owner.accountId}`);
      assert.equal(limited.status, 429);
      assert.equal(limited.json().error, 'github-rate-limited');
      gh.github.state.failure = null;
      gh.github.state.renamed.set('acme/old-handbook', 7001);
      const renamed = await f.call('/github/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          accountId: owner.accountId,
          selection: { repositories: ['acme/old-handbook'], kinds: ['docs'], after: gh.after },
          memberIds: [],
        },
      });
      assert.equal(renamed.status, 400);
      assert.equal(renamed.json().error, 'github-invalid-selection');
      gh.github.addRepo({ id: 7003, fullName: 'acme/hidden', readers: [999] });
      const hidden = await f.call('/github/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          accountId: owner.accountId,
          selection: { repositories: ['acme/hidden'], kinds: ['docs'], after: gh.after },
          memberIds: [],
        },
      });
      assert.equal(hidden.status, 404);
      assert.equal(hidden.json().error, 'github-forbidden');
      assert.equal(owner.token.startsWith('gho_'), true);
    });
  } finally {
    await f?.close();
  }
});
