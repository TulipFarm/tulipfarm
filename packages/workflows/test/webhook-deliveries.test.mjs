import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryRequestId, webhookSample } from '../src/webhook-deliveries.ts';

const requestId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

test('a test sample carries its request ID where each trigger reads the sender identifier', () => {
  const envelope = { kind: 'webhook' };
  assert.deepEqual(webhookSample(envelope, requestId), { body: { requestId, input: { test: true } }, headers: {} });
  const header = { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'header', name: 'x-github-delivery' } } };
  assert.deepEqual(webhookSample(header, requestId), {
    body: { test: true, requestId },
    headers: { 'x-github-delivery': requestId },
  });
  const body = { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'body', path: ['data', 'id'] } } };
  assert.deepEqual(webhookSample(body, requestId), { body: { test: true, data: { id: requestId } }, headers: {} });
  for (const trigger of [envelope, header, body]) {
    const sample = webhookSample(trigger, requestId);
    assert.equal(deliveryRequestId(trigger, sample.body, sample.headers), requestId);
  }
});

test('the logged request ID is the sender identifier, trimmed, and never a body hash', () => {
  assert.equal(deliveryRequestId({ kind: 'webhook' }, { requestId: 'not-a-uuid', input: {} }, {}), 'not-a-uuid');
  assert.equal(deliveryRequestId({ kind: 'webhook' }, { requestId: 'x'.repeat(300) }, {}), 'x'.repeat(200));
  assert.equal(deliveryRequestId({ kind: 'webhook' }, '{"requestId"', {}), null);
  assert.equal(deliveryRequestId(null, { requestId: 'sent-before-activation' }, {}), 'sent-before-activation');
  assert.equal(
    deliveryRequestId(
      { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'body', path: ['id'] } } },
      { id: 42 },
      {},
    ),
    '42',
  );
  assert.equal(
    deliveryRequestId(
      { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'header', name: 'idempotency-key' } } },
      {},
      { 'idempotency-key': '' },
    ),
    null,
  );
  assert.equal(
    deliveryRequestId(
      { kind: 'webhook', payload: { mode: 'raw', dedupe: { source: 'hash' } } },
      { requestId: 'ignored' },
      {},
    ),
    null,
  );
});
