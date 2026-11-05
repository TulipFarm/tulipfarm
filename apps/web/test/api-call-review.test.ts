import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { apiCallViewSchema } from '@tulipfarm/api-calls/contracts';
import type * as Review from '../src/features/api-calls/review.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const review = (await server.ssrLoadModule('/src/features/api-calls/review.ts')) as typeof Review;

const call = (extra: Record<string, unknown> = {}) =>
  apiCallViewSchema.parse({
    id: '22222222-2222-4222-8222-222222222222',
    status: 'awaiting-approval',
    method: 'POST',
    url: 'https://api.linear.app/v1/issues?team=ENG',
    host: 'api.linear.app',
    headers: {},
    body: null,
    secrets: [],
    purpose: null,
    digest: 'a'.repeat(64),
    expiresAt: '2099-10-11T00:00:00Z',
    responseStatus: null,
    errorCode: null,
    origin: { kind: 'chat', conversationId: '33333333-3333-4333-8333-333333333333' },
    ...extra,
  });

test('the headline names the host and path, without the query', () => {
  assert.equal(review.target(call()), 'api.linear.app/v1/issues');
  assert.equal(review.target(call({ url: 'https://api.linear.app/' })), 'api.linear.app');
});

test('secret headers show the secret name in place of its value', () => {
  const header = (placement: unknown) => review.secretHeader({ name: 'LINEAR_API_KEY', placement });
  assert.deepEqual(header({ kind: 'bearer' }), ['Authorization', 'Bearer ‹LINEAR_API_KEY›']);
  assert.deepEqual(header({ kind: 'basic' }), ['Authorization', 'Basic ‹LINEAR_API_KEY›']);
  assert.deepEqual(header({ kind: 'header', name: 'X-Api-Key' }), ['X-Api-Key', '‹LINEAR_API_KEY›']);
  assert.deepEqual(header({ kind: 'cookie', name: 'session' }), ['Cookie', 'session=‹LINEAR_API_KEY›']);
  assert.equal(header({ kind: 'query', name: 'key' }), null);
  assert.equal(header({ kind: 'unknown' }), null);
});

test('each finished state says whether anything was sent', () => {
  const title = (extra: Record<string, unknown>) => review.settled(call(extra))?.title;
  assert.equal(review.settled(call()), null);
  assert.equal(title({ status: 'sent', responseStatus: 201 }), 'Sent · 201');
  assert.equal(title({ status: 'rejected' }), 'Not sent');
  assert.equal(title({ status: 'conflict' }), 'Not sent');
  assert.equal(title({ status: 'expired' }), 'Expired');
  assert.equal(title({ status: 'outcome-unknown' }), 'Outcome unknown');
  assert.equal(
    review.settled(call({ status: 'failed', errorCode: 'timeout' }))?.detail,
    'The service did not answer in time.',
  );
  assert.equal(review.settled(call({ status: 'failed', errorCode: 'other' }))?.detail, 'It could not be sent.');
});
