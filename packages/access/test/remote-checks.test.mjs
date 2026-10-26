import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceAuthorizationUnavailable } from '../src/index.ts';
import {
  deferRemoteSourceChecks,
  remoteSourceCheck,
  remoteSourceCheckDeadline,
  remoteSourceCheckLimits,
  RemoteSourceChecksDeferred,
  withRemoteSourceCheckBudget,
} from '../src/remote-checks.ts';

/** A transaction that, like the GitHub source wrapper, ends with `RemoteSourceChecksDeferred` after deferring a check. */
function transaction(log, checks) {
  return async () => {
    let deferred = false;
    let open = true;
    log.push('begin');
    const result = [];
    try {
      for (const [key, check] of checks) {
        const mode = remoteSourceCheck(key, async () => {
          assert.equal(open, false, 'remote checks run with no transaction open');
          log.push(`check ${key}`);
          await check();
        });
        if (mode === 'deferred') deferred = true;
        else if (mode === 'inline') await check();
        result.push(`${key}:${mode}`);
      }
    } finally {
      open = false;
      log.push('end');
    }
    if (deferred) throw new RemoteSourceChecksDeferred();
    return result;
  };
}

test('outside a scope, checks run inline', async () => {
  const log = [];
  assert.deepEqual(await transaction(log, [['a', async () => {}]])(), ['a:inline']);
  assert.deepEqual(log, ['begin', 'end']);
});

test('checks run once between transactions, and the retried transaction sees them verified', async () => {
  const log = [];
  let calls = 0;
  const check = async () => {
    calls++;
  };
  const result = await deferRemoteSourceChecks(
    transaction(log, [
      ['a', check],
      ['b', check],
      ['a', check],
    ]),
  );
  assert.deepEqual(result, ['a:verified', 'b:verified', 'a:verified']);
  assert.equal(calls, 2, 'a source is checked once per call');
  assert.deepEqual(log, ['begin', 'end', 'check a', 'check b', 'begin', 'end']);
});

test('a failed check fails the retried transaction where an inline check would have', async () => {
  const denied = new Error('revoked');
  const log = [];
  const seen = [];
  await assert.rejects(
    deferRemoteSourceChecks(async () => {
      try {
        return await transaction(log, [
          [
            'a',
            async () => {
              throw denied;
            },
          ],
        ])();
      } catch (error) {
        seen.push(error);
        throw error;
      }
    }),
    error => error === denied,
  );
  assert.ok(seen[0] instanceof RemoteSourceChecksDeferred);
  assert.equal(seen[1], denied);
});

test('checks run inline once the rounds run out, so the call always ends', async () => {
  let round = 0;
  const log = [];
  const result = await deferRemoteSourceChecks(() => transaction(log, [[`source-${round++}`, async () => {}]])(), 2);
  assert.deepEqual(result, ['source-2:inline']);
});

test('nested scopes share the outer scope, and other failures pass through untouched', async () => {
  const failure = new Error('database down');
  await assert.rejects(
    deferRemoteSourceChecks(() =>
      deferRemoteSourceChecks(async () => {
        throw failure;
      }),
    ),
    error => error === failure,
  );
  const stray = new RemoteSourceChecksDeferred();
  await assert.rejects(
    deferRemoteSourceChecks(async () => {
      throw stray;
    }),
    error => error === stray,
    'a deferral with no pending check is not retried forever',
  );
});

test('deferred checks share one deadline, so slow sources cannot add up their timeouts', async t => {
  t.after(() => Object.assign(remoteSourceCheckLimits, { milliseconds: 10_000 }));
  remoteSourceCheckLimits.milliseconds = 60;
  const deadlines = [];
  const started = [];
  const slow = key => async () => {
    started.push(key);
    deadlines.push(remoteSourceCheckDeadline());
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  const keys = ['a', 'b', 'c', 'd', 'e'];
  await assert.rejects(
    deferRemoteSourceChecks(
      transaction(
        [],
        keys.map(key => [key, slow(key)]),
      ),
    ),
    SourceAuthorizationUnavailable,
  );
  assert.deepEqual(started, ['a', 'b'], 'checks stop once the shared deadline passes');
  assert.equal(new Set(deadlines).size, 1, 'every check gets the same deadline, not a fresh one');
});

test('after one source is unavailable, the rest are reported unavailable without being checked', async () => {
  const started = [];
  const checks = ['a', 'b', 'c'].map(key => [
    key,
    async () => {
      started.push(key);
      if (key === 'a') throw new SourceAuthorizationUnavailable();
    },
  ]);
  await assert.rejects(deferRemoteSourceChecks(transaction([], checks)), SourceAuthorizationUnavailable);
  assert.deepEqual(started, ['a']);
});

test('a denied source does not stop other checks', async () => {
  const started = [];
  const denied = new Error('denied');
  const checks = ['a', 'b'].map(key => [
    key,
    async () => {
      started.push(key);
      if (key === 'a') throw denied;
    },
  ]);
  await assert.rejects(deferRemoteSourceChecks(transaction([], checks)), denied);
  assert.deepEqual(started, ['a', 'b']);
});

test('the check cap covers checks nested in other checks and later calls in the same budget', async t => {
  t.after(() => Object.assign(remoteSourceCheckLimits, { checks: 32 }));
  remoteSourceCheckLimits.checks = 3;
  const started = [];
  const leaf = key => async () => {
    started.push(key);
  };
  // `outer` checks two nested sources in a scope of its own, as a batch check does.
  const outer = async () => {
    started.push('outer');
    await deferRemoteSourceChecks(
      transaction(
        [],
        [
          ['n1', leaf('n1')],
          ['n2', leaf('n2')],
        ],
      ),
    );
  };
  await withRemoteSourceCheckBudget(async () => {
    assert.deepEqual(await deferRemoteSourceChecks(transaction([], [['outer', outer]])), ['outer:verified']);
    await assert.rejects(
      deferRemoteSourceChecks(transaction([], [['later', leaf('later')]])),
      SourceAuthorizationUnavailable,
    );
  });
  assert.deepEqual(started, ['outer', 'n1', 'n2']);
  assert.ok(remoteSourceCheckDeadline(5) <= Date.now() + 5);
});
