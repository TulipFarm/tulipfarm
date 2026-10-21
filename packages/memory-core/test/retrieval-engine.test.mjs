import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { createRetrievalEngine } from '../dist/retrieval/retrieval.js';
import { knowledgeRetrievalLimits } from '../dist/contracts/retrieval.js';

class AccessDenied extends Error {}
class SourceAuthorizationUnavailable extends AccessDenied {}
class StorageUnavailableError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const result = rows => ({ rows, rowCount: rows.length });

function fixture() {
  const tenant = randomUUID();
  const actor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() };
  const context = Symbol('retrieval transaction');
  const trace = [];
  const publicationId = randomUUID();
  const seed = {
    publication_id: publicationId,
    document_id: randomUUID(),
    revision_id: randomUUID(),
    source_id: randomUUID(),
    access_epoch: 1,
    ordinal: 0,
  };
  const state = {
    chunks: [
      {
        publication_id: publicationId,
        ordinal: 1,
        heading: 'Heading',
        text: 'second',
        truncated: false,
        chunk_count: 2,
      },
      {
        publication_id: publicationId,
        ordinal: 0,
        heading: 'Heading',
        text: 'first',
        truncated: false,
        chunk_count: 2,
      },
    ],
    eligibleCalls: 0,
    revokeAfter: Infinity,
    failure: null,
    taskDenied: null,
    egressDenied: null,
  };
  const denied = new AccessDenied('revoked');
  const repository = {
    async anchors([publications, ordinals, kinds, sources, documents]) {
      trace.push('anchors');
      if (state.failure) throw state.failure;
      return result(
        publications.flatMap((id, index) =>
          id === publicationId &&
          state.chunks.some(chunk => chunk.ordinal === ordinals[index]) &&
          kinds.includes('note') &&
          (!sources.length || sources.includes(seed.source_id)) &&
          (!documents.length || documents.includes(seed.document_id))
            ? [{ ...seed, ordinal: ordinals[index] }]
            : [],
        ),
      );
    },
    async passages([publications, , , limit, excluded]) {
      trace.push('passages');
      return result(
        state.chunks
          .filter(
            chunk =>
              publications.includes(chunk.publication_id) &&
              !excluded.includes(`${chunk.publication_id}:${chunk.ordinal}`),
          )
          .slice(0, limit),
      );
    },
  };
  const retrieve = createRetrievalEngine({
    store: {
      async transaction(id, principal, write, operation, options) {
        assert.equal(id, tenant);
        assert.deepEqual(principal, actor);
        assert.equal(write, false);
        trace.push(['transaction', options.deadlineAt]);
        return operation(context, principal);
      },
      async eligible(value, principal, dependency) {
        assert.equal(value, context);
        assert.deepEqual(principal, actor);
        assert.equal(dependency.publicationId, publicationId);
        state.eligibleCalls++;
        trace.push('eligible');
        if (state.eligibleCalls > state.revokeAfter) throw denied;
        return { revision: { title: 'Evidence' }, origin: { provider: 'note' } };
      },
    },
    search: {
      async search(id, userId, input, deadlineAt, signal, options) {
        assert.equal(id, tenant);
        assert.equal(userId, actor.userId);
        assert.equal(deadlineAt, 5500);
        assert.equal(signal, undefined);
        assert.equal(options.allowKeywordFallback, true);
        assert.equal(input.query, 'evidence');
        trace.push('search');
        return {
          mode: 'keyword-only',
          reason: 'embedding-disabled',
          coverage: 'keyword-only',
          queryBroadened: true,
          hits: [{ citation: { publicationId, ordinal: 0 } }],
        };
      },
    },
    repository: value => {
      assert.equal(value, context);
      return repository;
    },
    humanActorSchema: z.object({ kind: z.literal('human'), membershipId: z.uuid(), userId: z.uuid() }),
    task: async (value, principal, runId) => {
      assert.equal(value, context);
      assert.deepEqual(principal, actor);
      assert.equal(runId, 'task-run');
      trace.push('task');
      return state.taskDenied ? { kind: 'denied', error: state.taskDenied } : { kind: 'allowed', value: undefined };
    },
    errors: { AccessDenied, SourceAuthorizationUnavailable, StorageUnavailableError },
    egressPolicy: {
      deny() {
        trace.push('egress');
        if (state.egressDenied) throw state.egressDenied;
      },
    },
    clock: { now: () => 1000, sleep: async () => {} },
    callTimeoutMs: 5000,
  });
  const branch = { citationIds: [`${publicationId}:0`], reason: 'verify' };
  const input = { action: 'expand', branches: [branch] };
  const call = (value = input, options = {}) =>
    retrieve(tenant, actor, value, { commandId: 'request', deadlineAt: 5500, ...options });
  return { state, trace, denied, seed, branch, call, publicationId };
}

test('bounded retrieval uses opaque ports, ordered passages, and both eligibility checks', async () => {
  const f = fixture();
  const output = await f.call(undefined, { runId: 'task-run' });
  assert.deepEqual(f.trace, [
    ['transaction', 5500],
    'task',
    ['transaction', 5500],
    'task',
    'anchors',
    'eligible',
    'passages',
    'eligible',
  ]);
  const branch = output.result.branches[0];
  assert.equal(branch.status, 'evidence');
  assert.equal(branch.documents[0].completeness, 'complete');
  assert.deepEqual(
    branch.documents[0].passages.map(passage => passage.text),
    ['first', 'second'],
  );
  assert.equal(output.sources[0].revisionId, f.seed.revision_id);
  assert.equal(output.sources[0].accessEpoch, 1);
});

test('a revocation after passage lookup withholds all evidence and provenance', async () => {
  const f = fixture();
  f.state.revokeAfter = 1;
  const output = await f.call();
  assert.equal(output.result.branches[0].status, 'unavailable');
  assert.equal(output.result.branches[0].reason, 'source-unavailable');
  assert.deepEqual(output.result.branches[0].documents, []);
  assert.deepEqual(output.sources, []);
});

test('query retrieval preserves egress admission, keyword fallback, and visible broadening', async () => {
  const f = fixture();
  const output = await f.call({ action: 'search', query: 'evidence' });
  assert.equal(f.trace[0], 'egress');
  assert.ok(f.trace.includes('search'));
  assert.equal(output.result.branches[0].mode, 'keyword-only');
  assert.equal(output.result.branches[0].queryBroadened, true);
  assert.equal(output.result.branches[0].coverage, 'keyword-only');
  const denied = new Error('protected egress');
  f.state.egressDenied = denied;
  f.trace.length = 0;
  await assert.rejects(f.call({ action: 'search', query: 'evidence' }), error => error === denied);
  assert.deepEqual(f.trace, ['egress']);
});

test('retrieval distinguishes inaccessible sources, unavailable storage, and unexpected failures', async () => {
  for (const [error, status, reason] of [
    [new AccessDenied(), 'unavailable', 'source-unavailable'],
    [new SourceAuthorizationUnavailable(), 'failed', 'source-authorization-unavailable'],
    [new StorageUnavailableError('storage-hibernated'), 'failed', 'storage-hibernated'],
  ]) {
    const f = fixture();
    f.state.failure = error;
    const output = await f.call();
    assert.equal(output.result.branches[0].status, status);
    assert.equal(output.result.branches[0].reason, reason);
  }
  const f = fixture();
  const failure = new Error('unexpected adapter failure');
  f.state.failure = failure;
  await assert.rejects(f.call(), error => error === failure);
});

test('retrieval clips UTF-16 without returning a dangling surrogate', async () => {
  const f = fixture();
  f.state.chunks = [{ ...f.state.chunks[0], ordinal: 0, chunk_count: 1, text: `${'a'.repeat(15999)}\u{1f337}` }];
  const output = await f.call({ action: 'search', query: 'evidence' });
  const document = output.result.branches[0].documents[0];
  assert.equal(document.passages[0].text, 'a'.repeat(15999));
  assert.equal(document.passages[0].truncated, true);
  assert.equal(document.completeness, 'partial');
});

test('the serialized result ceiling includes headings and JSON overhead', async () => {
  const f = fixture();
  f.state.chunks = Array.from({ length: 32 }, (_, ordinal) => ({
    publication_id: f.publicationId,
    ordinal,
    heading: 'h'.repeat(2048),
    text: 'evidence',
    truncated: false,
    chunk_count: 32,
  }));
  const output = await f.call();
  assert.ok(JSON.stringify(output).length <= knowledgeRetrievalLimits.resultCharacters);
  const document = output.result.branches[0].documents[0];
  assert.ok(document.passages.length > 0 && document.passages.length < 32);
  assert.equal(document.omitted, true);
  assert.equal(document.completeness, 'partial');
});

test('overlapping branches keep one longest passage copy and one document provenance entry', async () => {
  const f = fixture();
  const output = await f.call({ action: 'expand', branches: [f.branch, { ...f.branch, reason: 'second branch' }] });
  assert.equal(output.result.branches[0].documents[0].passages.length, 2);
  assert.deepEqual(output.result.branches[1].documents[0].passages, []);
  assert.equal(output.result.branches[1].documents[0].omitted, true);
  assert.equal(output.sources.length, 1);
});

test('cancellation and initial task denial fail before private storage lookup', async () => {
  const f = fixture();
  const cancelled = new Error('cancelled');
  await assert.rejects(f.call(undefined, { signal: AbortSignal.abort(cancelled) }), error => error === cancelled);
  assert.deepEqual(f.trace, []);
  const denied = new AccessDenied('stale run');
  f.state.taskDenied = denied;
  await assert.rejects(f.call(undefined, { runId: 'task-run' }), error => error === denied);
  assert.deepEqual(f.trace, [['transaction', 5500], 'task']);
});
