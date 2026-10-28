import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { publicFileLimits } from '@tulipfarm/agents/web-fetch';
import { localWeb, send } from './local-web-fixture.mjs';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createFiles } from '../../../packages/files/src/index.ts';
import { mediaPdf, png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { createConversationActivities } from '../src/conversation-activities.ts';
import {
  anthropicText,
  anthropicTools,
  completionReply,
  isCompletionRequest,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const model = id => shipped.models.find(entry => entry.id === id);
// The shipped catalog declares no image reader yet; Sonnet becomes it, and Haiku stands in for a text-only family.
const catalog = JSON.stringify({
  ...shipped,
  models: [
    {
      ...model('claude-sonnet'),
      default: true,
      roles: [...model('claude-sonnet').roles, 'document-vision'],
      capabilities: { ...model('claude-sonnet').capabilities, imageInput: true },
    },
    {
      ...model('claude-haiku'),
      default: false,
      limits: {
        maxInputTokens: model('claude-haiku').limits.maxInputTokens,
        maxOutputTokens: model('claude-haiku').limits.maxOutputTokens,
      },
      capabilities: { ...model('claude-haiku').capabilities, imageInput: false },
    },
    { ...model('claude-opus'), default: false },
  ],
});
const recognisedText = 'INVOICE 4417 TOTAL 93.10';
const isRecognition = body => JSON.stringify(body.system ?? '').includes('You read one image');
const huntsman = 'https://huntsman.example.com';

function memoryBytes() {
  const objects = new Map();
  return {
    objects,
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  };
}

async function setup(t, { answer, images = true } = {}) {
  const f = await conversationFixture();
  const keys = [
    'ANTHROPIC_API_KEY',
    'MODEL_CATALOG',
    'MODEL_CATALOG_FILE',
    'FEATURE_FLAG_IMAGES',
    'HUNTSMAN_ENDPOINT',
    'SEARXNG_ENDPOINT',
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  process.env.MODEL_CATALOG = catalog;
  process.env.HUNTSMAN_ENDPOINT = huntsman;
  delete process.env.SEARXNG_ENDPOINT;
  if (!images) process.env.FEATURE_FLAG_IMAGES = 'false';
  delete process.env.MODEL_CATALOG_FILE;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  });
  const requests = [];
  const recognitions = [];
  const scrapes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === `${huntsman}/v1/scrape`) {
      const body = JSON.parse(options.body);
      scrapes.push(body.url);
      return Response.json({
        success: true,
        id: 'job',
        data: { markdown: `Markdown of ${body.url}`, links: [], metadata: { title: 'Scraped', statusCode: 200 } },
        cached: false,
      });
    }
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    if (isTitleRequest(body)) return Response.json(anthropicText('Links'));
    if (isRecognition(body)) {
      recognitions.push(body);
      return Response.json(
        anthropicText(JSON.stringify({ status: 'ok', text: recognisedText, description: 'A receipt' })),
      );
    }
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    requests.push(body);
    const reply = answer?.(body, requests) ?? anthropicText('Read it.');
    return reply instanceof Response ? reply : Response.json(reply);
  });
  const attachmentBytes = memoryBytes();
  const files = createFiles(f.runtime, memoryBytes());
  const w = f.workspace;
  const chat = async () => {
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    return chatId;
  };
  const activities = createConversationActivities(
    f.runtime,
    undefined,
    { attachments: attachmentBytes, snapshots: attachmentBytes },
    undefined,
    files,
  );
  /**
   * Sends one text message and runs its reply exactly as the worker does, returning the chat model requests. Each
   * entry of `attempts` is the status one attempt must end with, at generations 0, 1 and so on.
   */
  const say = async (chatId, text, familyId = 'claude-sonnet', attempts = ['completed']) => {
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: familyId,
      parts: [{ kind: 'text', text }],
    });
    const from = requests.length;
    for (const [generation, expected] of attempts.entries()) {
      // A retry is due at once here instead of after its backoff.
      await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET retry_at=NULL WHERE id=$1`, [
        sent.turnId,
      ]);
      const status = await activities.processConversationReply({
        workspaceId: w.id,
        conversationId: chatId,
        turnId: sent.turnId,
        generation,
      });
      assert.equal(status, expected);
    }
    return requests.slice(from);
  };
  const linkReads = async chatId =>
    (
      await f.db.platform.query(
        `SELECT l.url,l.outcome,l.reason,a.source_url AS "sourceUrl",a.media_type AS "mediaType",a.state
        FROM ${f.table('tf_conversation_link_reads')} l
        LEFT JOIN ${f.table('tf_conversation_attachments')} a ON a.id=l.attachment_id
        WHERE l.conversation_id=$1 ORDER BY l.ordinal`,
        [chatId],
      )
    ).rows;
  return { ...f, w, chat, say, requests, recognitions, scrapes, attachmentBytes, linkReads };
}

const userBlocks = body =>
  body.messages
    .filter(message => message.role === 'user')
    .flatMap(message =>
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
    );
const imageBlocks = body => userBlocks(body).filter(block => block.type === 'image');
const requestText = body => JSON.stringify(body.messages);
const base64 = bytes => Buffer.from(bytes).toString('base64');

test('a pasted PNG link reaches a family that reads images as an image part, kept as a bound attachment', async t => {
  const chart = await png(32, 24, '#c33');
  const web = await localWeb(t, { 'files.example.com/chart.png': send(200, chart, { 'content-type': 'image/png' }) });
  const f = await setup(t);
  const chatId = await f.chat();
  const [request] = await f.say(chatId, 'What does https://files.example.com/chart.png show?');
  assert.deepEqual(imageBlocks(request), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64(chart) } },
  ]);
  const text = requestText(request);
  assert.match(text, /source-url=\\"https:\/\/files.example.com\/chart.png\\"/);
  assert.match(text, /<chat-links>/);
  assert.match(text, /read as the file \\"chart.png\\"/);
  assert.equal(f.recognitions.length, 0);
  assert.deepEqual(web.requests, ['files.example.com/chart.png']);
  assert.deepEqual(await f.linkReads(chatId), [
    {
      url: 'https://files.example.com/chart.png',
      outcome: 'file',
      reason: null,
      sourceUrl: 'https://files.example.com/chart.png',
      mediaType: 'image/png',
      state: 'bound',
    },
  ]);
  assert.equal(f.attachmentBytes.objects.size, 1);
});

test('the same PNG link on a text-only family reaches it as recognised text', async t => {
  await localWeb(t, { 'files.example.com/receipt.png': send(200, await png(32, 24), { 'content-type': 'image/png' }) });
  const f = await setup(t);
  const chatId = await f.chat();
  const [request] = await f.say(chatId, 'Total? https://files.example.com/receipt.png', 'claude-haiku');
  assert.deepEqual(imageBlocks(request), []);
  assert.match(requestText(request), new RegExp(recognisedText));
  assert.equal(f.recognitions.length, 1);
});

test('a pasted PDF link is read as text, a page link is not pre-read, and failures are named notices', async t => {
  const limits = { ...publicFileLimits };
  t.after(() => Object.assign(publicFileLimits, limits));
  publicFileLimits.maxBytes = 64 * 1024;
  await localWeb(t, {
    'files.example.com/notes.pdf': send(200, await mediaPdf(['text', 'text']), { 'content-type': 'application/pdf' }),
    'blog.example.com/post': send(200, '<!doctype html><html><body>SECRET PAGE BODY</body></html>', {
      'content-type': 'text/html',
    }),
    'files.example.com/private.pdf': send(401, 'no'),
    'files.example.com/huge.bin': send(200, Buffer.alloc(65 * 1024, 1)),
  });
  const f = await setup(t);
  const chatId = await f.chat();
  const [request] = await f.say(
    chatId,
    'Compare https://files.example.com/notes.pdf https://blog.example.com/post https://files.example.com/private.pdf https://files.example.com/huge.bin',
    'claude-haiku',
  );
  const text = requestText(request);
  assert.match(text, /\[page 1\]\\n## Page 1 notes on the orchard\./);
  assert.match(text, /\[page 2\]\\n## Page 2 notes on the orchard\./);
  assert.doesNotMatch(text, /SECRET PAGE BODY/);
  assert.match(text, /blog.example.com\/post\\": a web page, not read; call web.fetch/);
  assert.match(text, /private.pdf\\": it needs a sign-in, so it was not read/);
  assert.match(text, /huge.bin\\": it is larger than 10 MB, so it was not read/);
  assert.deepEqual(
    (await f.linkReads(chatId)).map(read => [read.outcome, read.reason]),
    [
      ['file', null],
      ['page', null],
      ['failed', 'sign-in-required'],
      ['failed', 'too-large'],
    ],
  );
});

test('a redirect to a private address is refused before any request reaches it', async t => {
  const web = await localWeb(
    t,
    {
      'files.example.com/moved.png': send(302, '', { location: 'https://metadata.example.com/secret.png' }),
      'metadata.example.com/secret.png': send(200, 'secret'),
    },
    hostname => (hostname === 'metadata.example.com' ? ['169.254.169.254'] : ['93.184.216.34']),
  );
  const f = await setup(t);
  const chatId = await f.chat();
  const [request] = await f.say(chatId, 'Open https://files.example.com/moved.png');
  assert.match(requestText(request), /moved.png\\": it is not a public web address, so it was not read/);
  assert.deepEqual(web.requests, ['files.example.com/moved.png']);
  assert.deepEqual(web.connected, [{ hostname: 'files.example.com', address: '93.184.216.34' }]);
});

test('a name that rebinds to a private address after the check still connects to the checked address', async t => {
  const chart = await png(8, 8);
  const web = await localWeb(
    t,
    { 'rebind.example.com/chart.png': send(200, chart, { 'content-type': 'image/png' }) },
    (_hostname, count) => (count === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
  );
  const f = await setup(t);
  const chatId = await f.chat();
  const [request] = await f.say(chatId, 'See https://rebind.example.com/chart.png');
  assert.equal(imageBlocks(request).length, 1);
  assert.deepEqual(web.resolved, ['rebind.example.com'], 'the name is resolved once and never again for the socket');
  assert.deepEqual(web.connected, [{ hostname: 'rebind.example.com', address: '93.184.216.34' }]);
});

test('links past the fifth are named not read, and a later turn reads the kept copy without refetching', async t => {
  const chart = await png(8, 8, '#13a');
  const routes = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map(n => [`files.example.com/${n}.png`, send(200, chart, { 'content-type': 'image/png' })]),
  );
  const web = await localWeb(t, routes);
  const f = await setup(t);
  const chatId = await f.chat();
  const links = [1, 2, 3, 4, 5, 6].map(n => `https://files.example.com/${n}.png`);
  const [first] = await f.say(chatId, `All of these: ${links.join(' ')}`);
  assert.equal(imageBlocks(first).length, 5);
  assert.match(requestText(first), /6.png\\": not read, because only the first 5 links of a message are read/);
  assert.equal(web.requests.length, 5);
  assert.ok(!web.requests.includes('files.example.com/6.png'));
  assert.equal(f.attachmentBytes.objects.size, 5, 'each read link is kept as its own attachment');
  const [second] = await f.say(chatId, 'And the first one again?');
  assert.equal(web.requests.length, 5, 'no link is fetched again');
  assert.ok(imageBlocks(second).length >= 1);
  assert.match(requestText(second), /source-url=\\"https:\/\/files.example.com\/1.png\\"/);
});

test('with web access off the links are named as not read because web access is off', async t => {
  const web = await localWeb(t, {});
  const f = await setup(t);
  delete process.env.HUNTSMAN_ENDPOINT;
  const chatId = await f.chat();
  const [request] = await f.say(chatId, 'Read https://files.example.com/chart.png');
  assert.match(requestText(request), /not read because web access is off/);
  assert.deepEqual(web.requests, []);
  assert.deepEqual(await f.linkReads(chatId), [], 'web access off is not kept, so the link is read once it is on');
});

test('web.fetch on an image link shows the image after the tool results to a family that reads images', async t => {
  const chart = await png(20, 10, '#d22');
  const web = await localWeb(t, { 'files.example.com/fig': send(200, chart, { 'content-type': 'image/png' }) });
  const f = await setup(t, {
    answer: (_body, requests) =>
      requests.length === 1
        ? anthropicTools([{ tool: 'web.fetch', url: 'https://files.example.com/fig' }])
        : anthropicText('A red rectangle.'),
  });
  const chatId = await f.chat();
  const requests = await f.say(chatId, 'Fetch the figure from files dot example dot com slash fig');
  const [result] = toolResults(requests[1]);
  const value = typeof result === 'string' ? result : JSON.stringify(result);
  assert.match(value, /\[image 1, shown after the tool results\]/);
  assert.match(value, /public-web/);
  const last = requests[1].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(
    last.content.some(block => block.type === 'text' && block.text.includes('Image fetched by web.fetch from')),
  );
  assert.deepEqual(
    last.content.filter(block => block.type === 'image').map(block => block.source.data),
    [base64(chart)],
  );
  assert.deepEqual(f.scrapes, [], 'a file is never sent to Huntsman');
  assert.deepEqual(web.requests, ['files.example.com/fig']);
  assert.equal(f.attachmentBytes.objects.size, 0, 'a web.fetch file is not kept');
});

test('web.fetch on a PDF link returns its text, and on a page falls through to Huntsman', async t => {
  await localWeb(t, {
    'files.example.com/notes.pdf': send(200, await mediaPdf(['text']), { 'content-type': 'application/pdf' }),
    'blog.example.com/post': send(200, '<html><body>post</body></html>', { 'content-type': 'text/html' }),
  });
  const f = await setup(t, {
    answer: (_body, requests) =>
      requests.length === 1
        ? anthropicTools([
            { tool: 'web.fetch', url: 'https://files.example.com/notes.pdf' },
            { tool: 'web.fetch', url: 'https://blog.example.com/post' },
          ])
        : anthropicText('Done.'),
  });
  const chatId = await f.chat();
  const requests = await f.say(chatId, 'Fetch both', 'claude-haiku');
  const [pdf, page] = toolResults(requests[1]).map(result =>
    typeof result === 'string' ? result : JSON.stringify(result),
  );
  assert.match(pdf, /Page 1 notes on the orchard/);
  assert.match(pdf, /fetched-file url=/);
  assert.match(page, /Markdown of https:\/\/blog.example.com\/post/);
  assert.deepEqual(f.scrapes, ['https://blog.example.com/post']);
});

test('web.fetch on a large quote-heavy JSON file returns its start marked partial', async t => {
  const rows = Array.from({ length: 4000 }, (_, index) => ({ id: `row-${index}`, note: `"quoted" ${index}` }));
  await localWeb(t, {
    'files.example.com/rows.json': send(200, JSON.stringify(rows, null, 2), { 'content-type': 'application/json' }),
  });
  const f = await setup(t, {
    answer: (_body, requests) =>
      requests.length === 1
        ? anthropicTools([{ tool: 'web.fetch', url: 'https://files.example.com/rows.json' }])
        : anthropicText('Done.'),
  });
  const chatId = await f.chat();
  const requests = await f.say(chatId, 'Fetch the rows', 'claude-haiku');
  const [result] = toolResults(requests[1]);
  assert.doesNotMatch(result, /result-too-large/);
  assert.match(result, /"status":"partial"/);
  assert.match(result, /Only part of it is included/);
  const firstRow = '"id": "row-0",\n    "note": "\\"quoted\\" 0"';
  assert.ok(result.includes(JSON.stringify(firstRow).slice(1, -1)), 'the first row reaches the model');
  assert.doesNotMatch(result, /row-3999/);
});

test('with the images flag off links are not fetched and web.fetch only uses Huntsman', async t => {
  const chart = await png(8, 8);
  const web = await localWeb(t, { 'files.example.com/chart.png': send(200, chart, { 'content-type': 'image/png' }) });
  const f = await setup(t, {
    images: false,
    answer: (_body, requests) =>
      requests.length === 1
        ? anthropicTools([{ tool: 'web.fetch', url: 'https://files.example.com/chart.png' }])
        : anthropicText('Done.'),
  });
  const chatId = await f.chat();
  const requests = await f.say(chatId, 'Look at https://files.example.com/chart.png');
  assert.deepEqual(web.requests, [], 'nothing is fetched outside Huntsman');
  assert.deepEqual(f.scrapes, ['https://files.example.com/chart.png']);
  for (const request of requests) {
    assert.deepEqual(imageBlocks(request), []);
    assert.doesNotMatch(requestText(request), /chat-links|source-url|fetched-file/);
  }
  assert.match(JSON.stringify(toolResults(requests[1])), /Markdown of https:\/\/files.example.com\/chart.png/);
  assert.deepEqual(await f.linkReads(chatId), []);
});

test('a retried turn reads each kept link once and fetches nothing again', async t => {
  const chart = await png(8, 8, '#2a7');
  const web = await localWeb(t, { 'files.example.com/chart.png': send(200, chart, { 'content-type': 'image/png' }) });
  const f = await setup(t, {
    answer: (_body, requests) =>
      requests.length === 1 ? new Response('overloaded', { status: 529 }) : anthropicText('Read it.'),
  });
  const chatId = await f.chat();
  const requests = await f.say(chatId, 'See https://files.example.com/chart.png', 'claude-sonnet', [
    'retry',
    'completed',
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(web.requests, ['files.example.com/chart.png']);
  const retried = requestText(requests[1]);
  assert.equal(retried.match(/source-url=/g).length, 1, 'the kept link is one file block');
  assert.equal(imageBlocks(requests[1]).length, 1);
});
