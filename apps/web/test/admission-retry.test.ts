import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Vite resolves extensionless source imports; mirror that resolution for Node's TS runner.
registerHooks({
  resolve(specifier, context, next) {
    return next(
      context.parentURL?.includes('/src/lib/') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)
        ? `${specifier}.ts`
        : specifier,
      context,
    );
  },
});
const { retryAdmission, temporaryAdmissionError } = await import('../src/lib/admission-retry.ts');

const failure = (status: number | undefined, retryAfter?: string) =>
  Object.assign(new Error('request failed'), { status, retryAfter });

test('rate limits and unreachable services are temporary; access answers are not', () => {
  for (const error of [failure(429), failure(503), failure(408), failure(undefined), new TypeError('fetch failed')])
    assert.equal(temporaryAdmissionError(error), true);
  for (const error of [failure(401), failure(403), failure(404), new Error('plain'), { status: 429 }])
    assert.equal(temporaryAdmissionError(error), false);
});

test('admission waits for Retry-After and starts its reads again after a rate limit', async () => {
  const attempts: { fresh: boolean; at: number }[] = [];
  const started = Date.now();
  const result = await retryAdmission(async fresh => {
    attempts.push({ fresh, at: Date.now() - started });
    if (attempts.length === 1) throw failure(429, '1');
    return 'admitted';
  }, new AbortController().signal);
  assert.equal(result, 'admitted');
  assert.deepEqual(
    attempts.map(attempt => attempt.fresh),
    [true, false],
  );
  assert.ok(attempts[1]!.at >= 950, `retried after ${attempts[1]!.at} ms`);
});

test('admission does not retry a denial, and stops when the retry budget or the load ends', async () => {
  let calls = 0;
  const denied = failure(403);
  await assert.rejects(
    retryAdmission(async () => {
      calls++;
      throw denied;
    }, new AbortController().signal),
    denied,
  );
  assert.equal(calls, 1);

  const limited = failure(429, '30');
  await assert.rejects(
    retryAdmission(
      async () => {
        throw limited;
      },
      new AbortController().signal,
      5_000,
    ),
    limited,
  );

  const leaving = new AbortController();
  const pending = retryAdmission(async () => {
    throw failure(429, '30');
  }, leaving.signal);
  setTimeout(() => leaving.abort(new Error('left the page')), 50);
  await assert.rejects(pending, /left the page/);
});
