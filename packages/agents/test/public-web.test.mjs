import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { searchPublicWeb, fetchPublicText } from '../src/web-fetch.ts';
import { publicWebReceipt, publicWebUrlSchema } from '../../conversations/src/public-web.ts';
import { parseToolCall, discoverTools } from '../src/tools.ts';

/** Replaces the public web settings for one test and restores them afterwards. */
function usePublicWeb(t, settings) {
  const names = ['HUNTSMAN_ENDPOINT', 'HUNTSMAN_TOKEN', 'HUNTSMAN_TOKEN_FILE', 'SEARXNG_ENDPOINT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  for (const name of names) delete process.env[name];
  Object.assign(process.env, settings);
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('page reads send the Huntsman token only when one is configured, and search never does', async t => {
  usePublicWeb(t, {
    HUNTSMAN_ENDPOINT: 'https://huntsman.example.com',
    SEARXNG_ENDPOINT: 'https://search.example.com',
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json(
      new URL(url).pathname === '/search'
        ? { results: [] }
        : { success: true, id: 'job', data: { markdown: 'Public page', links: [], metadata: {} }, cached: false },
    );
  });
  for (const token of [undefined, 'test-huntsman-token']) {
    if (token) process.env.HUNTSMAN_TOKEN = token;
    else delete process.env.HUNTSMAN_TOKEN;
    await searchPublicWeb({ query: 'news', limit: 1, window: 'any' });
    await fetchPublicText('https://example.com/page');
    const [search, scrape] = calls.slice(-2);
    assert.equal(search.url.origin, 'https://search.example.com');
    assert.equal(search.url.pathname, '/search');
    assert.equal(search.options.headers.authorization, undefined);
    assert.equal(scrape.url.href, 'https://huntsman.example.com/v1/scrape');
    assert.equal(scrape.options.method, 'POST');
    assert.equal(scrape.options.headers.authorization, token ? `Bearer ${token}` : undefined);
    assert.equal(JSON.parse(scrape.options.body).url, 'https://example.com/page');
    for (const { options } of [search, scrape]) {
      assert.equal(options.redirect, 'error');
      assert.equal(String(options.body ?? '').includes('test-huntsman-token'), false);
    }
  }
});

test('public results retain original URLs, dates, bounded text, and neutral failures', async t => {
  const calls = [];
  const endpoint = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/search')
      res.end(
        JSON.stringify({
          results:
            url.searchParams.get('time_range') === 'day'
              ? []
              : [
                  {
                    url: 'https://example.com/original',
                    title: 'Story',
                    content: 'Reported story',
                    publishedDate: '2026-10-01T09:00:00',
                  },
                  { url: 'http://localhost/private', title: 'Private', content: null, publishedDate: null },
                ],
        }),
      );
    else if (req.method !== 'POST' || url.pathname !== '/v1/scrape') res.writeHead(404).end();
    else if (calls.at(-1).body.url.endsWith('/broken'))
      res.writeHead(500).end('Huntsman http://huntsman-internal:3000 private diagnostic');
    else if (calls.at(-1).body.url.endsWith('/pending'))
      res.writeHead(202).end(JSON.stringify({ success: true, id: 'job', status: 'pending' }));
    else if (calls.at(-1).body.url.endsWith('/refused'))
      res.end(JSON.stringify({ success: false, error: 'blocked by http://huntsman-internal:3000' }));
    else
      res.end(
        JSON.stringify({
          success: true,
          id: 'job',
          data: {
            markdown: 'Verified page. '.repeat(2000),
            links: ['https://example.com/next'],
            metadata: {
              title: 'Story',
              sourceURL: 'https://example.com/redirected',
              statusCode: 200,
              fetchedAt: '2026-10-02T10:00:00Z',
              engine: 'http',
              publishedTime: '2026-10-02',
            },
          },
          cached: false,
        }),
      );
  });
  usePublicWeb(t, { HUNTSMAN_ENDPOINT: `${endpoint}/`, SEARXNG_ENDPOINT: endpoint });
  const search = await searchPublicWeb({ query: 'news', limit: 5, window: 'day' });
  assert.equal(search.status, 'success');
  assert.equal(search.widened, true);
  assert.equal(search.window, 'week');
  assert.deepEqual(search.sources, [
    {
      url: 'https://example.com/original',
      title: 'Story',
      description: 'Reported story',
      publishedAt: '2026-10-01T09:00:00',
    },
  ]);
  assert.deepEqual(
    calls
      .slice(0, 2)
      .map(call => [
        call.method,
        call.path,
        call.query.get('q'),
        call.query.get('format'),
        call.query.get('time_range'),
      ]),
    [
      ['GET', '/search', 'news', 'json', 'day'],
      ['GET', '/search', 'news', 'json', 'week'],
    ],
  );
  await searchPublicWeb({ query: 'news', limit: 5, window: 'any' });
  assert.equal(calls.at(-1).query.has('time_range'), false);
  const read = await fetchPublicText('https://example.com/original');
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: '/v1/scrape',
    query: new URLSearchParams(),
    body: {
      url: 'https://example.com/original',
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 20000,
      maxAge: 0,
    },
  });
  assert.equal(read.pages[0].text.length, 20000);
  assert.equal(read.sources[0].publishedAt, '2026-10-02');
  assert.deepEqual(publicWebReceipt('web.fetch', { url: 'https://example.com/original' }, { result: read }), {
    status: 'success',
    urls: ['https://example.com/original'],
    failedUrls: [],
    widened: false,
    sources: [{ url: 'https://example.com/original', title: 'Story' }],
  });
  for (const url of ['https://example.com/broken', 'https://example.com/pending', 'https://example.com/refused']) {
    const failed = await fetchPublicText(url);
    assert.deepEqual(failed.pages, [{ status: 'failed', url, error: 'Page unavailable. Retry or paste the text.' }]);
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(JSON.stringify(failed), /Huntsman|huntsman-internal|127\.0\.0\.1/);
  }
  assert.deepEqual(publicWebReceipt('web.search', {}, null), {
    status: 'running',
    urls: [],
    failedUrls: [],
    widened: false,
  });
});

test('public web retrieval is off without endpoints and fails neutrally without network', async t => {
  usePublicWeb(t, { HUNTSMAN_ENDPOINT: '', SEARXNG_ENDPOINT: '' });
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

test('page reads and search are enabled separately by their own endpoints', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(`${new URL(url).host}${new URL(url).pathname}`);
    return Response.json(
      new URL(url).pathname === '/search'
        ? { results: [{ url: 'https://example.com/news', title: 'News', content: '' }] }
        : { success: true, id: 'job', data: { markdown: 'Public page', links: [], metadata: {} }, cached: false },
    );
  });
  usePublicWeb(t, { SEARXNG_ENDPOINT: 'https://search.example.com' });
  assert.equal((await searchPublicWeb({ query: 'news', limit: 1, window: 'any' })).status, 'success');
  assert.equal((await fetchPublicText('https://example.com/page')).status, 'failed');
  assert.deepEqual(paths, ['search.example.com/search']);
  delete process.env.SEARXNG_ENDPOINT;
  process.env.HUNTSMAN_ENDPOINT = 'https://huntsman.example.com';
  assert.equal((await searchPublicWeb({ query: 'news', limit: 1, window: 'any' })).status, 'failed');
  assert.equal((await fetchPublicText('https://example.com/page')).status, 'success');
  assert.deepEqual(paths, ['search.example.com/search', 'huntsman.example.com/v1/scrape']);
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

test('sparse daily results survive failed widening and terminal receipts do not appear running', async t => {
  const endpoint = await listen(t, (req, res) => {
    if (new URL(req.url, 'http://localhost').searchParams.get('time_range') === 'week')
      res.writeHead(503).end('private provider failure');
    else
      res.end(
        JSON.stringify({
          results: [{ url: 'https://example.com/news', title: 'Today\u0000', content: 'Coverage' }],
        }),
      );
  });
  usePublicWeb(t, { SEARXNG_ENDPOINT: endpoint });
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
});
