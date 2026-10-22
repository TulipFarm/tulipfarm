import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkerGoogleKnowledge } from '../../worker/dist/knowledge-google-composition.js';
import { createGoogleKnowledgeActivities } from '../../worker/dist/knowledge-google-activities.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { googleProviderFixture, connectGoogle } from './knowledge-google-provider-fixture.mjs';

test(
  'authenticated Google corpus HTTP uses encrypted credentials and reader-specific authority',
  { timeout: 120000 },
  async t => {
    const provider = await googleProviderFixture();
    let f;
    try {
      f = await knowledgeFixture({ googleOptions: provider.options });
      await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET role='member' WHERE id=$1`, [
        f.workspace.membershipId,
      ]);
      const owner = await connectGoogle(f);
      const reader = await connectGoogle(f, f.signed.admin, 'reader-token');
      const worker = createWorkerGoogleKnowledge({
        runtime: f.runtime,
        googleService: f.googleService,
        providerFetch: provider.providerFetch,
      });
      const activity = createGoogleKnowledgeActivities(worker);
      const configure = {
        commandId: randomUUID(),
        selection: { kind: 'drive-folder', folderId: 'root' },
        memberIds: [f.adminMembership],
      };
      const sourceId = configure.commandId;
      const readerOptions = { cookie: f.signed.admin.cookie };
      const manage = action =>
        f.call(`/google/sources/${sourceId}/manage`, { method: 'POST', body: { commandId: randomUUID(), action } });
      const refresh = (options = {}) => f.call(`/google/sources/${sourceId}/refresh`, { ...options, method: 'POST' });
      const search = (options = {}) =>
        f.call('/search', {
          ...options,
          method: 'POST',
          body: { kind: 'typing', query: 'orchid', filters: { kinds: ['google'], sourceIds: [sourceId] } },
        });
      const evidence = (citation, options = {}, prefix = '') =>
        f.call(`${prefix}/evidence`, { ...options, method: 'POST', body: citation });
      const original = (citation, options = {}, prefix = '') =>
        f.call(`${prefix}/documents/${citation.documentId}/original?revisionId=${citation.revisionId}`, options);
      async function processSource(id = sourceId) {
        for (let index = 0; index < 5; index++) {
          const work = (await worker.due(f.workspace.id)).find(item => item.sourceId === id);
          if (!work) return;
          assert.equal(await activity.processGoogleKnowledge(work), undefined);
        }
        assert.fail('bounded fixture did not complete');
      }
      let citation;
      await t.test('ordinary member directory exposes only active member names and emails', async () => {
        const membership = (
          await f.db.platform.query(`SELECT role FROM ${f.table('tf_memberships')} WHERE id=$1`, [
            f.workspace.membershipId,
          ])
        ).rows[0];
        assert.equal(membership.role, 'member');
        const response = await f.call('/google/members');
        assert.equal(response.status, 200, response.bytes.toString());
        const profiles = (
          await f.signed.identity.query('SELECT id,name,email FROM app.users WHERE id=ANY($1::uuid[])', [
            [f.signed.owner.id, f.signed.admin.id],
          ])
        ).rows;
        const byId = new Map(profiles.map(profile => [profile.id, profile]));
        assert.deepEqual(response.json(), {
          members: [
            {
              id: f.workspace.membershipId,
              name: byId.get(f.signed.owner.id).name,
              email: byId.get(f.signed.owner.id).email,
            },
            { id: f.adminMembership, name: byId.get(f.signed.admin.id).name, email: byId.get(f.signed.admin.id).email },
          ],
        });
        assert.equal((await f.call('/google/members', { cookie: '' })).status, 401);
        assert.equal((await f.call(`/v1/workspaces/${f.other.id}/knowledge/google/members`)).status, 404);
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
          f.adminMembership,
        ]);
        assert.deepEqual(
          (await f.call('/google/members')).json().members.map(member => member.id),
          [f.workspace.membershipId],
        );
        assert.equal((await f.call('/google/members', readerOptions)).status, 404);
        await f.db.platform.query(`UPDATE ${f.table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
          f.adminMembership,
        ]);
      });
      await t.test(
        'authenticated setup, discovery, validation, publication, generic evidence and safe download',
        async () => {
          const before = provider.calls.length;
          assert.equal((await f.call('/google/discover?kind=drive-folder', { cookie: '' })).status, 401);
          assert.equal(
            (
              await f.call('/google/sources', {
                method: 'POST',
                body: configure,
                headers: { origin: 'https://untrusted.test' },
              })
            ).status,
            403,
          );
          assert.equal(provider.calls.length, before);
          assert.equal((await f.call('/google/discover?kind=invalid')).status, 400);
          for (const kind of ['drive-folder', 'shared-drive', 'gmail']) {
            const discovery = await f.call(`/google/discover?kind=${kind}`);
            assert.equal(discovery.status, 200, discovery.bytes.toString());
            assert.equal(discovery.json().items[0].kind, kind);
          }
          assert.equal(
            (await f.call('/google/sources', { method: 'POST', body: { ...configure, extra: true } })).status,
            400,
          );
          const configured = await f.call('/google/sources', { method: 'POST', body: configure });
          assert.equal(configured.status, 200, configured.bytes.toString());
          assert.equal(configured.json().canManage, true);
          assert.equal(
            (await f.call('/google/sources', { method: 'POST', body: configure })).json().sourceId,
            sourceId,
          );
          await processSource();
          const sources = (await f.call('/google/sources')).json().items;
          assert.equal(sources[0].syncState, 'ready');
          assert.deepEqual(sources[0].counts, { total: 1, ready: 1, failed: 0 });
          citation = (await search()).json().hits[0].citation;
          for (const prefix of ['', '/google']) {
            const result = await evidence(citation, {}, prefix);
            assert.equal(result.status, 200, result.bytes.toString());
            assert.equal(result.json().original.kind, 'google');
            assert.match(result.json().text, /orchid supplier/);
            const download = await original(citation, {}, prefix);
            assert.equal(download.status, 200, download.bytes.toString());
            assert.equal(download.bytes.toString(), provider.state.text);
            assert.equal(download.headers.get('content-type'), 'application/octet-stream');
            assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
            assert.match(download.headers.get('content-disposition'), /attachment; filename="document"/);
            assert.equal(/[\r\n]/.test(download.headers.get('content-disposition')), false);
          }
          const status = await f.call(`/google/documents/${citation.documentId}`);
          assert.equal(status.status, 200);
          assert.equal(status.json().parsing, 'ready');
          const documents = await f.call(`/google/sources/${sourceId}/documents`);
          assert.equal(documents.status, 200, documents.bytes.toString());
          assert.equal(documents.json().items[0].documentId, citation.documentId);
          assert.equal(documents.json().items[0].parsing, 'ready');
          assert.ok(Date.parse(documents.json().items[0].validUntil) > Date.now());
          assert.equal(documents.json().nextCursor, null);
          assert.equal((await f.call(`/google/sources/${sourceId}/documents?cursor=invalid`)).status, 400);
          assert.equal((await evidence({ ...citation, workspaceId: f.other.id })).status, 404);
          assert.equal((await original({ ...citation, revisionId: randomUUID() })).status, 409);
          assert.equal(
            (await f.call(`/v1/workspaces/${f.other.id}/knowledge/evidence`, { method: 'POST', body: citation }))
              .status,
            404,
          );
          const credentials = (await f.db.platform.query(`SELECT credential FROM ${f.table('tf_google_integrations')}`))
            .rows;
          assert.equal(JSON.stringify(credentials).includes('owner-token'), false);
          assert.equal(JSON.stringify(credentials).includes('reader-token'), false);
        },
      );
      await t.test(
        'selected reader discovers source, refreshes own proof, and cannot manage or borrow owner proof',
        async () => {
          const shared = (await f.call('/google/sources', readerOptions)).json().items;
          assert.equal(shared.length, 1);
          assert.equal(shared[0].canManage, false);
          assert.equal(shared[0].title, 'Shared Google source');
          assert.equal(shared[0].selection, null);
          assert.equal(shared[0].counts, null);
          assert.deepEqual(shared[0].memberIds, []);
          assert.equal((await search(readerOptions)).json().hits.length, 0);
          assert.equal((await evidence(citation, readerOptions)).status, 404);
          assert.equal((await original(citation, readerOptions)).status, 404);
          const hidden = await f.call(`/google/sources/${sourceId}/documents`, readerOptions);
          assert.equal(hidden.status, 200);
          assert.deepEqual(hidden.json().items, []);
          assert.equal(
            (
              await f.call(`/google/sources/${sourceId}/manage`, {
                ...readerOptions,
                method: 'POST',
                body: { commandId: randomUUID(), action: 'pause' },
              })
            ).status,
            404,
          );
          const before = provider.calls.length;
          assert.equal((await refresh(readerOptions)).json().refreshed, 1);
          assert.ok(provider.calls.slice(before).every(call => call.authorization === 'Bearer reader-token'));
          const sharedHit = (await search(readerOptions)).json().hits[0].citation;
          assert.equal((await evidence(sharedHit, readerOptions)).status, 200);
          assert.equal((await original(sharedHit, readerOptions)).status, 200);
          const sharedDocuments = await f.call(`/google/sources/${sourceId}/documents`, readerOptions);
          assert.equal(sharedDocuments.status, 200);
          assert.equal(sharedDocuments.json().items[0].documentId, citation.documentId);
          provider.state.denyReader = true;
          assert.equal((await refresh(readerOptions)).json().unavailable, 1);
          const deniedCalls = provider.calls.length;
          assert.equal((await evidence(sharedHit, readerOptions)).status, 404);
          assert.equal((await original(sharedHit, readerOptions)).status, 404);
          assert.equal((await search(readerOptions)).json().hits.length, 0);
          assert.equal(provider.calls.length, deniedCalls, 'denial never triggers a provider or owner fallback');
          assert.equal((await evidence(citation)).status, 200);
          provider.state.denyReader = false;
          await refresh(readerOptions);
          await f.db.platform.query(
            `DELETE FROM ${f.table('tf_knowledge_google_members')} WHERE source_id=$1 AND membership_id=$2`,
            [sourceId, f.adminMembership],
          );
          assert.equal((await f.call('/google/sources', readerOptions)).json().items.length, 0);
          assert.equal((await refresh(readerOptions)).status, 404);
          assert.equal((await original(sharedHit, readerOptions)).status, 404);
          await f.db.platform.query(`INSERT INTO ${f.table('tf_knowledge_google_members')} VALUES ($1,$2)`, [
            sourceId,
            f.adminMembership,
          ]);
        },
      );
      await t.test('pause, resume, durable retry, disconnect, same-account rebind and remove', async () => {
        assert.equal((await manage('pause')).json().state, 'paused');
        assert.equal((await evidence(citation)).status, 404);
        assert.equal((await worker.due(f.workspace.id)).length, 0);
        assert.equal((await manage('resume')).json().state, 'active');
        await processSource();
        citation = (await search()).json().hits[0].citation;
        provider.state.listFailure = true;
        await manage('retry');
        await processSource();
        assert.equal((await f.call('/google/sources')).json().items[0].failure, 'rate-limited');
        provider.state.listFailure = false;
        assert.equal((await manage('retry')).status, 200);
        await processSource();
        assert.equal((await f.call('/google/sources')).json().items[0].syncState, 'ready');
        citation = (await search()).json().hits[0].citation;
        const disconnected = await f.call(`/v1/workspaces/${f.workspace.id}/google-workspace`, { method: 'DELETE' });
        assert.equal(disconnected.status, 200);
        assert.equal((await evidence(citation)).status, 404);
        assert.equal((await original(citation)).status, 404);
        assert.equal((await manage('retry')).status, 409);
        const reconnected = await connectGoogle(f);
        assert.ok(reconnected.generation > owner.generation);
        assert.equal((await manage('retry')).status, 200);
        await processSource();
        citation = (await search()).json().hits[0].citation;
        assert.equal((await evidence(citation)).status, 200);
        await connectGoogle(f, f.signed.admin, 'reader-token');
        assert.equal(
          (await evidence(citation, readerOptions)).status,
          404,
          'old reader binding cannot survive reconnect',
        );
        assert.equal((await refresh(readerOptions)).json().refreshed, 1);
        assert.equal((await evidence(citation, readerOptions)).status, 200);
        assert.notEqual(reader.accountId, owner.accountId);
        provider.state.account = 'another-account';
        await connectGoogle(f);
        assert.equal((await manage('retry')).status, 404, 'different account cannot rebind selection');
        assert.equal((await evidence(citation)).status, 404);
        assert.equal((await manage('remove')).json().state, 'removed');
        assert.equal(
          (await f.call('/google/sources')).json().items.find(item => item.sourceId === sourceId).state,
          'removed',
        );
        assert.equal((await original(citation)).status, 404);
        assert.equal((await manage('resume')).status, 409);
      });
      await t.test('Gmail selection remains private and publishes native message download', async () => {
        const commandId = randomUUID();
        const input = {
          commandId,
          selection: { kind: 'gmail', labelId: 'INBOX', after: '2026-01-01', before: '2026-02-01' },
          memberIds: [f.adminMembership],
        };
        assert.equal((await f.call('/google/sources', { method: 'POST', body: input })).status, 404);
        assert.equal(
          (await f.call('/google/sources', { method: 'POST', body: { ...input, memberIds: [] } })).status,
          200,
        );
        await processSource(commandId);
        const result = await f.call('/search', {
          method: 'POST',
          body: { kind: 'typing', query: 'delivery', filters: { sourceIds: [commandId] } },
        });
        const hit = result.json().hits[0];
        assert.ok(hit, result.bytes.toString());
        assert.equal((await evidence(hit.citation)).json().original.kind, 'google');
        assert.equal((await original(hit.citation)).json().id, 'mailone');
        assert.equal((await original(hit.citation, readerOptions)).status, 404);
      });
    } finally {
      await f?.close();
      await provider.close();
    }
  },
);
