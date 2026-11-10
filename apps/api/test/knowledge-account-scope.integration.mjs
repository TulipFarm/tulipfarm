import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDefaultKnowledge, recordDefaultKnowledgeIntent } from '@tulipfarm/knowledge';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createWorkerGoogleKnowledge } from '../../worker/dist/knowledge-google-composition.js';
import { createWorkerSlackKnowledge } from '../../worker/dist/knowledge-slack-composition.js';
import { createWorkerAtlassianKnowledge } from '../../worker/dist/knowledge-atlassian-composition.js';
import { knowledgeFixture } from './knowledge-fixture.mjs';
import { googleProviderFixture, connectGoogle } from './knowledge-google-provider-fixture.mjs';
import { slackProviderFixture } from './knowledge-slack-provider-fixture.mjs';
import { atlassianProviderFixture } from './knowledge-atlassian-provider-fixture.mjs';

for (const productToTest of ['google-drive', 'gmail', 'slack', 'jira', 'confluence']) {
  test(
    `${productToTest} account controls index eligible content, pause without data loss and narrow without old citations`,
    { timeout: 120000 },
    async t => {
      const google = await googleProviderFixture();
      const slack = slackProviderFixture();
      const atlassian = atlassianProviderFixture();
      let f;
      try {
        f = await knowledgeFixture({
          googleOptions: google.options,
          slackCorpus: slack.provider,
          atlassianCorpus: atlassian.provider,
        });
        google.state.mailDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        google.state.extraFile = true;
        google.state.extraMail = true;
        await connectGoogle(f);
        await slack.link(f, f.signed.owner, f.workspace.membershipId, 'UOWNER');
        const atl = await atlassian.link(f, f.workspace.membershipId, 'owner-aaid');
        atlassian.state.projects.set('7002', { key: 'OTHER', name: 'Other project' });
        atlassian.state.issues.set('10003', {
          ...atlassian.state.issues.get('10001'),
          key: 'OTHER-1',
          project: '7002',
        });
        const engines = {
          google: createWorkerGoogleKnowledge({
            runtime: f.runtime,
            googleService: f.googleService,
            providerFetch: google.providerFetch,
          }),
          slack: createWorkerSlackKnowledge({ runtime: f.runtime, slackCorpus: slack.provider(f.runtime) }),
          atlassian: createWorkerAtlassianKnowledge({
            runtime: f.runtime,
            atlassianCorpus: atlassian.provider(f.runtime),
          }),
        };
        const defaults = createDefaultKnowledge({ runtime: f.runtime, engines, enabled: async () => true });
        const cases = [
          ['google-drive', 'google', 'owner-account', { kind: 'drive-folder', folderId: 'root' }, 2, 1],
          [
            'gmail',
            'google',
            'owner-account',
            {
              kind: 'gmail',
              labelId: 'INBOX',
              after: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
              before: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            },
            2,
            1,
          ],
          [
            'slack',
            'slack',
            'TFIXTURE:UOWNER',
            { kind: 'channels', conversationIds: ['CGENERAL'], after: slack.after },
            2,
            1,
          ],
          [
            'jira',
            'atlassian',
            atl.accountId,
            {
              product: 'jira',
              cloudId: atlassian.cloudId,
              targets: [{ kind: 'project', id: '7001', descendants: false }],
            },
            3,
            2,
          ],
          [
            'confluence',
            'atlassian',
            atl.accountId,
            {
              product: 'confluence',
              cloudId: atlassian.cloudId,
              targets: [{ kind: 'page', id: '101', descendants: false }],
            },
            2,
            1,
          ],
        ];
        const search = async sourceId => {
          const response = await f.call('/search', {
            method: 'POST',
            body: { kind: 'typing', query: 'orchid', filters: { sourceIds: [sourceId] } },
          });
          assert.equal(response.status, 200, response.bytes.toString());
          return response.json().hits;
        };
        const sync = async (engine, sourceId) => {
          for (let i = 0; i < 10; i++) {
            const work = (await engine.due(f.workspace.id)).find(item => item.sourceId === sourceId);
            if (!work) return;
            await engine.process(work);
          }
          assert.fail('source did not finish its bounded import');
        };
        for (const [product, kind, accountKey, selection, total, selectedTotal] of cases.filter(
          item => item[0] === productToTest,
        )) {
          await t.test(product, async () => {
            const { intentId } = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
              recordDefaultKnowledgeIntent(tx, {
                product,
                membershipId: f.workspace.membershipId,
                accountKey,
                accountLabel: 'owner@example.test',
              }),
            );
            const work = (await defaults.due(f.workspace.id)).find(item => item.intentId === intentId);
            assert.ok(work);
            assert.equal((await defaults.process(work)).disposition, 'ready');
            const intent = (await defaults.list(f.workspace.id, f.signed.owner.id)).items.find(
              item => item.intentId === intentId,
            );
            const sourceId = intent.sources[0].sourceId;
            const engine = engines[kind];
            await sync(engine, sourceId);
            const hits = await search(sourceId);
            assert.equal(hits.length, total, 'connecting covers every eligible account scope');
            const before = (
              await f.db.platform.query(
                `SELECT id,observed_revision_id,lexical_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE source_id=$1 ORDER BY id`,
                [sourceId],
              )
            ).rows;
            const manage = (action, options = {}) =>
              f.call(`/defaults/${intentId}/manage`, { ...options, method: 'POST', body: { action } });
            const [{ generation }] = (
              await f.db.platform.query(
                `SELECT generation FROM ${f.table(`tf_knowledge_${kind}_sources`)} WHERE source_id=$1`,
                [sourceId],
              )
            ).rows;
            const priorWork = { workspaceId: f.workspace.id, sourceId, generation };
            assert.equal((await manage('narrow', { cookie: f.signed.admin.cookie })).status, 404);
            assert.deepEqual((await f.call('/defaults', { cookie: f.signed.admin.cookie })).json().items, []);
            assert.equal((await manage('opt-out')).status, 200);
            const calls = google.calls.length + slack.calls.length + atlassian.calls.length;
            assert.equal((await engine.process(priorWork)).disposition, 'stale');
            assert.equal(
              google.calls.length + slack.calls.length + atlassian.calls.length,
              calls,
              'paused work never calls the provider',
            );
            assert.equal(
              (await engine.due(f.workspace.id)).some(item => item.sourceId === sourceId),
              false,
            );
            assert.equal(
              (await defaults.due(f.workspace.id)).some(item => item.intentId === intentId),
              false,
            );
            assert.equal((await manage('resume')).status, 200);
            const after = (
              await f.db.platform.query(
                `SELECT id,observed_revision_id,lexical_publication_id FROM ${f.table('tf_knowledge_documents')} WHERE source_id=$1 ORDER BY id`,
                [sourceId],
              )
            ).rows;
            assert.deepEqual(after, before, 'resume keeps existing documents, revisions and publications');
            assert.equal(
              (await engine.process(priorWork)).disposition,
              'stale',
              'resume does not revive cancelled work',
            );
            assert.equal((await search(sourceId)).length, total);
            const manual = await engine.configure(f.workspace.id, f.signed.owner.id, {
              commandId: randomUUID(),
              selection,
              memberIds: [],
              accountId: accountKey,
            });
            await sync(engine, manual.sourceId);
            assert.equal((await search(manual.sourceId)).length, selectedTotal);
            assert.equal((await manage('narrow')).status, 200);
            assert.equal((await manage('narrow')).status, 200, 'replaying narrowing is safe');
            assert.deepEqual(await search(sourceId), [], 'all old automatic content is hidden');
            for (const hit of hits) {
              const evidence = await f.call('/evidence', { method: 'POST', body: hit.citation });
              assert.ok([404, 409].includes(evidence.status), evidence.bytes.toString());
            }
            assert.equal(
              (await search(manual.sourceId)).length,
              selectedTotal,
              'only selected content stays searchable',
            );
            const states = (
              await f.db.platform.query(
                `SELECT id,state FROM ${f.table('tf_knowledge_sources')} WHERE id=ANY($1::uuid[]) ORDER BY id`,
                [[sourceId, manual.sourceId]],
              )
            ).rows;
            assert.equal(
              states.find(row => row.id === manual.sourceId).state,
              'active',
              'hand-picked sources are never removed',
            );
            assert.equal(states.find(row => row.id === sourceId).state, 'removed');
            assert.equal(
              (await engine.due(f.workspace.id)).some(item => item.sourceId === sourceId),
              false,
            );
            assert.equal((await defaults.process(work)).disposition, 'stale');
          });
        }
        if (productToTest === 'confluence')
          await t.test('narrowing one account never removes another account owned by the same person', async () => {
            const second = await atlassian.link(f, f.workspace.membershipId, 'second-owner');
            const { intentId } = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
              recordDefaultKnowledgeIntent(tx, {
                product: 'confluence',
                membershipId: f.workspace.membershipId,
                accountKey: second.accountId,
                accountLabel: 'other@example.test',
              }),
            );
            const work = (await defaults.due(f.workspace.id)).find(item => item.intentId === intentId);
            assert.equal((await defaults.process(work)).disposition, 'ready');
            const first = (await defaults.list(f.workspace.id, f.signed.owner.id)).items.find(
              item => item.product === 'confluence' && item.accountKey === atl.accountId,
            );
            const response = await f.call(`/defaults/${first.intentId}/manage`, {
              method: 'POST',
              body: { action: 'narrow' },
            });
            assert.equal(response.status, 200);
            const secondIntent = (await defaults.list(f.workspace.id, f.signed.owner.id)).items.find(
              item => item.intentId === intentId,
            );
            assert.equal(secondIntent.state, 'active');
            assert.equal(secondIntent.sources[0].sourceState, 'active');
            assert.equal((await f.call(`/atlassian/sites?account=${second.accountId}`)).status, 200);
            assert.notEqual(
              (await f.call(`/atlassian/sites?account=${second.accountId}`, { cookie: f.signed.admin.cookie })).status,
              200,
            );
          });
        if (productToTest === 'confluence')
          await t.test(
            'an in-flight automatic configure cannot publish after narrowing, for every source kind',
            async () => {
              await connectGoogle(f, f.signed.admin, 'reader-token');
              await slack.link(f, f.signed.admin, f.adminMembership, 'UREADER');
              const readerAtlassian = await atlassian.link(f, f.adminMembership, 'reader-aaid');
              for (const [product, kind] of cases) {
                const accountKey =
                  kind === 'google'
                    ? 'reader-account'
                    : kind === 'slack'
                      ? 'TFIXTURE:UREADER'
                      : readerAtlassian.accountId;
                const { intentId } = await f.runtime.transaction(f.workspace.id, commonCompatibility, tx =>
                  recordDefaultKnowledgeIntent(tx, {
                    product,
                    membershipId: f.adminMembership,
                    accountKey,
                    accountLabel: 'reader@example.test',
                  }),
                );
                const engine = engines[kind];
                const configure = engine.configure;
                let release, reached;
                const held = new Promise(resolve => {
                  release = resolve;
                });
                const started = new Promise(resolve => {
                  reached = resolve;
                });
                engine.configure = async (...args) => {
                  reached();
                  await held;
                  return configure(...args);
                };
                const work = (await defaults.due(f.workspace.id)).find(item => item.intentId === intentId);
                const processing = defaults.process(work);
                try {
                  await started;
                  const response = await f.call(`/defaults/${intentId}/manage`, {
                    cookie: f.signed.admin.cookie,
                    method: 'POST',
                    body: { action: 'narrow' },
                  });
                  assert.equal(response.status, 200, response.bytes.toString());
                } finally {
                  release();
                  engine.configure = configure;
                }
                assert.equal((await processing).disposition, 'stale');
                const rows = await f.db.platform.query(
                  `SELECT s.id FROM ${f.table('tf_knowledge_sources')} s JOIN ${f.table('tf_knowledge_default_sources')} d ON d.source_id=s.id WHERE d.intent_id=$1`,
                  [intentId],
                );
                assert.deepEqual(rows.rows, [], `${product}: the stopped account never gets an automatic source`);
              }
            },
          );
      } finally {
        await f?.close();
        await google.close();
      }
    },
  );
}
