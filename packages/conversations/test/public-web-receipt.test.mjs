import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicWebReceipt, publicWebReceiptSchema } from '../src/public-web.ts';

const url = 'https://example.com/article';
const source = { url, title: '  Page title  ', description: 'Not in receipt', publishedAt: null };
const output = (overrides = {}) => ({
  result: {
    kind: 'public-web',
    status: 'success',
    sources: [source],
    pages: [],
    window: 'any',
    widened: false,
    retrievedAt: '2026-10-12T00:00:00Z',
    untrusted: true,
    ...overrides,
  },
});

test('search receipts retain the actual query before, after, and without results', () => {
  const call = { query: 'accessibility keyboard testing' };
  for (const result of [
    null,
    output(),
    output({ status: 'empty', sources: [] }),
    output({ status: 'failed', sources: [] }),
  ]) {
    const receipt = publicWebReceipt('web.search', call, result);
    assert.equal(receipt.query, call.query);
    assert.ok(publicWebReceiptSchema.safeParse(receipt).success);
  }
  assert.deepEqual(publicWebReceipt('web.search', call, output()).sources, [{ url, title: 'Page title' }]);
});

test('page receipts start with the URL and gain a title without leaking page content', () => {
  assert.deepEqual(publicWebReceipt('web.fetch', { url }, null), {
    status: 'running',
    urls: [url],
    failedUrls: [],
    widened: false,
  });
  const receipt = publicWebReceipt(
    'web.fetch',
    { url },
    output({ pages: [{ ...source, status: 'read', title: 'Fetched page title', text: 'Private page body' }] }),
  );
  assert.deepEqual(receipt.urls, [url]);
  assert.deepEqual(receipt.sources, [{ url, title: 'Fetched page title' }]);
  assert.doesNotMatch(JSON.stringify(receipt), /Private page body|Not in receipt/);
});

test('missing titles, old receipts, and failed reads retain URL fallbacks', () => {
  assert.deepEqual(publicWebReceipt('web.fetch', { url }, output({ sources: [{ ...source, title: '' }] })).sources, [
    { url, title: '' },
  ]);
  const failed = publicWebReceipt('web.fetch', { url }, null, 'failed');
  assert.deepEqual(failed.failedUrls, [url]);
  assert.equal(failed.status, 'failed');
  assert.ok(
    publicWebReceiptSchema.safeParse({ status: 'success', urls: [url], failedUrls: [], widened: false }).success,
  );
  assert.equal(publicWebReceipt('tables.list', {}, null), null);
});

test('invalid URLs and oversized queries cannot enter receipts', () => {
  const receipt = publicWebReceipt(
    'web.fetch',
    { url: 'https://localhost/private' },
    output({ sources: [{ ...source, url: 'javascript:alert(1)' }] }),
  );
  assert.deepEqual(receipt.urls, []);
  assert.equal(receipt.status, 'failed');
  assert.equal(publicWebReceipt('web.search', { query: 'x'.repeat(2001) }, null).query, undefined);
});
