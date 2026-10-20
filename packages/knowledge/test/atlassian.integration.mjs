import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import {
  createAtlassianKnowledge,
  createSlackKnowledge,
  createKnowledgeEmbeddings,
  createKnowledgeSearch,
  createLocalKnowledge,
  AtlassianCorpusError,
} from '../dist/index.js';
import { createFiles } from '@tulipfarm/files';
import { knowledgeEmbeddingProfile as profile } from '@tulipfarm/config';

// Search has a bounded 1.95 second deadline. Retry only the storage deadline so host load cannot hide an authorization result.
async function bounded(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 4 || error?.code !== 'wait_timeout') throw error;
    }
  }
}
const CLOUD = '2a1c0b4e-7d8f-4e55-9f1a-0c3d5e6f7a8b';
const SITE = {
  id: CLOUD,
  name: 'acme',
  url: 'https://acme.atlassian.net',
  scopes: ['read:page:confluence', 'read:jira-work'],
};

test(
  'Atlassian corpus persists through restricted PostgreSQL and enforces reader-own Atlassian access per page and issue',
  { timeout: 300000 },
  async t => {
    const db = await fixture();
    let runtime;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const ws = await db.create();
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
      });
      const local = createLocalKnowledge({
        runtime,
        files: createFiles(runtime, { putIfAbsent: async () => {}, read: async () => assert.fail('unexpected read') }),
      });
      const note = await local.save(ws.id, ws.userId, {
        commandId: randomUUID(),
        documentId: randomUUID(),
        expectedRevisionId: null,
        title: 'Local orchid',
        input: { kind: 'note', text: 'orchid local survives rollout' },
      });
      for (const work of await local.due(ws.id)) assert.equal((await local.process(work)).disposition, 'ready');

      // Atlassian identities by TulipFarm user; accounts by Atlassian identity.
      const people = new Map([[ws.userId, 'owner-aaid']]);
      const accounts = new Map();
      const everyone = () => new Set(['owner-aaid', 'reader-aaid', 'admin-aaid']);
      const state = {
        pages: new Map([
          [
            '101',
            {
              title: 'Supplier handbook',
              space: '9001',
              ancestors: [],
              text: 'orchid supplier terms',
              version: 1,
              viewers: everyone(),
            },
          ],
          [
            '102',
            {
              title: 'Supplier contacts',
              space: '9001',
              ancestors: ['101'],
              text: 'orchid supplier contacts',
              version: 1,
              viewers: everyone(),
            },
          ],
          [
            '201',
            {
              title: 'Roadmap root',
              space: '9002',
              ancestors: [],
              text: 'orchid roadmap overview',
              version: 1,
              viewers: everyone(),
            },
          ],
          [
            '202',
            {
              title: 'Roadmap detail',
              space: '9002',
              ancestors: ['201'],
              text: 'orchid roadmap detail',
              version: 1,
              viewers: everyone(),
            },
          ],
          [
            '301',
            {
              title: 'Unselected page',
              space: '9002',
              ancestors: [],
              text: 'orchid outside',
              version: 1,
              viewers: everyone(),
            },
          ],
        ]),
        issues: new Map([
          [
            '10001',
            {
              key: 'OPS-1',
              project: '7001',
              summary: 'Orchid shipment',
              text: 'orchid shipment delayed',
              updated: '2026-10-01T00:00:00.000+0000',
              viewers: everyone(),
              comments: [
                { id: '1', text: 'orchid public comment', restricted: false },
                { id: '2', text: 'secret salary comment', restricted: true },
              ],
            },
          ],
          [
            '10002',
            {
              key: 'OPS-2',
              project: '7001',
              summary: 'Orchid security incident',
              text: 'orchid incident restricted',
              updated: '2026-10-01T00:00:00.000+0000',
              viewers: new Set(['owner-aaid']),
              comments: [],
            },
          ],
        ]),
        omit: false,
        listError: null,
        accessError: null,
        accessGate: null,
        readError: null,
      };
      const accessCalls = [];
      const account = userId => accounts.get(people.get(userId));
      const generation = async accountId =>
        (await db.platform.query(`SELECT generation FROM ${table('tf_atlassian_accounts')} WHERE id=$1`, [accountId]))
          .rows[0].generation;
      const bindingFor = userId => ({
        accountId: account(userId),
        atlassianAccountId: people.get(userId),
        cloudId: CLOUD,
      });
      const pageIn = (target, id) => {
        const page = state.pages.get(id);
        if (!page) return false;
        return target.kind === 'space'
          ? page.space === target.id
          : id === target.id || (target.descendants && page.ancestors.includes(target.id));
      };
      const observation = (product, id) =>
        product === 'confluence'
          ? {
              nativeId: `page:${id}`,
              itemId: id,
              title: state.pages.get(id).title,
              canonicalURL: `https://acme.atlassian.net/wiki/pages/${id}`,
              sourceRevision: String(state.pages.get(id).version),
              coverage: state.pages.get(id).coverage ?? 'supported',
            }
          : {
              nativeId: `issue:${id}`,
              itemId: id,
              title: `${state.issues.get(id).key}: ${state.issues.get(id).summary}`,
              canonicalURL: `https://acme.atlassian.net/browse/${state.issues.get(id).key}`,
              sourceRevision: state.issues.get(id).updated,
              coverage: 'supported',
            };
      const markdown = (product, id) => {
        if (product === 'confluence')
          return `# ${state.pages.get(id).title}\n\nVersion ${state.pages.get(id).version} by owner-aaid.\n\n${state.pages.get(id).text}\n`;
        const issue = state.issues.get(id);
        return `# ${issue.key}: ${issue.summary}\n\n${issue.text}\n${issue.comments
          .filter(c => !c.restricted)
          .map(c => `\n## Comment ${c.id}\n\n${c.text}\n`)
          .join('')}`;
      };
      const provider = {
        sites: async () => ({ items: [{ cloudId: CLOUD, name: 'acme', url: 'https://acme.atlassian.net' }] }),
        discover: async (_w, userId) => ({ binding: bindingFor(userId), items: [], nextCursor: null }),
        inspectSelection: async (_w, userId, selection) => ({
          binding: bindingFor(userId),
          title: 'Selected Atlassian',
          targets: selection.targets.map(target => ({
            kind: target.kind,
            id: target.id,
            key: target.kind === 'project' ? 'OPS' : target.kind === 'space' ? 'SUP' : null,
            title: `${target.kind} ${target.id}`,
          })),
        }),
        access: async (_w, userId, b, product, ids) => {
          assert.deepEqual(b, bindingFor(userId), 'access always uses the reader own account');
          accessCalls.push({ userId, ids });
          const accessedAt = new Date().toISOString();
          if (state.accessGate) await state.accessGate(userId);
          if (state.accessError) {
            const error = state.accessError(userId);
            if (error) throw error;
          }
          const items = product === 'confluence' ? state.pages : state.issues;
          return {
            accessedAt,
            accountGeneration: await generation(b.accountId),
            visible: ids.filter(id => items.get(id)?.viewers.has(b.atlassianAccountId)),
          };
        },
        list: async (_w, userId, b, target) => {
          if (state.listError) {
            const error = state.listError(target);
            if (error) throw error;
          }
          const accessedAt = new Date().toISOString();
          const product = target.kind === 'project' ? 'jira' : 'confluence';
          const ids = state.omit
            ? []
            : product === 'jira'
              ? [...state.issues]
                  .filter(([, i]) => i.project === target.id && i.viewers.has(b.atlassianAccountId))
                  .map(([id]) => id)
              : [...state.pages.keys()].filter(
                  id => pageIn(target, id) && state.pages.get(id).viewers.has(b.atlassianAccountId),
                );
          return {
            accessedAt,
            accountGeneration: await generation(b.accountId),
            observations: ids.map(id => observation(product, id)),
            nextCursor: null,
          };
        },
        read: async (_w, _u, b, target, id) => {
          if (state.readError) {
            const error = state.readError(id);
            if (error) throw error;
          }
          const product = target.kind === 'project' ? 'jira' : 'confluence';
          const items = product === 'confluence' ? state.pages : state.issues;
          if (!items.get(id)?.viewers.has(b.atlassianAccountId)) throw new AtlassianCorpusError('not-found');
          if (product === 'confluence' ? !pageIn(target, id) : state.issues.get(id).project !== target.id)
            throw new AtlassianCorpusError('outside-selection');
          return {
            ...observation(product, id),
            markdown: markdown(product, id),
            accessedAt: new Date().toISOString(),
            accountGeneration: await generation(b.accountId),
          };
        },
      };
      const atlassian = createAtlassianKnowledge({ runtime, provider });
      const disabled = createKnowledgeEmbeddings({ runtime, atlassian, config: { kind: 'disabled' } });
      const search = createKnowledgeSearch({ runtime, embeddings: disabled, atlassian });
      const reader = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        reader.membershipId,
        reader.userId,
      ]);
      const admin = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
        admin.membershipId,
        admin.userId,
      ]);
      const outsider = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        outsider.membershipId,
        outsider.userId,
      ]);
      people.set(reader.userId, 'reader-aaid');
      people.set(admin.userId, 'admin-aaid');
      for (const [userId, membershipId] of [
        [ws.userId, ws.membershipId],
        [reader.userId, reader.membershipId],
        [admin.userId, admin.membershipId],
      ]) {
        const id = randomUUID();
        accounts.set(people.get(userId), id);
        await db.platform.query(
          `INSERT INTO ${table('tf_atlassian_accounts')} (id,protocol,ownership,owner_membership_id,state,config_hash,identity,resources,scopes,credential,expires_at)
        VALUES ($1,'atlassian-rest','personal',$2,'active','hash',$3,$4,$5,'{}',now()+interval '1 hour')`,
          [
            id,
            membershipId,
            { id: people.get(userId), label: userId, qualification: 'verified' },
            JSON.stringify([SITE]),
            ['read:me', 'read:page:confluence', 'read:jira-work'],
          ],
        );
      }
      const ownerActor = { userId: ws.userId };
      const after = sourceId =>
        db.platform
          .query(`SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL`, [
            sourceId,
          ])
          .then(r => r.rows[0].n);
      async function sync(id) {
        for (let i = 0; i < 20; i++) {
          await db.platform.query(
            `UPDATE ${table('atlassian_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
            [id],
          );
          const work = (await atlassian.due(ws.id)).find(w => w.sourceId === id);
          if (!work) return;
          if ((await atlassian.process(work)).disposition === 'ready') return;
        }
        assert.fail('bounded sync did not complete');
      }
      const input = {
        commandId: randomUUID(),
        selection: {
          product: 'confluence',
          cloudId: CLOUD,
          targets: [
            { kind: 'page', id: '201', descendants: true },
            { kind: 'space', id: '9001', descendants: false },
          ],
        },
        memberIds: [reader.membershipId],
      };
      const source = await atlassian.configure(ws.id, ws.userId, input);
      const sourceId = source.sourceId;
      const query = (who, text = 'orchid', id = sourceId) =>
        bounded(() =>
          search.search(ws.id, who.userId, {
            kind: 'typing',
            query: text,
            filters: { kinds: ['confluence', 'jira'], sourceIds: [id] },
          }),
        );
      const titles = async (who, text, id) => (await query(who, text, id)).hits.map(h => h.title).sort();

      await t.test(
        'configure validates audience and selection, replays idempotently, and publishes pages with owner proof',
        async () => {
          assert.deepEqual(source.memberIds, [reader.membershipId, ws.membershipId].sort());
          assert.equal(source.product, 'confluence');
          assert.equal((await atlassian.configure(ws.id, ws.userId, input)).sourceId, sourceId);
          await assert.rejects(
            atlassian.configure(ws.id, ws.userId, { ...input, memberIds: [] }),
            error => error.code === 'conflict',
          );
          await assert.rejects(
            atlassian.configure(ws.id, ws.userId, {
              ...input,
              commandId: randomUUID(),
              selection: { ...input.selection, targets: [{ kind: 'project', id: '7001', descendants: false }] },
            }),
            /product/i,
          );
          await assert.rejects(
            atlassian.configure(ws.id, outsider.userId, { ...input, commandId: randomUUID() }),
            error => error.code === 'stale-integration' || error instanceof TypeError || error instanceof AccessDenied,
          );
          await sync(sourceId);
          const listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(listed.syncState, 'ready');
          assert.deepEqual(
            listed.counts,
            { total: 4, ready: 4, failed: 0 },
            JSON.stringify((await db.platform.query(`SELECT native_id,failure FROM ${table('atlassian_items')}`)).rows),
          );
          assert.deepEqual(
            listed.targets.map(c => [c.kind, c.id, c.state, c.descendants]),
            [
              ['page', '201', 'active', true],
              ['space', '9001', 'active', false],
            ],
          );
          const shared = (await atlassian.list(ws.id, reader.userId)).items.find(s => s.sourceId === sourceId);
          assert.equal(shared.canManage, false);
          assert.equal(shared.selection, null);
          assert.equal(shared.targets, null);
          assert.equal(shared.title, 'Shared Confluence source');
          assert.deepEqual(await titles(ownerActor), [
            'Roadmap detail',
            'Roadmap root',
            'Supplier contacts',
            'Supplier handbook',
          ]);
          await assert.rejects(
            runtime.transaction(ws.id, commonCompatibility, tx =>
              tx.client.query(
                `UPDATE ${qualified(tx.schema, 'tf_knowledge_atlassian_originals')} SET markdown='tampered'`,
              ),
            ),
            error => error.code === '42501',
          );
        },
      );

      await t.test(
        'selected readers need their own current page access; admins and unlinked members get nothing',
        async () => {
          const denied = await query(reader);
          assert.deepEqual(denied.hits, []);
          assert.equal(denied.coverage, 'partial');
          assert.deepEqual(await atlassian.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 4,
            unavailable: 0,
            bounded: true,
          });
          assert.equal(
            accessCalls.filter(c => c.userId === reader.userId).length,
            1,
            'one batched check covers every selected page',
          );
          const shared = await query(reader);
          assert.equal(shared.hits.length, 4);
          const expiry = (
            await db.platform.query(
              `SELECT min(expires_at) e FROM ${table('atlassian_access')} WHERE membership_id=$1`,
              [reader.membershipId],
            )
          ).rows[0].e;
          assert.ok(Date.parse(shared.validUntil) <= expiry.getTime());
          assert.ok(expiry.getTime() <= Date.now() + 300000);
          const evidence = await atlassian.evidence(ws.id, reader.userId, shared.hits[0].citation);
          assert.equal(evidence.original.kind, 'confluence');
          assert.match(evidence.text, /orchid/);
          assert.match(
            (
              await atlassian.original(
                ws.id,
                reader.userId,
                shared.hits[0].citation.documentId,
                shared.hits[0].citation.revisionId,
              )
            ).bytes.toString(),
            /orchid/,
          );
          assert.equal((await atlassian.listDocuments(ws.id, reader.userId, sourceId)).items.length, 4);
          await assert.rejects(
            atlassian.manage(ws.id, reader.userId, sourceId, { commandId: randomUUID(), action: 'pause' }),
            AccessDenied,
          );
          assert.deepEqual((await query(admin)).hits, []);
          await assert.rejects(atlassian.refresh(ws.id, admin.userId, sourceId), AccessDenied);
          assert.equal((await atlassian.list(ws.id, admin.userId)).items.length, 0);
        },
      );

      await t.test(
        'a page restriction, including one inherited from a parent, removes only that reader on that page',
        async () => {
          for (const id of ['201', '202']) state.pages.get(id).viewers.delete('reader-aaid');
          assert.deepEqual(await atlassian.refresh(ws.id, reader.userId, sourceId), {
            refreshed: 2,
            unavailable: 2,
            bounded: true,
          });
          assert.deepEqual(await titles(reader), ['Supplier contacts', 'Supplier handbook']);
          assert.equal((await query(ownerActor)).hits.length, 4, 'the owner is unaffected');
          for (const id of ['201', '202']) state.pages.get(id).viewers.add('reader-aaid');
          await atlassian.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 4);
        },
      );

      await t.test('an in-flight check that started before a later denial cannot renew access', async () => {
        let release, entered;
        const started = new Promise(resolve => {
          entered = resolve;
        });
        const gate = new Promise(resolve => {
          release = resolve;
        });
        state.accessGate = async userId => {
          if (userId === reader.userId) {
            state.accessGate = null;
            entered();
            await gate;
          }
        };
        const inFlight = atlassian.refresh(ws.id, reader.userId, sourceId);
        await started;
        state.pages.get('101').viewers.delete('reader-aaid');
        await atlassian.refresh(ws.id, reader.userId, sourceId);
        state.pages.get('101').viewers.add('reader-aaid');
        release();
        await inFlight;
        assert.ok(
          !(await titles(reader)).includes('Supplier handbook'),
          'the earlier check is fenced by the later denial',
        );
        await atlassian.refresh(ws.id, reader.userId, sourceId);
        assert.equal((await query(reader)).hits.length, 4);
      });

      await t.test('expiry is bounded and failed checks never renew', async () => {
        await db.platform.query(
          `UPDATE ${table('access_proofs')} SET acl_checked_at=now()-interval '6 minutes',membership_checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1`,
          [reader.membershipId],
        );
        await db.platform.query(
          `UPDATE ${table('atlassian_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const expired = await query(reader);
        assert.deepEqual(expired.hits, []);
        assert.equal(expired.coverage, 'partial');
        state.accessError = userId => (userId === reader.userId ? new AtlassianCorpusError('transient') : null);
        assert.deepEqual(await atlassian.refresh(ws.id, reader.userId, sourceId), {
          refreshed: 0,
          unavailable: 4,
          bounded: true,
        });
        state.accessError = userId =>
          userId === reader.userId ? new AtlassianCorpusError('rate-limited', 60000) : null;
        assert.deepEqual(await atlassian.refresh(ws.id, reader.userId, sourceId), {
          refreshed: 0,
          unavailable: 4,
          bounded: true,
        });
        state.accessError = null;
        assert.deepEqual((await query(reader)).hits, []);
        const latest = (
          await db.platform.query(`SELECT max(expires_at) e FROM ${table('atlassian_access')} WHERE membership_id=$1`, [
            reader.membershipId,
          ])
        ).rows[0].e;
        assert.ok(latest === null || latest.getTime() < Date.now());
        await atlassian.refresh(ws.id, reader.userId, sourceId);
        assert.equal((await query(reader)).hits.length, 4);
      });

      await t.test(
        'local disconnect, token generation change, membership removal and audience removal revoke immediately',
        async () => {
          const calls = accessCalls.length;
          const readerAccount = account(reader.userId);
          await db.platform.query(
            `UPDATE ${table('tf_atlassian_accounts')} SET state='disconnected',generation=generation+1,credential=NULL,expires_at=NULL WHERE id=$1`,
            [readerAccount],
          );
          assert.deepEqual((await query(reader)).hits, []);
          await assert.rejects(atlassian.evidence(ws.id, reader.userId, (await query(ownerActor)).hits[0].citation));
          await db.platform.query(
            `UPDATE ${table('tf_atlassian_accounts')} SET state='active',credential='{}',expires_at=now()+interval '1 hour' WHERE id=$1`,
            [readerAccount],
          );
          assert.deepEqual(
            (await query(reader)).hits,
            [],
            'reconnecting requires a fresh check with the new account generation',
          );
          await atlassian.refresh(ws.id, reader.userId, sourceId);
          assert.equal((await query(reader)).hits.length, 4);
          await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET generation=generation+1 WHERE id=$1`, [
            readerAccount,
          ]);
          assert.deepEqual((await query(reader)).hits, [], 'a token refresh starts a new account generation');
          await atlassian.refresh(ws.id, reader.userId, sourceId);
          const afterRefresh = accessCalls.length;
          assert.equal((await query(reader)).hits.length, 4);
          await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET resources='[]' WHERE id=$1`, [
            readerAccount,
          ]);
          assert.deepEqual((await query(reader)).hits, [], 'losing the site removes access');
          await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET resources=$2 WHERE id=$1`, [
            readerAccount,
            JSON.stringify([SITE]),
          ]);
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
            reader.membershipId,
          ]);
          await assert.rejects(query(reader));
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=NULL WHERE id=$1`, [
            reader.membershipId,
          ]);
          assert.equal((await query(reader)).hits.length, 4);
          await db.platform.query(`DELETE FROM ${table('atlassian_members')} WHERE source_id=$1 AND membership_id=$2`, [
            sourceId,
            reader.membershipId,
          ]);
          assert.deepEqual((await query(reader)).hits, []);
          await db.platform.query(`INSERT INTO ${table('atlassian_members')} VALUES ($1,$2)`, [
            sourceId,
            reader.membershipId,
          ]);
          const ownerAccount = account(ws.userId);
          await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET state='disconnected' WHERE id=$1`, [
            ownerAccount,
          ]);
          assert.deepEqual((await query(reader)).hits, [], 'the owner disconnecting stops every reader');
          assert.deepEqual((await query(ownerActor)).hits, []);
          await db.platform.query(`UPDATE ${table('tf_atlassian_accounts')} SET state='active' WHERE id=$1`, [
            ownerAccount,
          ]);
          assert.equal(accessCalls.length, afterRefresh, 'local revocation needs no provider call');
          assert.ok(afterRefresh > calls);
          await atlassian.refresh(ws.id, ws.userId, sourceId);
        },
      );

      await t.test('partial or failed listings never tombstone; edits, deletions and moves reconcile', async () => {
        state.listError = () => new AtlassianCorpusError('rate-limited', 120000);
        await db.platform.query(
          `UPDATE ${table('atlassian_sources')} SET next_attempt_at=clock_timestamp() WHERE source_id=$1`,
          [sourceId],
        );
        await atlassian.process((await atlassian.due(ws.id)).find(w => w.sourceId === sourceId));
        state.listError = null;
        const failed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(failed.failure, 'rate-limited');
        assert.ok(Date.parse(failed.nextAttemptAt) > Date.now() + 110000);
        assert.equal(await after(sourceId), 4);
        state.omit = true;
        await sync(sourceId);
        state.omit = false;
        assert.equal(await after(sourceId), 4, 'an empty listing alone never tombstones');
        Object.assign(state.pages.get('101'), { text: 'replacement lilac terms', version: 2 });
        await sync(sourceId);
        assert.deepEqual(await titles(ownerActor, 'lilac'), ['Supplier handbook']);
        assert.deepEqual(
          (await query(ownerActor, 'terms')).hits.map(h => h.title),
          ['Supplier handbook'],
        );
        assert.equal(
          (await query(ownerActor, 'orchid')).hits.some(h => h.title === 'Supplier handbook'),
          false,
        );
        state.pages.get('202').ancestors = [];
        state.omit = true;
        await sync(sourceId);
        state.omit = false;
        assert.equal(
          await after(sourceId),
          3,
          'a page moved out of the selected subtree is removed after an exact read',
        );
        state.pages.delete('102');
        state.omit = true;
        await sync(sourceId);
        state.omit = false;
        assert.equal(await after(sourceId), 2);
        assert.deepEqual(await titles(ownerActor), ['Roadmap root']);
        state.pages.set('102', {
          title: 'Supplier contacts',
          space: '9001',
          ancestors: ['101'],
          text: 'orchid supplier contacts',
          version: 5,
          viewers: everyone(),
        });
        state.pages.get('202').ancestors = ['201'];
        await sync(sourceId);
        assert.equal(await after(sourceId), 4);
      });

      await t.test('one inaccessible page or space is isolated without failing or revoking the source', async () => {
        state.readError = id => (id === '202' ? new AtlassianCorpusError('transient') : null);
        Object.assign(state.pages.get('202'), { version: 6, text: 'orchid roadmap detail updated' });
        await sync(sourceId);
        let listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(listed.syncState, 'ready');
        assert.equal(listed.failure, null);
        assert.equal(listed.counts.failed, 1);
        state.readError = null;
        await sync(sourceId);
        listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(listed.counts.failed, 0);
        state.pages.get('101').viewers.delete('owner-aaid');
        state.omit = true;
        await sync(sourceId);
        state.omit = false;
        assert.deepEqual(
          (await query(ownerActor, 'terms')).hits,
          [],
          'a page the owner can no longer read is withdrawn',
        );
        assert.equal((await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId).state, 'active');
        state.pages.get('101').viewers.add('owner-aaid');
        state.listError = target => (target.kind === 'space' ? new AtlassianCorpusError('forbidden') : null);
        await sync(sourceId);
        listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(listed.state, 'active');
        assert.equal(listed.syncState, 'ready');
        assert.deepEqual(
          listed.targets.find(c => c.kind === 'space'),
          {
            kind: 'space',
            id: '9001',
            key: 'SUP',
            title: 'space 9001',
            descendants: false,
            state: 'unavailable',
            failure: 'forbidden',
          },
        );
        assert.deepEqual(
          await titles(ownerActor),
          ['Roadmap detail', 'Roadmap root'],
          'blocked space content is retained but unreadable',
        );
        assert.equal((await query(ownerActor)).coverage, 'partial');
        state.listError = target => (target.kind === 'space' ? new AtlassianCorpusError('invalid-selection') : null);
        await sync(sourceId);
        listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(listed.syncState, 'ready', 'a rejected target query must not stall the whole source');
        assert.equal(listed.targets.find(c => c.kind === 'space').failure, 'invalid-selection');
        state.listError = null;
        await sync(sourceId);
        await atlassian.refresh(ws.id, ws.userId, sourceId);
        listed = (await atlassian.list(ws.id, ws.userId)).items.find(s => s.sourceId === sourceId);
        assert.equal(listed.targets.find(c => c.kind === 'space').state, 'active');
        assert.equal((await query(ownerActor)).hits.length, 3);
        assert.equal((await query(ownerActor, 'terms')).hits.length, 1);
      });

      await t.test('Jira projects honor issue security and publish only unrestricted comments', async () => {
        const jira = await atlassian.configure(ws.id, ws.userId, {
          commandId: randomUUID(),
          selection: {
            product: 'jira',
            cloudId: CLOUD,
            targets: [{ kind: 'project', id: '7001', descendants: false }],
          },
          memberIds: [reader.membershipId],
        });
        await sync(jira.sourceId);
        assert.deepEqual(await titles(ownerActor, 'orchid', jira.sourceId), [
          'OPS-1: Orchid shipment',
          'OPS-2: Orchid security incident',
        ]);
        assert.deepEqual(await atlassian.refresh(ws.id, reader.userId, jira.sourceId), {
          refreshed: 1,
          unavailable: 1,
          bounded: true,
        });
        const hits = (await query(reader, 'orchid', jira.sourceId)).hits;
        assert.deepEqual(
          hits.map(h => h.title),
          ['OPS-1: Orchid shipment'],
          'an issue behind a security level stays hidden from the reader',
        );
        const original = (
          await atlassian.original(ws.id, reader.userId, hits[0].citation.documentId, hits[0].citation.revisionId)
        ).bytes.toString();
        assert.match(original, /orchid public comment/);
        assert.doesNotMatch(original, /salary/);
        assert.deepEqual((await query(ownerActor, 'salary', jira.sourceId)).hits, []);
        assert.equal((await atlassian.evidence(ws.id, reader.userId, hits[0].citation)).original.kind, 'jira');
        await assert.rejects(
          atlassian.status(
            ws.id,
            reader.userId,
            (await query(ownerActor, 'incident', jira.sourceId)).hits[0].citation.documentId,
          ),
        );
        state.issues.get('10001').project = '7002';
        state.omit = true;
        await sync(jira.sourceId);
        state.omit = false;
        assert.deepEqual(
          await titles(ownerActor, 'orchid', jira.sourceId),
          ['OPS-2: Orchid security incident'],
          'an issue moved to another project leaves the source',
        );
      });

      await t.test('hybrid embeddings use the same Atlassian eligibility', async () => {
        await db.platform.query(
          `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
        );
        const embeddings = createKnowledgeEmbeddings({
          runtime,
          atlassian,
          config: { kind: 'enabled', endpoint: 'https://example.services.ai.azure.com/', apiKey: 'fixture', profile },
          capacity: async () => true,
          provider: async () => ({
            dispatch: 'dispatched',
            requestId: 'atlassian-test',
            inputTokensUpperBound: 1,
            usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
            result: {
              kind: 'success',
              model: profile.model,
              vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
            },
          }),
        });
        await atlassian.refresh(ws.id, ws.userId, sourceId);
        for (let i = 0; i < 30; i++) {
          for (const work of await embeddings.due(ws.id)) await embeddings.process(work);
          if (
            (
              await db.platform.query(
                `SELECT count(*)::int n FROM ${table('documents')} WHERE source_id=$1 AND tombstoned_at IS NULL AND vector_publication_id IS NOT NULL`,
                [sourceId],
              )
            ).rows[0].n === 4
          )
            break;
          await atlassian.refresh(ws.id, ws.userId, sourceId);
        }
        const hybrid = createKnowledgeSearch({ runtime, embeddings, atlassian });
        let owner;
        for (let attempt = 0; attempt < 5; attempt++) {
          owner = await bounded(() =>
            hybrid.search(ws.id, ws.userId, {
              kind: 'submitted',
              commandId: randomUUID(),
              query: 'orchid',
              filters: { kinds: ['confluence'], sourceIds: [sourceId] },
            }),
          );
          if (owner.reason !== 'deadline') break;
        }
        assert.equal(owner.mode, 'hybrid', JSON.stringify({ reason: owner.reason, coverage: owner.coverage }));
        assert.ok(owner.hits.length >= 3);
        await db.platform.query(
          `UPDATE ${table('atlassian_access')} SET observed_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE membership_id=$1 AND binding IS NOT NULL`,
          [reader.membershipId],
        );
        const denied = await bounded(() =>
          hybrid.search(ws.id, reader.userId, {
            kind: 'submitted',
            commandId: randomUUID(),
            query: 'orchid',
            filters: { kinds: ['confluence'], sourceIds: [sourceId] },
          }),
        );
        assert.deepEqual(denied.hits, []);
        await hybrid.close();
      });

      await t.test(
        'an oversized page replacement reports its failure and offers the retained original only as an earlier version',
        async () => {
          const [imported] = (await query(ownerActor, 'overview')).hits;
          const { documentId, revisionId } = imported.citation;
          Object.assign(state.pages.get('201'), {
            text: 'orchid roadmap overview with a huge appendix',
            version: 7,
            coverage: 'item-too-large',
          });
          await sync(sourceId);
          const replaced = {
            documentId,
            revisionId,
            title: 'Roadmap root',
            publicationId: null,
            parsing: 'failed',
            embedding: 'pending',
            failure: 'item-too-large',
            historical: true,
          };
          assert.deepEqual(
            (await atlassian.listDocuments(ws.id, ws.userId, sourceId)).items.find(
              item => item.documentId === documentId,
            ),
            { ...replaced, canRetry: false },
          );
          assert.deepEqual(await atlassian.status(ws.id, ws.userId, documentId), replaced);
          assert.match(
            (await atlassian.original(ws.id, ws.userId, documentId, revisionId)).bytes.toString(),
            /^orchid roadmap overview$/m,
          );
          assert.deepEqual((await query(ownerActor, 'overview')).hits, []);
          await assert.rejects(atlassian.evidence(ws.id, ws.userId, imported.citation));
          assert.deepEqual(
            (await atlassian.listDocuments(ws.id, ws.userId, sourceId)).items
              .filter(item => item.documentId !== documentId)
              .map(item => [item.parsing, item.failure, item.historical]),
            [
              ['ready', null, false],
              ['ready', null, false],
              ['ready', null, false],
            ],
          );
          Object.assign(state.pages.get('201'), {
            text: 'orchid roadmap overview condensed',
            version: 8,
            coverage: 'supported',
          });
          await sync(sourceId);
          const current = await atlassian.status(ws.id, ws.userId, documentId);
          assert.deepEqual([current.parsing, current.failure, current.historical], ['ready', null, false]);
          assert.equal((await query(ownerActor, 'condensed')).hits[0].citation.documentId, documentId);
        },
      );

      await t.test('removal is idempotent and the Slack adapter still composes', async () => {
        const slack = createSlackKnowledge({
          runtime,
          provider: {
            discover: async () => assert.fail(),
            inspectSelection: async () => assert.fail(),
            access: async () => assert.fail(),
            list: async () => assert.fail(),
            read: async () => assert.fail(),
          },
        });
        const combined = createKnowledgeSearch({
          runtime,
          slack,
          atlassian,
          embeddings: createKnowledgeEmbeddings({ runtime, slack, atlassian, config: { kind: 'disabled' } }),
        });
        await atlassian.refresh(ws.id, ws.userId, sourceId);
        assert.ok(
          (await bounded(() => combined.search(ws.id, ws.userId, { kind: 'typing', query: 'orchid' }))).hits.some(
            h => h.citation.documentId === note.documentId,
          ),
        );
        const removal = { commandId: randomUUID(), action: 'remove' };
        await atlassian.manage(ws.id, ws.userId, sourceId, removal);
        await atlassian.manage(ws.id, ws.userId, sourceId, removal);
        assert.deepEqual(
          (
            await bounded(() =>
              combined.search(ws.id, ws.userId, {
                kind: 'typing',
                query: 'roadmap',
                filters: { kinds: ['confluence'] },
              }),
            )
          ).hits,
          [],
        );
        await combined.close();
      });
      await search.close();
    } finally {
      await runtime?.close();
      await db.close();
    }
  },
);
