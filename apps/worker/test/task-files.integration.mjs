import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgentExecutor } from '@tulipfarm/agents';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createFiles } from '../../../packages/files/src/index.ts';
import { mediaPdf, png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { createTaskComposition } from '../src/task-composition.ts';
import { localWeb, send } from './local-web-fixture.mjs';
import { anthropicText } from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const model = id => shipped.models.find(entry => entry.id === id);
const textOnly = entry => ({
  ...entry,
  limits: { maxInputTokens: entry.limits.maxInputTokens, maxOutputTokens: entry.limits.maxOutputTokens },
  capabilities: { ...entry.capabilities, imageInput: false },
});
/** Sonnet reads images and recognises them; Haiku stands in for a text-only family. `reader` is the task's default. */
const catalog = reader =>
  JSON.stringify({
    ...shipped,
    models: [
      {
        ...model('claude-sonnet'),
        default: reader === 'claude-sonnet',
        roles: [...model('claude-sonnet').roles, 'document-vision'],
        capabilities: { ...model('claude-sonnet').capabilities, imageInput: true },
      },
      { ...textOnly(model('claude-haiku')), default: reader === 'claude-haiku' },
    ],
  });
const recognisedText = 'INVOICE 4417 TOTAL 93.10';
const isRecognition = body => JSON.stringify(body.system ?? '').includes('You read one image');
function memoryBytes() {
  const objects = new Map();
  return {
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
    close: async () => {},
  };
}

async function setup(t, { reader = 'claude-sonnet', images = true } = {}) {
  const f = await conversationFixture();
  const keys = [
    'ANTHROPIC_API_KEY',
    'MODEL_CATALOG',
    'MODEL_CATALOG_FILE',
    'FEATURE_FLAG_IMAGES',
    'FIRECRAWL_ENDPOINT',
  ];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  process.env.MODEL_CATALOG = catalog(reader);
  process.env.FEATURE_FLAG_IMAGES = String(images);
  // The public web is on; no test here scrapes a page.
  process.env.FIRECRAWL_ENDPOINT = 'https://firecrawl.invalid';
  delete process.env.MODEL_CATALOG_FILE;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  });
  const requests = [];
  const recognitions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    if (isRecognition(body)) {
      recognitions.push(body);
      return Response.json(
        anthropicText(JSON.stringify({ status: 'ok', text: recognisedText, description: 'A receipt' })),
      );
    }
    requests.push(body);
    return Response.json(anthropicText('Read it.', { model: body.model }));
  });
  const w = f.workspace;
  const agent = await savedTaskAgent(f.db, w, f.runtime, w.userId, w.membershipId, [], ['rows.list']);
  await createAgentExecutor({ runtime: f.runtime }).configure(
    w.id,
    { kind: 'human', userId: w.userId, membershipId: w.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const objects = memoryBytes();
  const files = createFiles(f.runtime, objects);
  const tasks = createAgentTasks(f.runtime);
  const upload = async (name, mediaType, content) =>
    (await files.upload(w.id, w.userId, randomUUID(), { name, parentId: null, mediaType }, Buffer.from(content))).id;
  /** Starts a task and steps it until it stops waiting on the worker. */
  const run = async (text, sources = []) => {
    const task = await tasks.start(w.id, w.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      scope: [],
      text,
      sources,
      limits: { toolCalls: 10, credits: 100, activeMilliseconds: 600000 },
    });
    for (let n = 0; n < 8 && (await tasks.read(w.id, w.userId, task.id)).status === 'pending'; n++) {
      const composition = createTaskComposition(f.runtime, undefined, undefined, undefined, objects);
      try {
        await composition.activities.processAgentTaskStep(w.id, task.id);
      } finally {
        await composition.close();
      }
    }
    const row = (
      await f.db.platform.query(`SELECT status,pause_reason FROM ${f.table('tf_agent_tasks')} WHERE id=$1`, [task.id])
    ).rows[0];
    return { ...row, history: await tasks.history(w.id, w.userId, task.id) };
  };
  return { ...f, requests, recognitions, upload, run };
}

/** The user turn the task's files are sent in: the turn after the task prompt. */
const filesTurn = body => {
  const turn = body.messages.at(-1);
  assert.equal(turn.role, 'user');
  assert.ok(Array.isArray(turn.content), 'the files reach the model as a content turn');
  return turn.content;
};
const text = parts =>
  parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');

test('a task reads an image file source as an image and a PDF source as text on an image-reading family', async t => {
  const f = await setup(t);
  const slip = await f.upload('slip.png', 'image/png', await png(32, 24));
  const notes = await f.upload('notes.pdf', 'application/pdf', await mediaPdf(['text']));
  const task = await f.run('What do these files say?', [
    { kind: 'file', fileId: slip },
    { kind: 'file', fileId: notes },
  ]);
  assert.equal(task.status, 'completed');
  assert.equal(f.requests.length, 1);
  const parts = filesTurn(f.requests[0]);
  const images = parts.filter(part => part.type === 'image');
  assert.equal(images.length, 1, 'the PNG reaches the model as one image part');
  assert.equal(images[0].source.type, 'base64');
  assert.equal(images[0].source.media_type, 'image/png');
  assert.match(text(parts), /name="slip.png"/);
  assert.match(text(parts), /name="notes.pdf"/);
  assert.match(text(parts), /## Page 1 notes on the orchard/);
  assert.equal(f.recognitions.length, 0, 'an image-reading family reads the image itself');
  const prompt = JSON.parse(f.requests[0].messages.at(-2).content);
  assert.deepEqual(prompt.files, [], 'the legacy prompt carries no file text');
  const receipts = task.history.messages.flatMap(message => message.sources ?? []).filter(source => source.read);
  assert.deepEqual(receipts.map(source => source.fileId).sort(), [slip, notes].sort(), 'each read is recorded');
});

test('a task on a text-only family reads an image file source as recognised text', async t => {
  const f = await setup(t, { reader: 'claude-haiku' });
  const slip = await f.upload('slip.png', 'image/png', await png(32, 24));
  const task = await f.run('What is the total?', [{ kind: 'file', fileId: slip }]);
  assert.equal(task.status, 'completed');
  assert.equal(f.recognitions.length, 1);
  assert.match(f.recognitions[0].model, /sonnet/, 'the image is recognised by the document-vision model');
  assert.match(f.requests[0].model, /haiku/);
  const parts = filesTurn(f.requests[0]);
  assert.equal(
    parts.some(part => part.type === 'image'),
    false,
    'a text-only family gets no image part',
  );
  assert.match(text(parts), /\[Recognised image\]\n/);
  assert.match(text(parts), new RegExp(recognisedText));
});

test('a task file that cannot be read pauses the task with the file reason and names the file', async t => {
  const f = await setup(t);
  const memo = await f.upload('memo.mp3', 'audio/mpeg', Buffer.from('ID3 not really audio'));
  const task = await f.run('Summarise the memo', [{ kind: 'file', fileId: memo }]);
  assert.equal(task.status, 'paused');
  assert.equal(task.pause_reason, 'file');
  assert.match(task.history.messages.at(-1).text, /The file "memo.mp3" could not be read\./);
  assert.equal(f.requests.length, 0, 'an unreadable file never reaches the model');
});

test('a link in the task instructions is read like a chat message link', async t => {
  const f = await setup(t);
  const chart = await png(40, 30, '#123');
  const web = await localWeb(t, {
    'charts.example/q3.png': send(200, chart, { 'content-type': 'image/png' }),
  });
  const task = await f.run('Describe https://charts.example/q3.png please');
  assert.equal(task.status, 'completed');
  assert.deepEqual(web.requests, ['charts.example/q3.png']);
  const parts = filesTurn(f.requests[0]);
  assert.equal(parts.filter(part => part.type === 'image').length, 1, 'the linked image reaches the model as an image');
  assert.match(text(parts), /url="https:\/\/charts.example\/q3.png"/);
});

test('with the images flag off a task keeps the legacy text reader', async t => {
  const f = await setup(t, { images: false });
  const web = await localWeb(t, {});
  const terms = await f.upload('terms.txt', 'text/plain', 'Suppliers are paid within 30 days.');
  const read = await f.run('When are suppliers paid? https://charts.example/q3.png', [{ kind: 'file', fileId: terms }]);
  assert.equal(read.status, 'completed');
  const body = f.requests[0];
  const prompt = JSON.parse(body.messages.at(-1).content);
  assert.equal(prompt.files.length, 1, 'the file text rides in the prompt as before');
  assert.equal(prompt.files[0].text, 'Suppliers are paid within 30 days.');
  assert.doesNotMatch(JSON.stringify(body), /"type":"image"/);
  assert.deepEqual(web.requests, [], 'instruction links are not fetched');

  const slip = await f.upload('slip.png', 'image/png', await png(32, 24));
  const refused = await f.run('What is the total?', [{ kind: 'file', fileId: slip }]);
  assert.equal(refused.status, 'paused');
  assert.equal(refused.pause_reason, 'file');
  assert.equal(
    refused.history.messages.at(-1).text,
    'An attached file exceeds the supported text format or size, or file storage is not configured.',
  );
  assert.equal(f.requests.length, 1);
});
