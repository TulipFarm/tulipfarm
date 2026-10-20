import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { searchPublicWeb, fetchPublicText } from '../src/web-fetch.ts';
import { publicWebReceipt, publicWebUrlSchema } from '../../conversations/src/public-web.ts';
import { parseToolCall, discoverTools } from '../src/tools.ts';

test('search and scrape use Bearer authentication only when a public web key is configured', async t => {
  const names = ['FIRECRAWL_ENDPOINT', 'FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev';
  delete process.env.FIRECRAWL_API_KEY_FILE;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    return Response.json(
      String(url).endsWith('/v2/search')
        ? { success: true, data: { web: [] } }
        : { success: true, data: { markdown: 'Public page', metadata: {} } },
    );
  });
  for (const key of [undefined, 'test-cloud-key']) {
    if (key) process.env.FIRECRAWL_API_KEY = key;
    else delete process.env.FIRECRAWL_API_KEY;
    await searchPublicWeb({ query: 'news', limit: 1, window: 'any' });
    await fetchPublicText('https://example.com/page');
    const latest = calls.slice(-2);
    assert.deepEqual(
      latest.map(call => call.path),
      ['/v2/search', '/v2/scrape'],
    );
    for (const { options } of latest) {
      assert.equal(options.headers.authorization, key ? `Bearer ${key}` : undefined);
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.stringify(JSON.parse(options.body)).includes('test-cloud-key'), false);
    }
  }
});

test('public results retain original URLs, dates, bounded text, and neutral failures', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v2/search')
      res.end(
        JSON.stringify({
          success: true,
          data: {
            web:
              body.tbs === 'd'
                ? []
                : [
                    { url: 'https://example.com/original', title: 'Story', description: 'Reported story' },
                    { url: 'http://localhost/private', title: 'Private' },
                  ],
          },
        }),
      );
    else if (body.url.endsWith('/broken')) res.writeHead(500).end('Firecrawl http://web-api:3002 private diagnostic');
    else
      res.end(
        JSON.stringify({
          success: true,
          data: {
            markdown: 'Verified page. '.repeat(2000),
            metadata: { sourceURL: 'https://example.com/redirected', title: 'Story', publishedTime: '2026-10-02' },
          },
        }),
      );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.FIRECRAWL_ENDPOINT;
  process.env.FIRECRAWL_ENDPOINT = `http://127.0.0.1:${server.address().port}/`;
  try {
    const search = await searchPublicWeb({ query: 'news', limit: 5, window: 'day' });
    assert.equal(search.status, 'success');
    assert.equal(search.widened, true);
    assert.equal(search.window, 'week');
    assert.deepEqual(search.sources, [
      { url: 'https://example.com/original', title: 'Story', description: 'Reported story', publishedAt: null },
    ]);
    assert.deepEqual(
      calls.slice(0, 2).map(call => call.tbs),
      ['d', 'w'],
    );
    const read = await fetchPublicText('https://example.com/original');
    assert.equal(read.pages[0].text.length, 20000);
    assert.equal(read.sources[0].publishedAt, '2026-10-02');
    assert.deepEqual(publicWebReceipt('web.fetch', { url: 'https://example.com/original' }, { result: read }), {
      status: 'success',
      urls: ['https://example.com/original'],
      failedUrls: [],
      widened: false,
      sources: [{ url: 'https://example.com/original', title: 'Story' }],
    });
    const failed = await fetchPublicText('https://example.com/broken');
    assert.deepEqual(failed.pages, [
      { status: 'failed', url: 'https://example.com/broken', error: 'Page unavailable. Retry or paste the text.' },
    ]);
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(JSON.stringify(failed), /Firecrawl|web-api/);
    assert.deepEqual(publicWebReceipt('web.search', {}, null), {
      status: 'running',
      urls: [],
      failedUrls: [],
      widened: false,
    });
  } finally {
    if (previous === undefined) delete process.env.FIRECRAWL_ENDPOINT;
    else process.env.FIRECRAWL_ENDPOINT = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('public web retrieval is off without FIRECRAWL_ENDPOINT and fails neutrally without network', async t => {
  const previous = process.env.FIRECRAWL_ENDPOINT;
  delete process.env.FIRECRAWL_ENDPOINT;
  t.after(() => {
    if (previous !== undefined) process.env.FIRECRAWL_ENDPOINT = previous;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no network expected');
  });
  const search = await searchPublicWeb({ query: 'news', limit: 5, window: 'any' });
  assert.equal(search.status, 'failed');
  assert.deepEqual(search.sources, []);
  const read = await fetchPublicText('https://example.com/page');
  assert.equal(read.status, 'failed');
  assert.deepEqual(read.pages, [
    { status: 'failed', url: 'https://example.com/page', error: 'Page unavailable. Retry or paste the text.' },
  ]);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('search is independently permissioned and rejects requests beyond hard limits', () => {
  assert.deepEqual(
    discoverTools({ kind: 'agent', tools: ['web.search'] }).map(tool => tool.name),
    ['web.search'],
  );
  assert.deepEqual(parseToolCall({ tool: 'web.search', query: 'news' }, { kind: 'agent', tools: ['web.search'] }), {
    tool: 'web.search',
    query: 'news',
    limit: 5,
    window: 'any',
  });
  assert.throws(() => parseToolCall({ tool: 'web.search', query: 'news' }, { kind: 'agent', tools: ['web.fetch'] }));
  assert.throws(() => parseToolCall({ tool: 'web.search', query: 'news', limit: 11 }, { kind: 'chat' }));
});

test('DNS trailing dots cannot expose forbidden hosts in requests or direct receipts', async () => {
  for (const url of [
    'https://metadata.google.internal./',
    'https://web-api.internal.foo.azurecontainerapps.io./',
    'https://azurecontainerapps.io./',
    'https://localhost./',
    'https://service.local./',
    'https://metadata.google.internal../',
    'https://metadata.google.internal%2e/',
  ]) {
    assert.equal(publicWebUrlSchema.safeParse(url).success, false, url);
    await assert.rejects(fetchPublicText(url), /web-url-denied/);
    for (const status of ['running', 'completed', 'failed']) {
      const output =
        status === 'running'
          ? null
          : {
              result: {
                kind: 'public-web',
                status: 'success',
                sources: [{ url, title: 'Hidden', description: '', publishedAt: null }],
                pages: [],
                window: 'any',
                widened: false,
                retrievedAt: new Date().toISOString(),
                untrusted: true,
              },
            };
      const receipt = publicWebReceipt('web.fetch', { url }, output, status);
      assert.deepEqual(receipt.urls, []);
      assert.deepEqual(receipt.failedUrls, []);
    }
  }
  const original = 'https://example.com./original?query=public';
  assert.equal(publicWebUrlSchema.parse(original), original);
  assert.deepEqual(publicWebReceipt('web.fetch', { url: original }, null).urls, [original]);
});

test('sparse daily results survive failed widening and terminal receipts do not appear running', async () => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.tbs === 'w') res.writeHead(503).end('private provider failure');
    else
      res.end(
        JSON.stringify({
          success: true,
          data: { web: [{ url: 'https://example.com/news', title: 'Today\u0000', description: 'Coverage' }] },
        }),
      );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.FIRECRAWL_ENDPOINT;
  process.env.FIRECRAWL_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await searchPublicWeb({ query: 'news', window: 'day', limit: 5 });
    assert.equal(result.status, 'partial');
    assert.equal(result.widened, true);
    assert.deepEqual(result.sources, [
      { url: 'https://example.com/news', title: 'Today', description: 'Coverage', publishedAt: null },
    ]);
    assert.deepEqual(publicWebReceipt('web.fetch', { url: 'https://example.com/failed' }, null, 'failed'), {
      status: 'failed',
      urls: ['https://example.com/failed'],
      failedUrls: ['https://example.com/failed'],
      widened: false,
    });
    const single = await searchPublicWeb({ query: 'news', window: 'day', limit: 1 });
    assert.equal(single.widened, false);
    assert.equal(single.status, 'success');
  } finally {
    if (previous === undefined) delete process.env.FIRECRAWL_ENDPOINT;
    else process.env.FIRECRAWL_ENDPOINT = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
