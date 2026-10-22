import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDenied, SourceAuthorizationUnavailable } from '@tulipfarm/access';
import { requireAccess } from '@tulipfarm/memory-core/ports/authorizer';
import {
  admitKnowledgePrincipal,
  authorizeKnowledgeDocument,
  bindKnowledgeAuthorization,
  createKnowledgeAuthorizer,
  lockKnowledgeAuthorization,
  resolveKnowledgeMember,
  selectedKnowledgeReaders,
} from '../dist/authorization/authorizer.js';
import { createKnowledgeEligibilityFilter } from '../dist/authorization/eligibility.js';
import { searchEligibility } from '../dist/internal/search-eligibility.js';
import { KnowledgeError, proofInput } from '../dist/internal/contracts.js';

const id = '11111111-1111-4111-a111-111111111111';
const other = '22222222-2222-4222-a222-222222222222';
const actor = { kind: 'human', userId: 'user', membershipId: id };
const member = { id, user_id: 'user', role: 'member' };
const source = { id, provider: 'note', owner_membership_id: id, state: 'active', access_epoch: 2 };
const document = {
  id,
  source_id: id,
  observed_revision_id: id,
  lexical_publication_id: other,
  tombstoned_at: null,
};
const selection = { google: false, slack: false, github: false, atlassian: false, conversation: true };
function fixture(results = []) {
  const calls = [];
  const tx = {
    workspaceId: id,
    schema: 'ws_test',
    commonVersion: 1,
    client: {
      async query(sql, values) {
        calls.push({ sql, values });
        assert.ok(results.length, `Unexpected query: ${sql}`);
        const result = results.shift();
        if (result instanceof Error) throw result;
        return Array.isArray(result) ? { rows: result, rowCount: result.length } : result;
      },
    },
  };
  return { tx, calls, authorizer: createKnowledgeAuthorizer(tx, actor), done: () => assert.equal(results.length, 0) };
}
const allow = async (authorizer, check, input) => requireAccess(await authorizer.decide(check, input));
const denied = async (authorizer, check, input, type = AccessDenied) => {
  const result = await authorizer.decide(check, input);
  assert.equal(result.kind, 'denied');
  assert.ok(result.error instanceof type);
  assert.throws(
    () => requireAccess(result),
    error => error === result.error,
  );
};

test('admission keeps lock, resolve, member ordering and exact principal binding', async () => {
  const { tx, calls, done } = fixture([[{ id: 1 }], [member], [member]]);
  assert.deepEqual(requireAccess(await admitKnowledgePrincipal(tx, 'user', 'write')), actor);
  assert.match(calls[0].sql, /FOR UPDATE$/);
  assert.match(calls[1].sql, /WHERE user_id = \$1/);
  assert.match(calls[2].sql, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(
    calls.map(call => call.values),
    [undefined, ['user'], [id, 'user']],
  );
  done();
  const supplied = fixture([[{ id: 1 }], [member]]);
  assert.deepEqual(requireAccess(await admitKnowledgePrincipal(supplied.tx, actor, 'read')), actor);
  assert.match(supplied.calls[0].sql, /FOR SHARE$/);
  assert.equal(supplied.calls.length, 2);
  supplied.done();
});

test('lock-only and resolved-member operations do not add or omit checks', async () => {
  const { tx, calls, done } = fixture([[{ id: 1 }], [member], [member]]);
  requireAccess(await lockKnowledgeAuthorization(tx, 'write'));
  assert.deepEqual(requireAccess(await resolveKnowledgeMember(tx, 'user')), actor);
  assert.equal(calls.length, 3);
  done();
});

test('authorization failures preserve exact error identity; infrastructure and parse errors propagate', async () => {
  for (const failure of [new AccessDenied(), new SourceAuthorizationUnavailable()]) {
    const { tx } = fixture([failure]);
    const result = await admitKnowledgePrincipal(tx, actor, 'read');
    assert.equal(result.kind, 'denied');
    assert.throws(
      () => requireAccess(result),
      error => error === failure,
    );
  }
  const failure = new Error('database unavailable');
  await assert.rejects(admitKnowledgePrincipal(fixture([failure]).tx, actor, 'read'), error => error === failure);
  await assert.rejects(admitKnowledgePrincipal(fixture([[{ id: 1 }], [{ invalid: true }]]).tx, 'user', 'read'));
});

test('local source ownership, state and write conflict behavior stay distinct', async () => {
  const { authorizer } = fixture();
  assert.equal(await allow(authorizer, 'source', { value: source, writing: false }), source);
  for (const value of [
    undefined,
    { ...source, state: 'removed' },
    { ...source, state: 'disconnected' },
    { ...source, owner_membership_id: other },
  ])
    await denied(authorizer, 'source', { value, writing: false });
  assert.equal(
    await allow(authorizer, 'source', { value: { ...source, state: 'paused' }, writing: false }).then(v => v.state),
    'paused',
  );
  await denied(authorizer, 'source', { value: { ...source, state: 'paused' }, writing: true }, KnowledgeError);
});

test('external adapters receive the exact transaction, principal and source; missing adapter fails closed', async () => {
  const { tx } = fixture();
  const external = { ...source, provider: 'google', owner_membership_id: other };
  const calls = [];
  const authorizer = createKnowledgeAuthorizer(tx, actor, {
    requireExternalSource: async (...args) => {
      calls.push(args);
    },
  });
  assert.equal(await allow(authorizer, 'source', { value: external, writing: false }), external);
  assert.deepEqual(calls, [[tx, actor, external]]);
  await denied(authorizer, 'source', { value: external, writing: true });
  await denied(createKnowledgeAuthorizer(tx, actor), 'source', { value: external, writing: false }, KnowledgeError);
});

test('external authority callbacks keep the original bare-function receiver', async () => {
  const { tx, done } = fixture([[{ allowed: 1 }]]);
  const calls = [];
  const authorizer = createKnowledgeAuthorizer(tx, actor, {
    requireExternalSource: async function () {
      assert.equal(this, undefined);
      calls.push('source');
    },
    requireExternalProof: async function () {
      assert.equal(this, undefined);
      calls.push('proof');
    },
  });
  const external = { ...source, provider: 'google' };
  await allow(authorizer, 'source', { value: external, writing: false });
  await allow(authorizer, 'proof', { document, source: external });
  assert.deepEqual(calls, ['source', 'proof']);
  done();
});

test('conversation source reads query the exact reader binding, not source ownership', async () => {
  const { authorizer, calls, done } = fixture([[{ allowed: 1 }]]);
  await allow(authorizer, 'source', {
    value: { ...source, provider: 'conversation', owner_membership_id: other },
    writing: false,
  });
  assert.match(calls[0].sql, /tf_knowledge_conversation_readers/);
  assert.deepEqual(calls[0].values, [id, id, 'user', null]);
  done();
  await denied(fixture([[]]).authorizer, 'source', { value: { ...source, provider: 'conversation' }, writing: false });
});

test('missing or tombstoned documents are denied, and admitted document identity is retained', async () => {
  assert.equal(requireAccess(await authorizeKnowledgeDocument(document)), document);
  for (const value of [undefined, { ...document, tombstoned_at: new Date() }]) {
    const result = await authorizeKnowledgeDocument(value);
    assert.equal(result.kind, 'denied');
    assert.throws(() => requireAccess(result), AccessDenied);
  }
});

test('tenant, access epoch, current revision and publication checks keep their exact denials', async () => {
  const { authorizer } = fixture();
  const dependency = { sourceId: id, accessEpoch: 2, revisionId: id, publicationId: other };
  await allow(authorizer, 'tenant', id);
  await denied(authorizer, 'tenant', other);
  await allow(authorizer, 'binding', { document, source, dependency });
  await denied(authorizer, 'binding', { document, source, dependency: { ...dependency, accessEpoch: 3 } });
  await denied(authorizer, 'binding', { document, source, dependency: { ...dependency, sourceId: other } });
  for (const change of [{ revisionId: other }, { publicationId: id }])
    await denied(authorizer, 'binding', { document, source, dependency: { ...dependency, ...change } }, KnowledgeError);
});

test('external proof check precedes the unchanged per-read SQL expiry and epoch check', async () => {
  const { tx, calls, done } = fixture([[{ allowed: 1 }]]);
  const authorizer = createKnowledgeAuthorizer(tx, actor, {
    requireExternalProof: async (received, principal, documentId) => {
      assert.equal(received, tx);
      assert.equal(principal, actor);
      assert.equal(documentId, id);
      assert.equal(calls.length, 0);
    },
  });
  await allow(authorizer, 'proof', { document, source: { ...source, provider: 'google' } });
  assert.match(calls[0].sql, /acl_checked_at<=clock_timestamp\(\) AND membership_checked_at<=clock_timestamp\(\)/);
  assert.match(calls[0].sql, /expires_at>clock_timestamp\(\)/);
  assert.deepEqual(calls[0].values, [id, id, 2]);
  done();
  await denied(
    fixture([[]]).authorizer,
    'proof',
    { document, source: { ...source, provider: 'google' } },
    KnowledgeError,
  );
  await allow(fixture().authorizer, 'proof', { document, source });
});

test('conversation revision decision retains chat lock and writing-only maintenance predicates', async () => {
  const { authorizer, calls, done } = fixture([[{ id }], [{ id }]]);
  await allow(authorizer, 'conversation', { revisionId: id, writing: false });
  await allow(authorizer, 'conversation', { revisionId: id, writing: true });
  assert.match(calls[0].sql, /FOR SHARE OF c$/);
  assert.doesNotMatch(calls[0].sql, /tf_conversation_maintenance/);
  assert.match(calls[1].sql, /tf_conversation_maintenance/);
  assert.deepEqual(
    calls.map(call => call.values),
    [
      [id, id, 'user'],
      [id, id, 'user'],
    ],
  );
  done();
});

test('task decision requires installed tables and current generation/requester binding', async () => {
  const { authorizer, calls, done } = fixture([[{ installed: true }], [{ allowed: 1 }]]);
  await allow(authorizer, 'task', other);
  assert.match(calls[1].sql, /t.generation=b.generation/);
  assert.deepEqual(calls[1].values, [other, id, 'user']);
  done();
  await denied(fixture([[{ installed: false }]]).authorizer, 'task', other);
  await denied(fixture([[{ installed: true }], []]).authorizer, 'task', other);
});

test('file checks preserve Files membership denial and do not grant from a cached original', async () => {
  const failure = new AccessDenied();
  const { authorizer } = fixture([failure]);
  const result = await authorizer.decide('dependencies', {
    original: { kind: 'file', fileId: id, sha256: 'a'.repeat(64), bytes: 10 },
    sources: [],
  });
  assert.equal(result.kind, 'denied');
  assert.equal(result.error, failure);
  const empty = fixture();
  assert.deepEqual(
    await allow(empty.authorizer, 'dependencies', {
      original: { kind: 'object', key: id },
      sources: [],
    }),
    [],
  );
  empty.done();
});

test('embedding owner and configured-provider checks cannot borrow another principal or adapter', async () => {
  const { authorizer } = fixture();
  await allow(authorizer, 'embeddingOwner', { owner_membership_id: id, owner_user_id: 'user' });
  for (const job of [
    { owner_membership_id: other, owner_user_id: 'user' },
    { owner_membership_id: id, owner_user_id: 'other' },
  ])
    await denied(authorizer, 'embeddingOwner', job);
  await allow(authorizer, 'embeddingProvider', { source: { ...source, provider: 'google' }, providers: ['google'] });
  await denied(authorizer, 'embeddingProvider', { source: { ...source, provider: 'google' }, providers: [] });
});

test('query dispatch checks cancellation, fresh clock and SQL eligibility before provider use', async () => {
  const scope = {
    filters: { kinds: ['note'], sourceIds: [], documentIds: [] },
    expires_at: new Date(2_000),
    cancelled: false,
  };
  const { authorizer, calls, done } = fixture([[scope], [{ allowed: 1 }]]);
  const clock = {
    now: () => {
      assert.equal(calls.length, 1);
      return 1_000;
    },
  };
  assert.equal(await allow(authorizer, 'queryDispatch', { jobId: id, selection, clock }), 2_000);
  assert.deepEqual(calls[1].values, [id, 'user', ['note'], [], []]);
  done();
  for (const row of [
    { ...scope, cancelled: true },
    { ...scope, expires_at: new Date(1_000) },
  ])
    await denied(fixture([[row]]).authorizer, 'queryDispatch', { jobId: id, selection, clock: { now: () => 1_000 } });
  await denied(fixture([[scope], []]).authorizer, 'queryDispatch', {
    jobId: id,
    selection,
    clock: { now: () => 1_000 },
  });
  assert.equal(
    await allow(fixture([[]]).authorizer, 'queryDispatch', {
      jobId: id,
      selection,
      clock: { now: () => assert.fail() },
    }),
    undefined,
  );
});

test('selected readers retain provider query order and disabled-provider short circuiting', async () => {
  const { tx, calls, done } = fixture([[{ allowed: 1 }], [], [{ allowed: 1 }]]);
  assert.deepEqual(await selectedKnowledgeReaders(tx, actor, { slack: true, github: true, atlassian: true }), {
    slack: true,
    github: false,
    atlassian: true,
  });
  assert.match(calls[0].sql, /slack_members/);
  assert.match(calls[1].sql, /github_members/);
  assert.match(calls[2].sql, /atlassian_members/);
  done();
  const disabled = fixture();
  assert.deepEqual(
    await selectedKnowledgeReaders(disabled.tx, actor, { slack: false, github: false, atlassian: false }),
    {
      slack: false,
      github: false,
      atlassian: false,
    },
  );
  disabled.done();
});

test('eligibility adapter preserves every configured SQL branch byte-for-byte at the old export', () => {
  for (let flags = 0; flags < 32; flags++) {
    const bits = Array.from({ length: 5 }, (_, bit) => Boolean(flags & (1 << bit)));
    const selected = Object.fromEntries(
      ['google', 'slack', 'github', 'atlassian', 'conversation'].map((name, index) => [name, bits[index]]),
    );
    assert.equal(
      createKnowledgeEligibilityFilter('ws_test').predicate(selected),
      searchEligibility('ws_test', ...bits),
    );
  }
});

test('bound retained citations check member and task before eligibility and preserve error translation', async () => {
  const { tx, calls, done } = fixture([[member], [{ installed: true }], [{ allowed: 1 }]]);
  const failure = new KnowledgeError('superseded');
  const bound = bindKnowledgeAuthorization(tx, async (received, principal, dependency) => {
    assert.equal(received, bound);
    assert.equal(principal, actor);
    assert.equal(dependency.documentId, id);
    assert.equal(calls.length, 3);
    throw failure;
  });
  assert.notEqual(bound, tx);
  assert.equal(tx.requireKnowledgeSource, undefined);
  await assert.rejects(
    bound.requireKnowledgeSource(actor, { documentId: id }, { runId: other, publicOnly: false }),
    AccessDenied,
  );
  done();
  await assert.rejects(bound.knowledgeSourceDependencies({ workspaceId: other }), AccessDenied);
});

test('proof input schema keeps host membership naming and exact five-minute bounds', () => {
  const value = {
    id,
    documentId: id,
    accessEpoch: 2,
    principal: 'user',
    aclVersion: 'a',
    membershipVersion: 'm',
    aclCheckedAt: new Date(1_000),
    membershipCheckedAt: new Date(2_000),
    expiresAt: new Date(301_000),
  };
  assert.equal(proofInput.parse(value).membershipCheckedAt.getTime(), 2_000);
  assert.equal(proofInput.safeParse({ ...value, expiresAt: new Date(301_001) }).success, false);
  assert.equal(proofInput.safeParse({ ...value, expiresAt: new Date(2_000) }).success, false);
});
