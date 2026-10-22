import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerAtlassianKnowledge } from '../../worker/dist/knowledge-atlassian-composition.js';
import { createAtlassianKnowledgeActivities } from '../../worker/dist/knowledge-atlassian-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { atlassianProviderFixture } from './knowledge-atlassian-provider-fixture.mjs';

test('authenticated Atlassian corpus HTTP uses each member own Atlassian account', { timeout: 180000 }, async t => {
  const atlassian = atlassianProviderFixture();
  let f;
  try {
    f = await knowledgeFixture({ atlassianCorpus: atlassian.provider });
    const owner = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
    const reader = await atlassian.link(f, f.adminMembership, 'reader-aaid');
    const worker = createWorkerAtlassianKnowledge({
      runtime: f.runtime,
      atlassianCorpus: atlassian.provider(f.runtime),
    });
    const activity = createAtlassianKnowledgeActivities(worker);
    const readerOptions = { cookie: f.signed.admin.cookie };
    const configure = {
      commandId: randomUUID(),
      selection: {
        product: 'confluence',
        cloudId: atlassian.cloudId,
        targets: [{ kind: 'space', id: '9001', descendants: false }],
      },
      memberIds: [f.adminMembership],
    };
    const sourceId = configure.commandId;
    // Search has a bounded deadline; retry only storage-deadline 503s so host load cannot masquerade as an authorization result.
    const search = async (options = {}, id = sourceId, query = 'orchid') => {
      for (let attempt = 0; ; attempt++) {
        const response = await f.call('/search', {
          ...options,
          method: 'POST',
          body: { kind: 'typing', query, filters: { kinds: ['confluence', 'jira'], sourceIds: [id] } },
        });
        if (response.status !== 503 || attempt >= 4) return response;
      }
    };
    async function processSource(id = sourceId) {
      for (let index = 0; index < 10; index++) {
        const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === id);
        if (!work) return;
        assert.equal(await activity.processAtlassianKnowledge(work), undefined);
      }
      assert.fail('bounded fixture did not complete');
    }
    let ownerHits;
    await t.test('authentication, origin and input validation precede provider calls', async () => {
      const before = atlassian.calls.length;
      assert.equal((await f.call('/atlassian/sites', { cookie: '' })).status, 401);
      assert.equal(
        (
          await f.call('/atlassian/sources', {
            method: 'POST',
            body: configure,
            headers: { origin: 'https://untrusted.test' },
          })
        ).status,
        403,
      );
      assert.equal((await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=everything`)).status, 400);
      assert.equal(
        (await f.call('/atlassian/sources', { method: 'POST', body: { ...configure, extra: true } })).status,
        400,
      );
      assert.equal(
        (
          await f.call('/atlassian/sources', {
            method: 'POST',
            body: { ...configure, selection: { ...configure.selection, product: 'jira' } },
          })
        ).status,
        400,
      );
      assert.equal(atlassian.calls.length, before);
      assert.equal((await f.call(`/v1/workspaces/${f.other.id}/knowledge/atlassian/sources`)).status, 404);
      const members = await f.call('/atlassian/members');
      assert.equal(members.status, 200, members.bytes.toString());
      assert.deepEqual(
        members
          .json()
          .members.map(member => member.id)
          .sort(),
        [f.workspace.membershipId, f.adminMembership].sort(),
      );
    });
    await t.test('sites and discovery come from the caller own account', async () => {
      const sites = await f.call('/atlassian/sites');
      assert.equal(sites.status, 200, sites.bytes.toString());
      assert.deepEqual(sites.json().items, [
        { cloudId: atlassian.cloudId, name: 'acme', url: 'https://acme.atlassian.net' },
      ]);
      const spaces = await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=spaces`);
      assert.equal(spaces.status, 200, spaces.bytes.toString());
      assert.deepEqual(spaces.json().items, [{ kind: 'space', id: '9001', key: 'SUP', title: 'Suppliers' }]);
      assert.deepEqual(
        (await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=pages&within=9001`, readerOptions))
          .json()
          .items.map(item => item.id),
        ['101'],
      );
      assert.deepEqual(
        (await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=projects`))
          .json()
          .items.map(item => item.key),
        ['OPS'],
      );
      assert.ok(atlassian.calls.every(call => ['owner-aaid', 'reader-aaid'].includes(call.user)));
    });
    await t.test('setup, background sync, generic and Atlassian evidence, and safe Markdown download', async () => {
      const configured = await f.call('/atlassian/sources', { method: 'POST', body: configure });
      assert.equal(configured.status, 200, configured.bytes.toString());
      assert.equal(configured.json().canManage, true);
      assert.equal((await f.call('/atlassian/sources', { method: 'POST', body: configure })).json().sourceId, sourceId);
      await processSource();
      const listed = (await f.call('/atlassian/sources')).json().items[0];
      assert.equal(listed.syncState, 'ready');
      assert.deepEqual(listed.counts, { total: 2, ready: 2, failed: 0 });
      ownerHits = (await search()).json().hits;
      assert.equal(ownerHits.length, 2);
      for (const prefix of ['', '/atlassian']) {
        const evidence = await f.call(`${prefix}/evidence`, { method: 'POST', body: ownerHits[0].citation });
        assert.equal(evidence.status, 200, evidence.bytes.toString());
        assert.equal(evidence.json().original.kind, 'confluence');
        const download = await f.call(
          `${prefix}/documents/${ownerHits[0].citation.documentId}/original?revisionId=${ownerHits[0].citation.revisionId}`,
        );
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
        assert.match(
          download.headers.get('content-disposition'),
          /^attachment; filename="document"; filename\*=UTF-8''confluence-item\.md$/,
        );
        assert.match(
          download.bytes.toString(),
          /Created by owner-aaid at 2026-09-01T00:00:00\.000Z\. Last edited by owner-aaid at 2026-10-01T00:00:00\.000Z\./,
        );
      }
      const documents = await f.call(`/atlassian/sources/${sourceId}/documents`);
      assert.equal(documents.status, 200, documents.bytes.toString());
      assert.equal(documents.json().items.length, 2);
      assert.ok(documents.json().items.every(item => Date.parse(item.validUntil) <= Date.now() + 300000));
      assert.equal((await f.call(`/atlassian/documents/${ownerHits[0].citation.documentId}`)).json().parsing, 'ready');
    });
    await t.test('a selected reader sees only pages their own account can view, after their own check', async () => {
      const shared = (await f.call('/atlassian/sources', readerOptions)).json().items[0];
      assert.equal(shared.canManage, false);
      assert.equal(shared.selection, null);
      assert.equal(shared.targets, null);
      const before = (await search(readerOptions)).json();
      assert.deepEqual(before.hits, []);
      assert.equal(before.coverage, 'partial');
      const refreshed = await f.call(`/atlassian/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
      assert.equal(refreshed.status, 200, refreshed.bytes.toString());
      assert.deepEqual(refreshed.json(), { refreshed: 1, unavailable: 1, bounded: true });
      assert.ok(atlassian.calls.some(call => call.path === '/wiki/api/v2/pages' && call.user === 'reader-aaid'));
      const visible = (await search(readerOptions)).json().hits;
      assert.deepEqual(
        visible.map(hit => hit.title),
        ['Supplier handbook'],
      );
      const restricted = ownerHits.find(hit => hit.title === 'Supplier pricing');
      assert.equal(
        (await f.call('/evidence', { ...readerOptions, method: 'POST', body: restricted.citation })).status,
        404,
      );
      assert.equal(
        (
          await f.call(
            `/documents/${restricted.citation.documentId}/original?revisionId=${restricted.citation.revisionId}`,
            readerOptions,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await f.call(`/atlassian/sources/${sourceId}/manage`, {
            ...readerOptions,
            method: 'POST',
            body: { commandId: randomUUID(), action: 'pause' },
          })
        ).status,
        404,
      );
    });
    await t.test(
      'disconnecting the reader account revokes immediately and reconnecting needs a fresh check',
      async () => {
        const accounts = atlassian.accounts(f.runtime);
        await accounts.disconnect(f.workspace.id, f.signed.admin.id, reader.accountId);
        assert.deepEqual((await search(readerOptions)).json().hits, []);
        assert.equal(
          (await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=spaces`, readerOptions)).json().error,
          'atlassian-not-linked',
        );
        assert.equal(
          (await f.call(`/atlassian/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).status,
          404,
        );
        await f.db.platform.query(`DELETE FROM ${f.table('tf_atlassian_account_attempts')} WHERE account_id=$1`, [
          reader.accountId,
        ]);
        await f.db.platform.query(`UPDATE ${f.table('tf_atlassian_accounts')} SET state='disconnected' WHERE id=$1`, [
          reader.accountId,
        ]);
        const relinked = await atlassian.link(f, f.adminMembership, 'reader-aaid');
        assert.deepEqual(
          (await search(readerOptions)).json().hits,
          [],
          'a new account does not resurrect proofs from the old one',
        );
        await f.call(`/atlassian/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' });
        assert.equal((await search(readerOptions)).json().hits.length, 1);
        atlassian.state.pages.get('101').viewers.delete('reader-aaid');
        assert.deepEqual(
          (await f.call(`/atlassian/sources/${sourceId}/refresh`, { ...readerOptions, method: 'POST' })).json(),
          { refreshed: 0, unavailable: 2, bounded: true },
        );
        assert.deepEqual((await search(readerOptions)).json().hits, []);
        atlassian.state.pages.get('101').viewers.add('reader-aaid');
        assert.equal(relinked.accountId.length, 36);
      },
    );
    await t.test('Jira sources hide issues behind security levels and restricted comments', async () => {
      const jiraId = randomUUID();
      const configured = await f.call('/atlassian/sources', {
        method: 'POST',
        body: {
          commandId: jiraId,
          selection: {
            product: 'jira',
            cloudId: atlassian.cloudId,
            targets: [{ kind: 'project', id: '7001', descendants: false }],
          },
          memberIds: [f.adminMembership],
        },
      });
      assert.equal(configured.status, 200, configured.bytes.toString());
      await processSource(jiraId);
      assert.equal((await search({}, jiraId)).json().hits.length, 2);
      assert.deepEqual((await search({}, jiraId, 'salary')).json().hits, []);
      await f.call(`/atlassian/sources/${jiraId}/refresh`, { ...readerOptions, method: 'POST' });
      const hits = (await search(readerOptions, jiraId)).json().hits;
      assert.deepEqual(
        hits.map(hit => hit.title),
        ['OPS-1: Orchid shipment'],
      );
      const download = await f.call(
        `/documents/${hits[0].citation.documentId}/original?revisionId=${hits[0].citation.revisionId}`,
        readerOptions,
      );
      assert.match(
        download.bytes.toString(),
        /## Comment by Olive \(owner-aaid\) at 2026-10-01T09:00:00\.000Z\n\norchid courier confirmed/,
      );
      assert.doesNotMatch(download.bytes.toString(), /salary/);
    });
    await t.test('provider rate limits and missing selections map to bounded errors', async () => {
      atlassian.state.failure = (user, path) =>
        user === 'owner-aaid' && path === '/wiki/api/v2/spaces'
          ? new Response('slow', { status: 429, headers: { 'retry-after': '3' } })
          : null;
      const limited = await f.call(`/atlassian/discover?cloudId=${atlassian.cloudId}&kind=spaces`);
      assert.equal(limited.status, 429);
      assert.equal(limited.json().error, 'atlassian-rate-limited');
      atlassian.state.failure = null;
      const missing = await f.call('/atlassian/sources', {
        method: 'POST',
        body: {
          commandId: randomUUID(),
          selection: {
            product: 'confluence',
            cloudId: atlassian.cloudId,
            targets: [{ kind: 'page', id: '404', descendants: true }],
          },
          memberIds: [],
        },
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.json().error, 'atlassian-not-found');
      assert.equal(owner.accountId.length, 36);
    });
  } finally {
    await f?.close();
  }
});
