import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AccessDenied } from '@tulipfarm/access';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { keepReplyLease } from '../src/reply-lease.ts';

const storageError = code => Object.assign(new Error('storage'), { code });
const until = async (check, limit = 500) => {
  for (let wait = 0; wait < limit && !check(); wait++) await delay(2);
  assert.ok(check());
};
const captured = t => {
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (line, ...rest) => {
    if (String(line).includes('"chat.lease-renewal"')) lines.push(JSON.parse(line));
    else return write(line, ...rest);
    return true;
  });
  return lines;
};
const options = { intervalMilliseconds: 5, retryMilliseconds: 1, maxRetryMilliseconds: 2, marginMilliseconds: 0 };

test('a transient storage failure keeps the lease and retries until a renewal succeeds', async t => {
  const lines = captured(t);
  const failures = [storageError('55P03'), new StorageUnavailableError('wait_timeout'), storageError('57014')];
  let renewals = 0;
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    renew: async () => {
      renewals++;
      const failure = failures.shift();
      if (failure) throw failure;
    },
  });
  try {
    await until(() => renewals >= 5);
    assert.equal(lease.lost, undefined);
    assert.deepEqual(
      lines.slice(0, 3).map(line => [line.level, line.outcome, line.attempt, line['error.code']]),
      [
        ['warn', 'retry', 1, '55P03'],
        ['warn', 'retry', 2, 'wait_timeout'],
        ['warn', 'retry', 3, '57014'],
      ],
    );
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a denied renewal loses the lease at once', async t => {
  const lines = captured(t);
  const denied = new AccessDenied();
  let renewals = 0;
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    renew: async () => {
      renewals++;
      throw denied;
    },
  });
  try {
    await until(() => lease.lost !== undefined);
    assert.equal(lease.lost, denied);
    await delay(20);
    assert.equal(renewals, 1);
    assert.deepEqual(
      lines.map(line => [line.outcome, line.attempt]),
      [['lost', 1]],
    );
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('transient failures that outlast the lease end it with the storage error, never a denial', async t => {
  captured(t);
  let clock = 0;
  const timeout = storageError('55P03');
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 100,
    marginMilliseconds: 10,
    now: () => clock,
    renew: async () => {
      clock += 30;
      throw timeout;
    },
  });
  try {
    await until(() => lease.lost !== undefined);
    assert.equal(lease.lost, timeout);
    assert.ok(!(lease.lost instanceof AccessDenied));
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('another transaction renewing the lease extends how long transient failures are retried', async t => {
  captured(t);
  let clock = 0;
  let renewals = 0;
  const lease = keepReplyLease({
    ...options,
    retryMilliseconds: 20,
    maxRetryMilliseconds: 20,
    leaseMilliseconds: 1_000,
    now: () => clock,
    renew: async () => {
      renewals++;
      clock += 400;
      throw storageError('08006');
    },
  });
  try {
    await until(() => renewals >= 2);
    lease.renewed(clock);
    await until(() => lease.lost !== undefined);
    assert.ok(renewals >= 4);
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('an unexpected renewal failure ends the lease with that error rather than a denial', async t => {
  captured(t);
  const unexpected = new TypeError('broken');
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    renew: async () => {
      throw unexpected;
    },
  });
  try {
    await until(() => lease.lost !== undefined);
    assert.equal(lease.lost, unexpected);
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a closed lease stops renewing', async () => {
  let renewals = 0;
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    renew: async () => {
      renewals++;
    },
  });
  lease.close();
  await delay(20);
  assert.equal(renewals, 0);
});

test('a renewal still running at its deadline ends the lease with a storage timeout, not a later denial', async t => {
  const lines = captured(t);
  const deadlines = [];
  let deny;
  const startedAt = Date.now();
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 300,
    marginMilliseconds: 200,
    renewedAt: startedAt,
    renew: deadlineAt => {
      deadlines.push(deadlineAt);
      // Storage stalls past expiry, then reports the expired lease as a denial.
      return new Promise((_, reject) => {
        deny = () => reject(new AccessDenied());
      });
    },
  });
  try {
    await until(() => lease.lost !== undefined);
    assert.ok(Date.now() - startedAt < 300, 'the lease ends before it would expire');
    assert.deepEqual(deadlines, [startedAt + 100]);
    assert.ok(lease.lost instanceof StorageUnavailableError);
    assert.equal(lease.lost.code, 'wait_timeout');
    assert.equal(lease.signal.aborted, true);
    assert.equal(lease.signal.reason, lease.lost);
    deny();
    await delay(10);
    assert.equal(lease.lost.code, 'wait_timeout');
    assert.deepEqual(
      lines.map(line => [line.outcome, line['error.code']]),
      [['lost', 'wait_timeout']],
    );
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a denial that arrives after the lease ran out reports a storage timeout, not lost ownership', async t => {
  captured(t);
  let clock = 0;
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 1_000,
    now: () => clock,
    renew: async () => {
      clock += 1_500;
      throw new AccessDenied();
    },
  });
  try {
    await until(() => lease.lost !== undefined);
    assert.ok(lease.lost instanceof StorageUnavailableError);
    assert.equal(lease.lost.code, 'wait_timeout');
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a pending reply rejects with the storage failure as soon as the lease is lost', async t => {
  captured(t);
  const timeout = storageError('55P03');
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    renew: async () => {
      throw timeout;
    },
    retryMilliseconds: 60_000,
    maxRetryMilliseconds: 60_000,
  });
  try {
    assert.equal(await lease.guard(Promise.resolve('answered')), 'answered');
    // The model call never settles on its own; only the lost lease ends the reply.
    const reply = new Promise(() => undefined);
    await assert.rejects(lease.guard(reply), error => error === timeout);
    assert.equal(lease.signal.reason, timeout);
    await assert.rejects(lease.guard(Promise.resolve('late')), error => error === timeout);
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a lease that aged before the keeper started renews at once and keeps its deadline watched', async t => {
  const lines = captured(t);
  const startedAt = Date.now();
  const renewals = [];
  const lease = keepReplyLease({
    ...options,
    intervalMilliseconds: 150,
    leaseMilliseconds: 400,
    marginMilliseconds: 100,
    // The start transaction outlasted the renewal interval and took half the lease.
    renewedAt: startedAt - 200,
    renew: deadlineAt => {
      renewals.push({ at: Date.now(), deadlineAt });
      return new Promise(() => undefined);
    },
  });
  try {
    assert.equal(lease.lost, undefined);
    await until(() => renewals.length === 1);
    assert.ok(renewals[0].at - startedAt < 50, 'an overdue renewal starts at once');
    assert.equal(renewals[0].deadlineAt, startedAt + 100);
    const reply = lease.guard(new Promise(() => undefined));
    await assert.rejects(reply, error => error instanceof StorageUnavailableError && error.code === 'wait_timeout');
    assert.ok(Date.now() - startedAt < 200, 'the deadline ends the lease before it would expire');
    assert.deepEqual(
      lines.map(line => [line.outcome, line['error.code']]),
      [['lost', 'wait_timeout']],
    );
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a lease already past its deadline is lost before any model work starts', async t => {
  captured(t);
  let renewals = 0;
  const lease = keepReplyLease({
    ...options,
    leaseMilliseconds: 60_000,
    marginMilliseconds: 5_000,
    renewedAt: Date.now() - 56_000,
    renew: async () => {
      renewals++;
    },
  });
  try {
    assert.ok(lease.lost instanceof StorageUnavailableError);
    assert.equal(lease.lost.code, 'wait_timeout');
    assert.equal(lease.signal.aborted, true);
    await assert.rejects(lease.guard(Promise.resolve('answer')), error => error === lease.lost);
    await delay(20);
    assert.equal(renewals, 0);
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});

test('a deadline watched between renewals ends the lease even when no renewal is due', async t => {
  captured(t);
  let clock = 0;
  const lease = keepReplyLease({
    ...options,
    intervalMilliseconds: 60_000,
    leaseMilliseconds: 60,
    marginMilliseconds: 10,
    now: () => clock,
    renew: async () => assert.fail('No renewal is due yet'),
  });
  try {
    // Time jumps past the deadline while the next renewal is still far off.
    clock = 51;
    await until(() => lease.lost !== undefined);
    assert.equal(lease.lost.code, 'wait_timeout');
  } finally {
    lease.close();
    t.mock.restoreAll();
  }
});
