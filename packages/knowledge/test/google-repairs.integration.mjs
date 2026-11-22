import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import { createGoogleKnowledge } from '../dist/index.js';
import { GoogleCorpusError } from '@tulipfarm/google-workspace/corpus';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

test('Google review repairs with restricted PostgreSQL', async t => {
  const db = await fixture();
  const runtimes = [];
  try {
    await loadPlatformBaseline(db.platform);
    const stream = await workspaceTableMigrations();
    async function setup({ malformed = false, list } = {}) {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      const runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(ws) }),
      });
      runtimes.push(runtime);
      const reader = { userId: randomUUID(), membershipId: randomUUID() };
      await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        reader.membershipId,
        reader.userId,
      ]);
      const binding = {
        integrationId: randomUUID(),
        accountId: 'owner-account',
        generation: 1,
        requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      };
      for (const [userId, membershipId, b] of [
        [ws.userId, ws.membershipId, binding],
        [reader.userId, reader.membershipId, { ...binding, integrationId: randomUUID(), accountId: 'reader-account' }],
      ]) {
        await db.platform.query(
          `INSERT INTO ${table('tf_google_integrations')} (id,user_id,membership_id,generation,status,account_id,email,scopes,credential) VALUES ($1,$2,$3,$4,'connected',$5,'fixture@example.test',$6,'{}')`,
          [b.integrationId, userId, membershipId, b.generation, b.accountId, b.requiredScopes],
        );
      }
      const observation = () => ({
        nativeId: 'one',
        title: 'Confidential acquisition',
        canonicalURL: 'https://drive.google.com/file/d/one',
        sourceRevision: '1',
        accessedAt: new Date().toISOString(),
        kind: 'file',
        mediaType: malformed ? 'application/pdf' : 'text/plain',
        parentIds: ['root'],
        coverage: 'supported',
      });
      let check = async () => observation();
      const provider = {
        discover: async () => ({ binding, items: [], nextCursor: null }),
        inspectSelection: async (_w, _u, selection) => ({ binding, selection, title: 'Confidential folder' }),
        list: list
          ? (...args) => list(observation, ...args)
          : async () => ({ observations: [observation()], nextCursor: null }),
        check: (...args) => check(...args),
        read: async () => {
          const o = observation();
          return {
            ...o,
            bytes: Buffer.from(malformed ? '%PDF-1.7\nbroken' : 'private supplier terms'),
            filename: malformed ? 'one.pdf' : 'one.txt',
            normalizedContent: null,
            metadataBefore: o,
            metadataAfter: o,
          };
        },
      };
      const google = createGoogleKnowledge({ runtime, provider });
      const input = {
        commandId: randomUUID(),
        selection: { kind: 'drive-folder', folderId: 'root' },
        memberIds: [reader.membershipId],
      };
      const source = await google.configure(ws.id, ws.userId, input);
      for (let i = 0; i < 2; i++) {
        const work = (await google.due(ws.id)).find(w => w.sourceId === source.sourceId);
        assert.ok(work);
        await google.process(work);
      }
      const doc = (await db.platform.query(`SELECT * FROM ${table('documents')} WHERE source_id=$1`, [source.sourceId]))
        .rows[0];
      const manage = action => google.manage(ws.id, ws.userId, source.sourceId, { commandId: randomUUID(), action });
      const renew = () => google.refresh(ws.id, ws.userId, source.sourceId);
      const eligible = membershipId =>
        db.platform.query(`SELECT * FROM ${table('google_eligible')} WHERE document_id=$1 AND membership_id=$2`, [
          doc.id,
          membershipId,
        ]);
      await db.platform.query(
        `UPDATE ${table('tf_credit_account')} SET available=10000000000000,granted=10000000000000`,
      );
      return {
        ws,
        table,
        runtime,
        reader,
        binding,
        google,
        input,
        source,
        doc,
        manage,
        renew,
        eligible,
        observation,
        setCheck: fn => {
          check = fn;
        },
      };
    }
    for (const managerDenial of [false, true])
      await t.test(`${managerDenial ? 'manager' : 'reader'} denial fences older reader success`, async () => {
        const w = await setup();
        await w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId);
        const entered = deferred(),
          release = deferred();
        let hold = true;
        w.setCheck(async (_ws, user) => {
          if (hold && user === w.reader.userId) {
            hold = false;
            const old = w.observation();
            entered.resolve();
            await release.promise;
            return old;
          }
          throw new GoogleCorpusError('forbidden');
        });
        const pending = w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId);
        await entered.promise;
        await w.google.refresh(w.ws.id, managerDenial ? w.ws.userId : w.reader.userId, w.source.sourceId);
        assert.equal((await w.eligible(w.reader.membershipId)).rowCount, 0);
        release.resolve();
        await pending;
        assert.equal((await w.eligible(w.reader.membershipId)).rowCount, 0, 'older success resurrected denied access');
        w.setCheck(async () => w.observation());
        assert.equal((await w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId)).refreshed, 1);
      });
    await t.test('a queued subfolder moved out of the selection is skipped without failing the source', async () => {
      const listed = [];
      const w = await setup({
        list: async (observation, _w, _u, _b, _s, cursor) => {
          listed.push(cursor?.folderId ?? 'root');
          if (cursor?.folderId === 'moved') throw new GoogleCorpusError('outside-selection');
          return {
            observations: [
              observation(),
              {
                ...observation(),
                nativeId: 'moved',
                title: 'Moved folder',
                kind: 'folder',
                mediaType: 'application/vnd.google-apps.folder',
                coverage: 'folder',
              },
            ],
            nextCursor: null,
          };
        },
      });
      const epoch = async () =>
        (await db.platform.query(`SELECT access_epoch FROM ${w.table('sources')} WHERE id=$1`, [w.source.sourceId]))
          .rows[0].access_epoch;
      const before = await epoch();
      for (let i = 0; i < 4; i++) {
        const work = (await w.google.due(w.ws.id)).find(x => x.sourceId === w.source.sourceId);
        if (!work) break;
        await w.google.process(work);
      }
      const state = (
        await db.platform.query(`SELECT sync_state,failure FROM ${w.table('google_sources')} WHERE source_id=$1`, [
          w.source.sourceId,
        ])
      ).rows[0];
      assert.deepEqual(listed.slice(0, 2), ['root', 'moved']);
      assert.deepEqual(state, { sync_state: 'ready', failure: null });
      assert.equal(await epoch(), before, 'a moved subfolder must not revoke the source');
      await w.renew();
      assert.equal((await w.eligible(w.ws.membershipId)).rowCount, 1);
    });
    await t.test('older successful observation cannot overwrite a newer proof', async () => {
      const w = await setup();
      const entered = deferred(),
        release = deferred();
      let first = true;
      w.setCheck(async () => {
        const o = w.observation();
        if (first) {
          first = false;
          o.accessedAt = new Date(Date.now() - 10000).toISOString();
          entered.resolve();
          await release.promise;
        }
        return o;
      });
      const pending = w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId);
      await entered.promise;
      await w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId);
      const before = (await w.eligible(w.reader.membershipId)).rows[0].expires_at;
      release.resolve();
      await pending;
      assert.deepEqual((await w.eligible(w.reader.membershipId)).rows[0].expires_at, before);
    });
    await t.test('shared discovery is redacted even with no Google integration', async () => {
      const w = await setup();
      await db.platform.query(`DELETE FROM ${w.table('tf_google_integrations')} WHERE membership_id=$1`, [
        w.reader.membershipId,
      ]);
      const item = (await w.google.list(w.ws.id, w.reader.userId)).items[0];
      assert.deepEqual(item, {
        sourceId: w.source.sourceId,
        title: 'Shared Google source',
        selection: null,
        memberIds: [],
        counts: null,
        canManage: false,
        state: 'active',
        syncState: 'ready',
        failure: null,
        nextAttemptAt: item.nextAttemptAt,
      });
      assert.equal((await w.google.list(w.ws.id, w.ws.userId)).items[0].title, 'Confidential folder');
    });
    await t.test('removed selection can be freshly selected with new identity and grants', async () => {
      const w = await setup();
      await w.manage('remove');
      const fresh = await w.google.configure(w.ws.id, w.ws.userId, {
        ...w.input,
        commandId: randomUUID(),
        memberIds: [],
      });
      assert.notEqual(fresh.sourceId, w.source.sourceId);
      assert.deepEqual(fresh.memberIds, [w.ws.membershipId]);
      await assert.rejects(
        w.google.configure(w.ws.id, w.ws.userId, { ...w.input, commandId: randomUUID() }),
        e => e.code === 'conflict',
      );
      await assert.rejects(w.manage('resume'), e => e.code === 'conflict');
      assert.equal((await w.google.list(w.ws.id, w.reader.userId)).items.length, 0);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::int n FROM ${w.table('google_originals')}`)).rows[0].n,
        1,
      );
    });
    await t.test('failed parser documents retain authorized status and original journey', async () => {
      const w = await setup({ malformed: true });
      const result = await w.google.listDocuments(w.ws.id, w.ws.userId, w.source.sourceId);
      assert.equal(result.items.length, 1);
      assert.equal(result.nextCursor, null);
      const item = result.items[0];
      assert.equal(item.title, 'Confidential acquisition');
      assert.equal(item.parsing, 'failed');
      assert.equal(item.publicationId, null);
      assert.equal(item.canRetry, false);
      assert.equal(
        (await w.google.original(w.ws.id, w.ws.userId, item.documentId, item.revisionId)).bytes.toString(),
        '%PDF-1.7\nbroken',
      );
      assert.deepEqual(await w.google.listDocuments(w.ws.id, w.reader.userId, w.source.sourceId), {
        items: [],
        nextCursor: null,
      });
      await w.google.refresh(w.ws.id, w.reader.userId, w.source.sourceId);
      assert.equal((await w.google.listDocuments(w.ws.id, w.reader.userId, w.source.sourceId)).items.length, 1);
      w.setCheck(async () => {
        throw new GoogleCorpusError('forbidden');
      });
      await w.renew();
      assert.deepEqual(await w.google.listDocuments(w.ws.id, w.ws.userId, w.source.sourceId), {
        items: [],
        nextCursor: null,
      });
      await assert.rejects(w.google.status(w.ws.id, w.ws.userId, w.doc.id));
    });
  } finally {
    for (const runtime of runtimes) await runtime.close();
    await db.close();
  }
});
