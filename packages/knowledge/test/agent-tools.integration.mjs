import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied, requireProtectedSource, withMcpSourceContext } from '@tulipfarm/access';
import { createFiles } from '@tulipfarm/files';
import { requireDraftSources } from '../../agents/dist/draft-sources.js';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';
import {
  createKnowledgeAgentTools,
  createKnowledgeKeepIndex,
  createKnowledgeSearch,
  createLocalKnowledge,
  withKnowledgeSourceAuthorization,
} from '../dist/index.js';
import { keepBackedSearch } from './fake-keep.mjs';

test('knowledge agent tools', async t => {
  const db = await fixture();
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    maxPools: 16,
    connectionsPerPool: 2,
    reservedConnections: 2,
    databaseConnectionBudget: 40,
    resolveCredential: async id => {
      const ws = db.workspaces.find(item => item.id === id);
      assert.ok(ws);
      return { workspaceId: id, generation: 1, connectionString: db.login(ws) };
    },
  });
  const searches = [];
  try {
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const stream = await workspaceTableMigrations();
    async function setup() {
      const ws = await db.create(stream);
      const table = name => qualified(ws.names.schema, name.startsWith('tf_') ? name : `tf_knowledge_${name}`);
      const bytes = new Map();
      const files = createFiles(runtime, {
        putIfAbsent: async (key, value) => {
          bytes.set(key, value);
        },
        read: async key => bytes.get(key),
      });
      const local = createLocalKnowledge({ runtime, files });
      const indexed = keepBackedSearch({ runtime });
      const search = indexed.search;
      searches.push(search);
      const tools = createKnowledgeAgentTools({ runtime, search });
      const membership = (
        await db.platform.query(`SELECT id FROM ${table('tf_memberships')} WHERE user_id=$1`, [ws.userId])
      ).rows[0].id;
      const actor = { kind: 'human', userId: ws.userId, membershipId: membership };
      async function note(text, title = text, documentId = randomUUID(), expectedRevisionId = null) {
        const saved = await local.save(ws.id, ws.userId, {
          commandId: randomUUID(),
          documentId,
          expectedRevisionId,
          title,
          input: { kind: 'note', text },
        });
        for (const work of await local.due(ws.id)) await local.process(work);
        await indexed.deliver(ws.id);
        return saved;
      }
      async function member() {
        const userId = randomUUID(),
          membershipId = randomUUID();
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          membershipId,
          userId,
        ]);
        return { kind: 'human', userId, membershipId };
      }
      return { ws, table, local, tools, actor, note, member, keep: indexed.keep };
    }

    await t.test('admission, search and source metadata share one deadline; read deadlines remain errors', async () => {
      const w = await setup();
      await w.note('supplier payment deadline', 'Supplier policy');
      const deadlines = [];
      const tracked = {
        ...runtime,
        transaction: (workspace, compatibility, operation) => {
          deadlines.push(compatibility.deadlineAt);
          return runtime.transaction(workspace, compatibility, operation);
        },
      };
      const search = createKnowledgeSearch({
        runtime: tracked,
        index: createKnowledgeKeepIndex({ client: () => w.keep.client }),
      });
      searches.push(search);
      const tools = createKnowledgeAgentTools({ runtime: tracked, search });
      const deadlineAt = Date.now() + 30_000;
      const found = await tools.search(
        w.ws.id,
        w.actor,
        { query: 'supplier' },
        { commandId: randomUUID(), deadlineAt },
      );
      assert.equal(found.result.hits.length, 1);
      assert.ok(deadlines.length >= 3);
      assert.equal(deadlines[0], deadlineAt, 'admission uses the caller deadline');
      assert.equal(deadlines.at(-1), deadlineAt, 'metadata does not reset the deadline');
      assert.ok(
        deadlines.every(deadline => deadline <= deadlineAt),
        'search stages stay inside the same budget',
      );
      deadlines.length = 0;
      const grouped = await tools.retrieve(
        w.ws.id,
        w.actor,
        { action: 'search', query: 'supplier' },
        { commandId: randomUUID(), deadlineAt },
      );
      assert.equal(grouped.result.branches[0].documents.length, 1);
      assert.ok(deadlines.length >= 3);
      assert.equal(deadlines[0], deadlineAt);
      assert.equal(deadlines.at(-1), deadlineAt);
      assert.ok(
        deadlines.every(deadline => deadline <= deadlineAt),
        'grouped stages cannot extend the shared deadline',
      );
      await db.platform.query(`BEGIN; LOCK TABLE ${w.table('tf_authorization_lock')} IN ACCESS EXCLUSIVE MODE`);
      try {
        await assert.rejects(
          tools.read(w.ws.id, w.actor, found.result.hits[0].citationId, { deadlineAt: Date.now() + 100 }),
          error => error.code === 'wait_timeout',
        );
      } finally {
        await db.platform.query('ROLLBACK');
      }
    });

    await t.test(
      'search returns bounded cited hits and read returns revision-backed evidence as the server-resolved actor',
      async () => {
        const w = await setup();
        const supplier = await w.note('supplier advance settlement required before delivery', 'Supplier policy');
        for (let index = 0; index < 12; index++) await w.note(`supplier appendix ${index}`, `Appendix ${index}`);
        const found = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'supplier settlement' },
          { commandId: randomUUID() },
        );
        assert.equal(found.result.hits.length, 8);
        assert.ok(
          found.result.hits.every(
            hit => /^[0-9a-f-]{36}:\d+$/.test(hit.citationId) && hit.excerpt.length <= 600 && hit.source === 'note',
          ),
        );
        assert.equal(found.sources.length, 8);
        assert.ok(
          found.sources.every(
            source => source.kind === 'knowledge-document' && source.workspaceId === w.ws.id && source.accessEpoch >= 1,
          ),
        );
        const hit = found.result.hits.find(item => item.title === 'Supplier policy');
        assert.ok(hit);
        const read = await w.tools.read(w.ws.id, w.actor, hit.citationId);
        assert.equal(read.result.text, 'supplier advance settlement required before delivery');
        assert.deepEqual(
          read.sources.map(source => [source.documentId, source.revisionId]),
          [[supplier.documentId, supplier.revisionId]],
        );
        const empty = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'nonexistent zebra clause' },
          { commandId: randomUUID() },
        );
        assert.deepEqual(empty.result.hits, []);
        assert.deepEqual(empty.sources, []);
        assert.match(empty.result.instruction, /No authorized knowledge matched/);
        const stranger = await w.member();
        const denied = await w.tools.read(w.ws.id, stranger, hit.citationId);
        assert.equal(denied.result.error, 'knowledge-unavailable');
        assert.deepEqual(denied.sources, []);
        assert.deepEqual(
          (await w.tools.search(w.ws.id, stranger, { query: 'supplier' }, { commandId: randomUUID() })).result.hits,
          [],
        );
        await assert.rejects(
          w.tools.search(
            w.ws.id,
            { ...w.actor, membershipId: stranger.membershipId },
            { query: 'supplier' },
            { commandId: randomUUID() },
          ),
          AccessDenied,
        );
        await assert.rejects(w.tools.read(w.ws.id, w.actor, 'not-a-citation'));
        const kind = await w.tools.search(
          w.ws.id,
          w.actor,
          { query: 'supplier', kind: 'file' },
          { commandId: randomUUID() },
        );
        assert.deepEqual(kind.result.hits, []);
        const unbound = await w.tools.read(w.ws.id, w.actor, hit.citationId, { runId: randomUUID() });
        assert.equal(unbound.result.error, 'knowledge-unavailable');
        await assert.rejects(
          w.tools.search(w.ws.id, w.actor, { query: 'supplier' }, { commandId: randomUUID(), runId: randomUUID() }),
          AccessDenied,
        );
      },
    );

    await t.test(
      'retained dependencies are rechecked through the eligibility gate after edits and removal',
      async () => {
        const w = await setup();
        const edited = await w.note('pricing escalation contact', 'Escalation');
        const removed = await w.note('pricing archive retention', 'Retention');
        const found = await w.tools.search(w.ws.id, w.actor, { query: 'pricing' }, { commandId: randomUUID() });
        const dependency = id => found.sources.find(source => source.documentId === id);
        const guarded = withKnowledgeSourceAuthorization(runtime);
        const check = (runtimeToUse, source) =>
          runtimeToUse.transaction(w.ws.id, commonCompatibility, tx => requireProtectedSource(tx, w.actor, source));
        await check(guarded, dependency(edited.documentId));
        await check(guarded, dependency(removed.documentId));
        await assert.rejects(
          check(runtime, dependency(edited.documentId)),
          AccessDenied,
          'unbound transactions fail closed',
        );
        await w.note('pricing escalation replaced', 'Escalation', edited.documentId, edited.revisionId);
        await assert.rejects(check(guarded, dependency(edited.documentId)), AccessDenied);
        await w.local.remove(w.ws.id, w.ws.userId, {
          commandId: randomUUID(),
          documentId: removed.documentId,
          expectedRevisionId: removed.revisionId,
        });
        await assert.rejects(check(guarded, dependency(removed.documentId)), AccessDenied);
        const stale = await w.tools.read(
          w.ws.id,
          w.actor,
          found.result.hits.find(hit => hit.title === 'Retention').citationId,
        );
        assert.equal(stale.result.error, 'knowledge-unavailable');
      },
    );

    await t.test('MCP-derived context cannot run a knowledge search', async () => {
      const w = await setup();
      const doc = await w.note('vendor onboarding checklist', 'Onboarding');
      const mcp = { kind: 'mcp-integration', integrationId: randomUUID(), authorizationEpoch: 1 };
      const tx = {
        schema: 'unused',
        client: {
          query: async () => {
            throw new Error('no query expected');
          },
        },
      };
      await assert.rejects(
        withMcpSourceContext(tx, [mcp], () =>
          w.tools.search(w.ws.id, w.actor, { query: 'vendor' }, { commandId: randomUUID() }),
        ),
        AccessDenied,
      );
      const found = await w.tools.search(w.ws.id, w.actor, { query: 'vendor' }, { commandId: randomUUID() });
      assert.equal(found.sources[0].documentId, doc.documentId);
      const guarded = withKnowledgeSourceAuthorization(runtime);
      await guarded.transaction(w.ws.id, commonCompatibility, async tx => {
        await assert.rejects(requireDraftSources(tx, w.actor, [mcp, ...found.sources]), AccessDenied);
      });
    });

    await t.test('shared audiences require every reader to be eligible for each knowledge dependency', async () => {
      const w = await setup();
      await w.note('private payroll calendar', 'Payroll');
      const found = await w.tools.search(w.ws.id, w.actor, { query: 'payroll' }, { commandId: randomUUID() });
      const other = await w.member();
      const guarded = withKnowledgeSourceAuthorization(runtime);
      await guarded.transaction(w.ws.id, commonCompatibility, async tx => {
        await requireDraftSources(tx, w.actor, found.sources, new Set(), undefined, true);
        await assert.rejects(requireDraftSources(tx, other, found.sources, new Set(), undefined, true), AccessDenied);
      });
    });
  } finally {
    for (const search of searches) await search.close();
    await runtime.close();
    await db.close();
  }
});
