import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSearchEngine } from '../dist/search/search.js';
import { KnowledgeSearchUnavailable } from '../dist/documents/contracts.js';

const result = (...rows) => ({ rows, rowCount: rows.length });
const allow = value => ({ kind: 'allowed', value });
class Denied extends Error {}

function fixture({ index = true, held = true } = {}) {
  const tenant = randomUUID();
  const actor = { kind: 'human', userId: 'reader', membershipId: randomUUID() };
  const owner = {
    document_id: randomUUID(),
    source_id: randomUUID(),
    revision_id: randomUUID(),
    publication_id: randomUUID(),
    access_epoch: 1,
  };
  const trace = [];
  const context = Symbol('search transaction');
  const sessions = new Map();
  const engine = createSearchEngine({
    runtime: {
      async transaction(id, options, operation) {
        assert.equal(id, tenant);
        trace.push(['transaction', options.deadlineAt]);
        return operation(context);
      },
    },
    store: {
      bind: value => {
        assert.equal(value, context);
        trace.push('bind');
        return value;
      },
      eligible: async (value, principal, citation) => {
        assert.equal(value, context);
        assert.equal(principal, actor);
        assert.equal(citation.publicationId, owner.publication_id);
        trace.push('evidence-check');
      },
    },
    authorization: {
      admit: async () => {
        trace.push('admit');
        return allow(actor);
      },
      authority: () => ({
        decide: async check => {
          assert.equal(check, 'member');
          trace.push('member-check');
          return allow(undefined);
        },
      }),
    },
    sessions: value => {
      assert.equal(value, context);
      return {
        eligiblePublications: async values => {
          assert.deepEqual(values.slice(0, 2), [actor.membershipId, actor.userId]);
          trace.push('eligible');
          return result(owner);
        },
        readLive: async ([id]) => (sessions.has(id) ? result(sessions.get(id)) : result()),
        lockOwner: async () => {
          trace.push('lock-owner');
          return result();
        },
        pruneExpired: async () => {
          trace.push('prune');
          return result();
        },
        countOwned: async () => result({ count: 0 }),
        insert: async ([id, , , fingerprint, filters, candidates, mode, reason, coverage, expires_at]) => {
          sessions.set(id, {
            id,
            fingerprint,
            filters,
            candidates: JSON.parse(candidates),
            mode,
            reason,
            coverage,
            expires_at,
          });
          trace.push('persist');
          return result();
        },
        readOwned: async ([id]) => result(sessions.get(id)),
        readPage: async values => {
          const candidate = JSON.parse(values[5])[0];
          trace.push('page');
          if (!candidate) return result();
          return result({
            ...candidate,
            position: 0,
            title: 'Title',
            passage: 'evidence',
            heading: '',
            expires_at: null,
            file_id: null,
            indexed_at: new Date(500),
            observed_at: new Date(400),
            source_revision: null,
            synced_at: null,
          });
        },
      };
    },
    selectReaders: async () => {
      trace.push('readers');
    },
    availability: async () => {
      trace.push('availability');
      return false;
    },
    errors: { AccessDenied: Denied, SourceAuthorizationUnavailable: Denied },
    clock: { now: () => 1000, sleep: async () => assert.fail('unexpected sleep') },
    callTimeoutMs: 20000,
    ...(index
      ? {
          index: {
            configured: () => true,
            held: async (value, publications) => {
              assert.equal(value, context);
              assert.deepEqual(publications, [{ documentId: owner.document_id, publicationId: owner.publication_id }]);
              return new Set(held ? [owner.document_id] : []);
            },
            search: async (workspaceId, query, documentIds) => {
              trace.push(['index-search', query, documentIds]);
              return [{ documentId: owner.document_id, publicationId: owner.publication_id, ordinal: 0, score: 1 }];
            },
          },
        }
      : {}),
  });
  return { engine, tenant, actor, owner, trace, sessions };
}

test('typing search returns rechecked evidence from the index without saving a session', async () => {
  const f = fixture();
  const value = await f.engine.search(f.tenant, f.actor.userId, { kind: 'typing', query: 'Needle 42' });
  assert.equal(value.mode, 'hybrid');
  assert.equal(value.reason, null);
  assert.equal(value.coverage, 'complete');
  assert.equal(value.hits[0].text, 'evidence');
  assert.deepEqual(value.hits[0].freshness, {
    indexedAt: new Date(500).toISOString(),
    observedAt: new Date(400).toISOString(),
    sourceRevision: null,
    sourceSyncedAt: null,
  });
  assert.equal(value.continuation, null);
  assert.equal(value.validUntil, new Date(301000).toISOString());
  assert.ok(!f.trace.includes('persist'));
  assert.ok(f.trace.indexOf('member-check') < f.trace.indexOf('evidence-check'));
  assert.deepEqual(
    f.trace.find(value => Array.isArray(value) && value[0] === 'index-search'),
    ['index-search', 'Needle 42', [f.owner.document_id]],
  );
  await f.engine.close();
});

test('a submitted search replays its saved session without asking the index again', async () => {
  const f = fixture();
  const input = { kind: 'submitted', commandId: randomUUID(), query: 'topic' };
  const value = await f.engine.search(f.tenant, f.actor.userId, input);
  assert.equal(value.hits.length, 1);
  assert.ok(f.trace.includes('persist'));
  const searches = f.trace.filter(value => Array.isArray(value) && value[0] === 'index-search').length;
  assert.deepEqual(await f.engine.search(f.tenant, f.actor.userId, input), value);
  assert.equal(f.trace.filter(value => Array.isArray(value) && value[0] === 'index-search').length, searches);
  await f.engine.close();
});

test('a readable document the index does not hold yet is left out and makes the result partial', async () => {
  const f = fixture({ held: false });
  const value = await f.engine.search(f.tenant, f.actor.userId, { kind: 'typing', query: 'topic' });
  assert.deepEqual(value.hits, []);
  assert.equal(value.coverage, 'partial');
  assert.ok(!f.trace.some(value => Array.isArray(value) && value[0] === 'index-search'));
});

test('search without a configured index reports Knowledge search unavailable', async () => {
  const f = fixture({ index: false });
  await assert.rejects(
    f.engine.search(f.tenant, f.actor.userId, { kind: 'typing', query: 'topic' }),
    error => error instanceof KnowledgeSearchUnavailable,
  );
  assert.ok(!f.trace.includes('eligible'));
});
