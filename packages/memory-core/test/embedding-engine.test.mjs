import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createEmbeddingEngine } from '../dist/embeddings/engine.js';

const result = (...rows) => ({ rows, rowCount: rows.length });
const allowed = value => ({ kind: 'allowed', value });
class Denied extends Error {}
class Credits extends Error {}

function fixture({
  capacity = true,
  credits = true,
  afterCapacity,
  afterProvider,
  providerThrows = false,
  persistenceFailures = 0,
} = {}) {
  const tenant = randomUUID();
  const context = Symbol('embedding transaction');
  const job = {
    id: randomUUID(),
    purpose: 'query',
    owner_membership_id: randomUUID(),
    owner_user_id: 'reader',
    profile_id: 'profile',
    generation: 1,
    retry_count: 0,
    state: 'queued',
    total_chunks: 1,
    command_id: randomUUID(),
    query_fingerprint: 'hash',
  };
  const item = { ordinal: 0, input_hash: 'hash', input_text: 'text', tokens: 1 };
  const profile = { id: 'profile', model: 'model', dimensions: 1536 };
  const trace = [];
  const cache = { state: 'queued', attempt_id: null, attempts: 0 };
  const transient = new Error('retry persistence');
  const sleeps = [];
  let vector;
  let revoked = false;
  let now = 1000;
  const repository = {
    expiredClaims: () => result(),
    lockJob: () => result(job),
    counts: () =>
      result({
        total: 1,
        completed: vector ? 1 : 0,
        busy: ['claimed', 'dispatched'].includes(cache.state),
        unknown: cache.state === 'unknown',
        failed: cache.state === 'failed',
        exhausted: cache.attempts >= 8,
      }),
    nextItem: () => result(item),
    lockCache: () => result(cache),
    claim: ([, , id]) => {
      cache.state = 'claimed';
      cache.attempt_id = id;
      return result();
    },
    ownsClaim: () => (cache.state === 'claimed' ? result({}) : result()),
    hasVector: () => (vector ? result({}) : result()),
    dispatchClaim: () => {
      cache.state = 'dispatched';
      cache.attempts++;
      return result();
    },
    queueJob: () => result(),
    queryTaskFlow: () => result({ task_flow_id: null }),
    insertVector: ([, , value]) => {
      vector = JSON.parse(value);
      return result();
    },
    settleClaim: ([, , , state]) => {
      if (persistenceFailures-- > 0) throw transient;
      cache.state = vector ? 'ready' : state;
      return result();
    },
    releaseClaim: () => {
      cache.state = 'queued';
      cache.attempt_id = null;
      return result();
    },
    deferJobState: ([, state]) => {
      job.state = state;
      return result();
    },
    completeJob: () => {
      job.state = 'ready';
      return result();
    },
  };
  for (const [name, operation] of Object.entries(repository))
    repository[name] = (...args) => {
      trace.push(name);
      return operation(...args);
    };
  const engine = createEmbeddingEngine({
    runtime: {
      async transaction(id, options, operation) {
        assert.equal(id, tenant);
        trace.push('transaction');
        const snapshot = { cache: { ...cache }, vector, job: { ...job } };
        try {
          return await operation(context);
        } catch (error) {
          Object.assign(cache, snapshot.cache);
          Object.assign(job, snapshot.job);
          vector = snapshot.vector;
          throw error;
        }
      },
    },
    store: {
      bind: value => {
        assert.equal(value, context);
        return value;
      },
    },
    repository: value => {
      assert.equal(value, context);
      return repository;
    },
    authorization: {
      authority: (value, principal) => {
        assert.equal(value, context);
        assert.equal(principal.membershipId, job.owner_membership_id);
        return {
          async decide(check) {
            trace.push(check);
            if (revoked) return { kind: 'denied', error: new Denied() };
            assert.ok(['member', 'embeddingOwner', 'queryDispatch'].includes(check));
            return allowed(undefined);
          },
        };
      },
    },
    lock: async () => {
      trace.push('lock');
      return allowed(undefined);
    },
    resolveMember: async () => assert.fail('process uses the persisted owner'),
    selection: () => ({ google: false, slack: false, github: false, atlassian: false, conversation: false }),
    conversationEnabled: () => false,
    tenantId: () => tenant,
    externalProviders: () => [],
    egressPolicy: { deny: () => trace.push('egress') },
    errors: { AccessDenied: Denied, CreditsExhausted: Credits },
    storageErrors: {
      timeout: () => new Error('deadline'),
      deadline: () => false,
      transient: error => error === transient,
    },
    profile,
    enabled: () => true,
    provider: async () => {
      trace.push('provider');
      afterProvider?.({
        revoke: () => {
          revoked = true;
        },
      });
      if (providerThrows) throw new Error('transport');
      return {
        dispatch: 'dispatched',
        inputTokensUpperBound: 1,
        requestId: 'request',
        usage: { kind: 'known', inputTokens: 1, totalTokens: 1, exceedsUpperBound: false },
        result: { kind: 'success', vectors: [Array(1536).fill(1)], model: profile.model },
      };
    },
    prepareInputs: () => assert.fail('already persisted inputs'),
    clock: {
      now: () => now,
      sleep: async ms => {
        sleeps.push(ms);
      },
    },
    usageMeter: {
      cost: () => ({ providerPicoUsd: '1', pricingRevision: '1', date: 'date' }),
      reserve: async () => {
        trace.push('reserve');
        if (!credits) throw new Credits();
      },
      markDispatched: async () => {
        trace.push('mark-dispatched');
        return true;
      },
      outcome: async (value, outcome) => {
        assert.equal(value, context);
        trace.push(`usage:${outcome.kind}`);
      },
      record: async () => {
        trace.push('usage:record');
      },
    },
    capacity: async () => {
      trace.push('capacity');
      afterCapacity?.({
        revoke: () => {
          revoked = true;
        },
        expire: () => {
          now = 20001;
        },
      });
      return capacity;
    },
  });
  return {
    engine,
    trace,
    cache,
    sleeps,
    job,
    transient,
    run: () => engine.process({ workspaceId: tenant, jobId: job.id, generation: 1 }, 20000),
  };
}

test('embedding dispatch rechecks authority after capacity and accounts before publishing', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { disposition: 'ready' });
  assert.equal(f.trace.filter(value => value === 'queryDispatch').length, 2);
  assert.ok(f.trace.indexOf('capacity') < f.trace.lastIndexOf('queryDispatch'));
  assert.ok(f.trace.indexOf('reserve') < f.trace.indexOf('mark-dispatched'));
  assert.ok(f.trace.indexOf('dispatchClaim') < f.trace.indexOf('provider'));
  assert.ok(f.trace.indexOf('usage:known') < f.trace.indexOf('insertVector'));
  assert.ok(f.trace.indexOf('insertVector') < f.trace.indexOf('completeJob'));
  assert.equal(f.cache.state, 'ready');
});

for (const [name, options, disposition] of [
  ['revoked after capacity', { afterCapacity: scope => scope.revoke() }, 'stale'],
  ['capacity denied', { capacity: false }, 'capacity-blocked'],
  ['credits denied', { credits: false }, 'credits-blocked'],
  ['expired after reservation', { afterCapacity: scope => scope.expire() }, 'stale'],
]) {
  test(`${name}: no provider dispatch and the claim returns to queued`, async () => {
    const f = fixture(options);
    assert.deepEqual(await f.run(), { disposition });
    assert.equal(f.cache.state, 'queued');
    assert.equal(f.cache.attempt_id, null);
    assert.ok(!f.trace.includes('provider'));
    assert.ok(!f.trace.includes('mark-dispatched'));
    if (name === 'expired after reservation') assert.ok(f.trace.includes('usage:undispatched'));
  });
}

test('a successful paid vector does not grant authority revoked before final publication', async () => {
  const f = fixture({ afterProvider: scope => scope.revoke() });
  assert.deepEqual(await f.run(), { disposition: 'stale' });
  assert.ok(f.trace.includes('insertVector'));
  assert.ok(f.trace.includes('usage:known'));
  assert.ok(!f.trace.includes('completeJob'));
});

test('a provider transport throw is accounted as unknown and never publishes a vector', async () => {
  const f = fixture({ providerThrows: true });
  assert.deepEqual(await f.run(), { disposition: 'unknown' });
  assert.ok(f.trace.includes('usage:unknown'));
  assert.ok(!f.trace.includes('insertVector'));
  assert.ok(!f.trace.includes('completeJob'));
});

test('outcome persistence retries its transaction, not the provider call', async () => {
  const f = fixture({ persistenceFailures: 1 });
  assert.deepEqual(await f.run(), { disposition: 'ready' });
  assert.deepEqual(f.sleeps, [50]);
  assert.equal(f.trace.filter(value => value === 'provider').length, 1);
  assert.equal(f.trace.filter(value => value === 'settleClaim').length, 2);
});

test('outcome persistence stops at three attempts with the exact original error', async () => {
  const f = fixture({ persistenceFailures: 3 });
  await assert.rejects(f.run(), error => error === f.transient);
  assert.deepEqual(f.sleeps, [50, 100]);
  assert.equal(f.trace.filter(value => value === 'provider').length, 1);
  assert.equal(f.trace.filter(value => value === 'settleClaim').length, 3);
});
