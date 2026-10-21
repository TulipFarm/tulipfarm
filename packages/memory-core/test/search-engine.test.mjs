import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSearchEngine } from '../dist/search/search.js';

const result = (...rows) => ({ rows, rowCount: rows.length });
const allow = value => ({ kind: 'allowed', value });
class Denied extends Error {}

function fixture({ count = 2048, duplicateAnn = false, semantic = false } = {}) {
  const tenant = randomUUID();
  const actor = { kind: 'human', userId: 'reader', membershipId: randomUUID() };
  const owner = {
    document_id: randomUUID(),
    source_id: randomUUID(),
    revision_id: randomUUID(),
    publication_id: randomUUID(),
    access_epoch: 1,
    vector_publication_id: randomUUID(),
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
    lexical: value => {
      assert.equal(value, context);
      return {
        eligiblePublications: async values => {
          assert.deepEqual(values.slice(0, 2), [actor.membershipId, actor.userId]);
          trace.push('lexical-eligible');
          return result({ ...owner, semantic });
        },
        match: async (values, options) => {
          trace.push(['lexical-match', values[1], options]);
          return result({ publication_id: owner.publication_id, ordinal: 0, exact: true, rank: 1 });
        },
      };
    },
    vector: value => {
      assert.equal(value, context);
      return {
        eligiblePublications: async () => {
          trace.push('vector-eligible');
          return result(owner);
        },
        boundedCount: async () => {
          trace.push('vector-count');
          return result({ count });
        },
        configureNearest: async () => {
          trace.push('ann-configure');
          return result();
        },
        nearest: async (values, exact) => {
          trace.push(['nearest', exact, values[3]]);
          const row = {
            vector_publication_id: owner.vector_publication_id,
            lexical_publication_id: owner.publication_id,
            ordinal: 0,
            distance: 0,
          };
          return duplicateAnn ? result(...Array.from({ length: 2000 }, () => row)) : result(row);
        },
      };
    },
    sessions: value => {
      assert.equal(value, context);
      return {
        readLive: async ([id]) => (sessions.has(id) ? result(sessions.get(id)) : result()),
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
          return result({
            ...candidate,
            position: 0,
            title: 'Title',
            passage: 'evidence',
            heading: '',
            expires_at: null,
            file_id: null,
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
    storageErrors: { timeout: () => new Error('deadline'), deadline: () => false, transient: () => false },
    clock: { now: () => 1000, sleep: async () => assert.fail('unexpected sleep') },
    callTimeoutMs: 20000,
    profile: { id: 'profile' },
    embeddings: {
      prepareSearchQuery: async () => {
        trace.push('embed');
        return { state: 'ready', vector: [1] };
      },
    },
  });
  return { engine, tenant, actor, owner, trace, sessions };
}

test('typing search uses opaque context, keeps reader admission order, and returns rechecked lexical evidence', async () => {
  const f = fixture();
  const value = await f.engine.search(f.tenant, f.actor.userId, { kind: 'typing', query: 'Needle 42' });
  assert.equal(value.mode, 'keyword-only');
  assert.equal(value.reason, 'typing');
  assert.equal(value.hits[0].text, 'evidence');
  assert.equal(value.continuation, null);
  assert.equal(value.validUntil, new Date(301000).toISOString());
  assert.deepEqual(f.trace.slice(0, 5), [['transaction', 20600], 'bind', 'admit', 'readers', 'lexical-eligible']);
  assert.ok(!f.trace.includes('embed'));
  assert.ok(!f.trace.includes('persist'));
  assert.ok(f.trace.indexOf('member-check') < f.trace.indexOf('evidence-check'));
  assert.deepEqual(
    f.trace.find(value => Array.isArray(value) && value[0] === 'lexical-match'),
    ['lexical-match', 'Needle:* & 42:*', { broaden: false, publicationCount: 1 }],
  );
  await f.engine.close();
});

for (const count of [2048, 2049]) {
  test(`semantic count ${count} preserves the exact/ANN threshold and session replay`, async () => {
    const f = fixture({ count, semantic: true });
    const input = { kind: 'submitted', commandId: randomUUID(), query: 'topic' };
    const value = await f.engine.search(f.tenant, f.actor.userId, input);
    assert.equal(value.mode, 'hybrid');
    assert.equal(value.reason, null);
    assert.equal(value.hits.length, 1);
    assert.equal(f.trace.includes('ann-configure'), count > 2048);
    assert.equal(f.trace.find(value => Array.isArray(value) && value[0] === 'nearest')[1], count <= 2048);
    const nearestCalls = f.trace.filter(value => Array.isArray(value) && value[0] === 'nearest').length;
    const again = await f.engine.search(f.tenant, f.actor.userId, input);
    assert.deepEqual(again, value);
    assert.equal(f.trace.filter(value => Array.isArray(value) && value[0] === 'nearest').length, nearestCalls);
    await f.engine.close();
  });
}

test('ANN backfill stays at three attempts and excludes previously found publications', async () => {
  const f = fixture({ count: 2049, semantic: true, duplicateAnn: true });
  const value = await f.engine.search(f.tenant, f.actor.userId, {
    kind: 'submitted',
    commandId: randomUUID(),
    query: 'topic',
  });
  const calls = f.trace.filter(value => Array.isArray(value) && value[0] === 'nearest');
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(value => value[2]),
    [[], [f.owner.publication_id], [f.owner.publication_id]],
  );
  assert.equal(value.hits.length, 1);
  await f.engine.close();
});
