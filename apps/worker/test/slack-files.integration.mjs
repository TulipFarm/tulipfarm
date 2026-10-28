import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import { createSlackDirectMessages } from '../../../packages/slack/src/direct-messages.ts';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { localWeb, send } from './local-web-fixture.mjs';
import { anthropicText, completionReply, isCompletionRequest, isTitleRequest } from './native-chat-fixture.mjs';

// The held-for-credits test exhausts the workspace balance, so work is funded from the credit account.
await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const model = id => shipped.models.find(entry => entry.id === id);
// As in conversation-images: Sonnet reads images and Haiku stands in for a text-only family.
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
const recognisedText = 'WHITEBOARD SAYS SHIP FRIDAY';
const isRecognition = body => JSON.stringify(body.system ?? '').includes('You read one image');
const fileUrl = 'https://files.slack.com/files-pri/TONE-F1/whiteboard.png';

/** Links the DM sender UPERSON to the workspace member and grants them the installation, as Slack linking does. */
async function authorizeDm(f) {
  const id = randomUUID();
  const credential = f.options.cipher.encrypt(
    {
      workspaceId: f.workspace.id,
      installationId: f.installationId,
      generation: 1,
      kind: 'user',
      identityId: id,
      membershipId: f.workspace.membershipId,
      slackUserId: 'UPERSON',
    },
    'synthetic-user-token',
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UPERSON',$3,$4,'authorized',$5,ARRAY['im:history'])`,
    [id, f.installationId, f.workspace.userId, f.workspace.membershipId, credential],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [f.installationId, f.workspace.membershipId],
  );
}

function memoryBytes() {
  const objects = new Map();
  const store = {
    objects,
    /** While set, every write fails as an unavailable object store does. */
    failing: false,
    puts: 0,
    /** Runs before every write with its 1-based call number, to hold or fail particular writes. */
    beforePut: async () => {},
    putIfAbsent: async (key, body) => {
      await store.beforePut(++store.puts);
      if (store.failing) throw new Error('chat-object-write-unavailable');
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  };
  return store;
}

/**
 * A Slack workspace whose installation has `scopes`, with one linked DM sender, Slack serving `files` at their private
 * URLs to the bot token only, and the Anthropic API faked so each chat request body is kept.
 */
async function setup(t, { scopes = ['chat:write', 'files:read'], images = true, family = 'claude-sonnet' } = {}) {
  const saved = Object.fromEntries(
    ['ANTHROPIC_API_KEY', 'MODEL_CATALOG', 'MODEL_CATALOG_FILE', 'FEATURE_FLAG_IMAGES', 'HUNTSMAN_ENDPOINT'].map(
      key => [key, process.env[key]],
    ),
  );
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  process.env.MODEL_CATALOG = catalog;
  process.env.FEATURE_FLAG_IMAGES = String(images);
  process.env.HUNTSMAN_ENDPOINT = 'https://huntsman.example.com';
  delete process.env.MODEL_CATALOG_FILE;
  const f = await promptFixture();
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await f.close();
  });
  await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET scopes=$1`, [scopes]);
  await authorizeDm(f);
  const served = new Map();
  const downloads = [];
  const slack = { stalled: false };
  /** Responses for particular file URLs, on any host, in place of the default file server. */
  const routes = new Map();
  const fetcher = async (url, init) => {
    const route = routes.get(url);
    if (!route && new URL(url).hostname !== 'files.slack.com') return f.options.fetcher(url, init);
    downloads.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (route) return route(init);
    if (slack.stalled)
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    const body = served.get(url);
    if (!body || new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-bot-token')
      return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  };
  const requests = [];
  const recognitions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    if (isTitleRequest(body)) return Response.json(anthropicText('Slack files'));
    if (isRecognition(body)) {
      recognitions.push(body);
      return Response.json(
        anthropicText(JSON.stringify({ status: 'ok', text: recognisedText, description: 'A whiteboard' })),
      );
    }
    if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
    requests.push(body);
    return Response.json(anthropicText('Read it.'));
  });
  const bytes = memoryBytes();
  const dm = createSlackDirectMessages({
    ...f.options,
    fetcher,
    modelFamilyId: family,
    files: { enabled: async () => images, bytes },
  });
  const activities = createConversationActivities(
    f.runtime,
    undefined,
    { attachments: bytes, snapshots: bytes },
    undefined,
  );
  const failures = [];
  /**
   * One dispatch pass as the worker runs it: held messages are admitted, and each message with files is admitted by its
   * own activity, whose failure is the activity's alone.
   */
  async function admit() {
    const admission = await dm.admitPending(f.workspace.id);
    failures.push(...admission.failures);
    for (const work of admission.files) await dm.admitFiles(work).catch(error => failures.push(error));
  }
  const admitted = async eventId =>
    (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`, [eventId]))
      .rowCount === 1;
  /** Receives one DM, admits it and runs its reply as the worker does, returning the chat requests and the turn. */
  async function receive(extra) {
    const eventId = await f.event('UPERSON', 'DONE', extra);
    await admit();
    const admitted = (
      await f.db.platform.query(
        `SELECT conversation_id,turn_id FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`,
        [eventId],
      )
    ).rows[0];
    assert.ok(admitted, 'the direct message was admitted');
    const from = requests.length;
    const status = await activities.processConversationReply({
      workspaceId: f.workspace.id,
      conversationId: admitted.conversation_id,
      turnId: admitted.turn_id,
      generation: 0,
    });
    assert.equal(status, 'completed');
    const parts = (
      await f.db.platform.query(
        `SELECT p.kind,p.text,a.filename,a.media_type FROM ${f.table('tf_conversation_parts')} p LEFT JOIN ${f.table('tf_conversation_attachments')} a ON a.id=p.attachment_id
        WHERE p.message_id=$1 ORDER BY p.ordinal`,
        [eventId],
      )
    ).rows;
    return { requests: requests.slice(from), parts };
  }
  return { ...f, dm, served, routes, downloads, slack, recognitions, bytes, failures, admit, admitted, receive };
}

const fileShare = (files, text = '') => ({ text, subtype: 'file_share', files });
const whiteboard = {
  id: 'F1',
  name: 'whiteboard.png',
  title: 'Whiteboard',
  mimetype: 'image/png',
  url_private: fileUrl,
};
const userBlocks = body =>
  body.messages
    .filter(message => message.role === 'user')
    .flatMap(message =>
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
    );
const imageBlocks = body => userBlocks(body).filter(block => block.type === 'image');
const requestText = body => JSON.stringify(body.messages);

test('a file-only Slack DM with a PNG reaches an image-reading family as an image part', async t => {
  const f = await setup(t);
  const image = await png(32, 24, '#3a3');
  f.served.set(fileUrl, image);
  const { requests, parts } = await f.receive(fileShare([whiteboard]));
  assert.deepEqual(f.downloads, [{ url: fileUrl, authorization: 'Bearer synthetic-bot-token' }]);
  assert.deepEqual(
    parts.map(part => [part.kind, part.filename, part.media_type]),
    [['attachment', 'whiteboard.png', 'image/png']],
    'a file-only message is only its attachment',
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(imageBlocks(requests[0]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(image).toString('base64') } },
  ]);
  assert.match(requestText(requests[0]), /name=\\"whiteboard.png\\"/);
  assert.doesNotMatch(requestText(requests[0]), /contents not read/);
  assert.equal(f.recognitions.length, 0);
});

test('the same Slack PNG reaches a text family as recognised text, and the text of the message is kept', async t => {
  const f = await setup(t, { family: 'claude-haiku' });
  f.served.set(fileUrl, await png(32, 24, '#3a3'));
  const { requests, parts } = await f.receive(fileShare([whiteboard], 'What does the board say?'));
  assert.deepEqual(
    parts.map(part => [part.kind, part.text ?? part.filename]),
    [
      ['text', 'What does the board say?'],
      ['attachment', 'whiteboard.png'],
    ],
  );
  assert.deepEqual(imageBlocks(requests[0]), []);
  assert.ok(requestText(requests[0]).includes(recognisedText));
  assert.equal(f.recognitions.length, 1);
});

test('without files:read a shared file is named with the permission to update, and nothing is downloaded', async t => {
  const f = await setup(t, { scopes: ['chat:write'] });
  f.served.set(fileUrl, await png(32, 24));
  const { requests, parts } = await f.receive(fileShare([whiteboard]));
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(
    parts.map(part => part.kind),
    ['text'],
  );
  assert.match(parts[0].text, /^\[File not read: whiteboard.png; .*does not have permission to read files/);
  assert.match(parts[0].text, /update Slack permissions/);
  assert.match(requestText(requests[0]), /File not read: whiteboard.png/);
  assert.deepEqual(imageBlocks(requests[0]), []);
});

test('a file Slack does not return, or past the fifth, is named with the reason and the rest are read', async t => {
  const f = await setup(t);
  const files = Array.from({ length: 6 }, (_, index) => ({
    id: `F${index}`,
    name: `page-${index}.png`,
    mimetype: 'image/png',
    url_private: `https://files.slack.com/files-pri/TONE-F${index}/page-${index}.png`,
  }));
  for (const file of files.slice(1)) f.served.set(file.url_private, await png(16, 16));
  const { requests, parts } = await f.receive(fileShare(files));
  assert.equal(f.downloads.length, 5);
  assert.deepEqual(
    parts.map(part => part.filename ?? part.kind),
    ['text', 'page-1.png', 'page-2.png', 'page-3.png', 'page-4.png'],
  );
  assert.match(parts[0].text, /\[File not read: page-0.png; Slack did not return it\]/);
  assert.match(parts[0].text, /\[File not read: page-5.png; only five files are read per message\]/);
  assert.equal(imageBlocks(requests[0]).length, 4);
  assert.equal(f.bytes.objects.size, 4, 'no bytes are kept for files that were not read');
});

test('a link in a Slack DM is read as a file by the chat link path', async t => {
  const chart = await png(20, 20, '#36c');
  const web = await localWeb(t, { 'files.example.com/chart.png': send(200, chart, { 'content-type': 'image/png' }) });
  const f = await setup(t);
  const { requests } = await f.receive({ text: 'What does https://files.example.com/chart.png show?' });
  assert.deepEqual(web.requests, ['files.example.com/chart.png']);
  assert.deepEqual(imageBlocks(requests[0]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(chart).toString('base64') } },
  ]);
});

test('with images off a file share is unchanged: named by its metadata, nothing downloaded', async t => {
  const f = await setup(t, { images: false });
  f.served.set(fileUrl, await png(32, 24));
  const { requests, parts } = await f.receive(fileShare([whiteboard], 'Look'));
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(
    parts.map(part => part.kind),
    ['text'],
  );
  assert.match(parts[0].text, /^Look\n\[File: metadata only; contents not read\]\nWhiteboard\nimage\/png$/);
  assert.deepEqual(imageBlocks(requests[0]), []);
  const eventId = await f.event('UPERSON', 'DONE', fileShare([whiteboard]));
  const dm = createSlackDirectMessages(f.options);
  await dm.admitPending(f.workspace.id);
  assert.equal(
    (await f.db.platform.query(`SELECT 1 FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`, [eventId])).rowCount,
    1,
    'a metadata line is text, so the legacy path admits it as before',
  );
});

test('a file DM held because credits ran out is not downloaded again on later passes', async t => {
  const f = await setup(t);
  f.served.set(fileUrl, await png(32, 24));
  await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=0`);
  const eventId = await f.event('UPERSON', 'DONE', fileShare([whiteboard]));
  for (let pass = 0; pass < 3; pass++) await f.admit();
  assert.equal(await f.admitted(eventId), false, 'the message waits for credits');
  assert.equal(f.downloads.length, 0, 'a held message is not downloaded while it waits');
  assert.equal(f.bytes.objects.size, 0);
  await f.db.platform.query(`UPDATE ${f.table('tf_credit_account')} SET available=granted`);
  await f.admit();
  assert.equal(await f.admitted(eventId), true);
  assert.equal(f.downloads.length, 1);
});

test('a file DM whose bytes cannot be stored does not hold up a later text DM', async t => {
  const f = await setup(t);
  f.served.set(fileUrl, await png(32, 24));
  f.bytes.failing = true;
  const fileEvent = await f.event('UPERSON', 'DONE', fileShare([whiteboard]));
  const textEvent = await f.event('UPERSON', 'DONE', { text: 'Anything new?' });
  await f.admit();
  assert.equal(await f.admitted(textEvent), true, 'the text DM is admitted');
  assert.equal(await f.admitted(fileEvent), false);
  assert.ok(f.failures.length > 0, 'the staging failure is reported');
  f.bytes.failing = false;
  await f.admit();
  assert.equal(await f.admitted(fileEvent), true, 'the file DM is admitted once storage is back');
});

test('a Slack download that never finishes does not delay admission for the workspace', async t => {
  const f = await setup(t);
  f.slack.stalled = true;
  await f.event('UPERSON', 'DONE', fileShare([whiteboard]));
  const textEvent = await f.event('UPERSON', 'DONE', { text: 'Anything new?' });
  const started = Date.now();
  const pass = f.dm.admitPending(f.workspace.id);
  const timer = new Promise(resolve => setTimeout(resolve, 3000, 'stalled'));
  assert.notEqual(await Promise.race([pass, timer]), 'stalled', 'admission finishes without waiting on Slack');
  assert.ok(Date.now() - started < 3000);
  assert.equal(f.downloads.length, 0, 'admission itself downloads nothing');
  assert.equal(await f.admitted(textEvent), true);
});

test('an overlapping run for the same file DM never leaves an attachment whose bytes are gone', async t => {
  const f = await setup(t);
  const notes = { ...whiteboard, id: 'F2', name: 'notes.png', url_private: `${fileUrl}-2` };
  f.served.set(whiteboard.url_private, await png(32, 24));
  f.served.set(notes.url_private, await png(24, 32));
  const eventId = await f.event('UPERSON', 'DONE', fileShare([whiteboard, notes]));
  const admission = await f.dm.admitPending(f.workspace.id);
  assert.deepEqual(admission.files, [{ workspaceId: f.workspace.id, eventId }]);
  const [work] = admission.files;
  let failFirst, firstStuck;
  const firstAtSecondFile = new Promise(resolve => (firstStuck = resolve));
  let first;
  f.bytes.beforePut = async call => {
    if (call === 2) {
      firstStuck();
      await new Promise(resolve => (failFirst = resolve));
      throw new Error('chat-object-write-unavailable');
    }
    if (call === 4) {
      failFirst();
      await first.catch(() => {});
    }
  };
  first = f.dm.admitFiles(work);
  await firstAtSecondFile;
  const later = await f.dm.admitFiles(work);
  await assert.rejects(first, /chat-object-write-unavailable/);
  assert.equal(later, true, 'the later run admits the message');
  const attachments = (
    await f.db.platform.query(
      `SELECT a.filename,a.object_key FROM ${f.table('tf_conversation_parts')} p JOIN ${f.table('tf_conversation_attachments')} a ON a.id=p.attachment_id WHERE p.message_id=$1 ORDER BY p.ordinal`,
      [eventId],
    )
  ).rows;
  assert.deepEqual(
    attachments.map(row => [row.filename, f.bytes.objects.has(`${f.workspace.id}/${row.object_key}`)]),
    [
      ['whiteboard.png', true],
      ['notes.png', true],
    ],
    'every attachment of the message has its bytes',
  );
  assert.equal(f.bytes.objects.size, 2, 'the failed run left no bytes behind');
});

const temporalCli = process.env.TEST_TEMPORAL_CLI ?? 'temporal';
const withoutTemporal = spawnSync(temporalCli, ['--version']).error ? 'the temporal CLI is not installed' : false;

/**
 * A local Temporal dev server running the compiled workflows on their own task queue, with `f`'s file DM activities.
 * `pass` runs one dispatch pass as `slack-composition.ts` does, starting each file DM's own workflow.
 */
async function temporal(t, f, { workflowModules = [] } = {}) {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = `127.0.0.1:${reservation.address().port}`;
  await new Promise(resolve => reservation.close(resolve));
  const [ip, port] = address.split(':');
  const server = spawn(
    temporalCli,
    ['server', 'start-dev', '--ip', ip, '--port', port, '--headless', '--log-level', 'error'],
    { stdio: 'ignore' },
  );
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
  });
  let clientConnection;
  for (let i = 0; i < 100 && !clientConnection; i++)
    clientConnection = await Connection.connect({ address, connectTimeout: '1 second' }).catch(async () => {
      assert.equal(server.exitCode, null, 'the Temporal dev server is running');
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  assert.ok(clientConnection, 'the Temporal dev server accepts connections');
  const connection = await NativeConnection.connect({ address });
  const taskQueue = `slack-files-${randomUUID()}`;
  const worker = await Worker.create({
    connection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
    interceptors: { workflowModules },
    activities: {
      admitSlackDirectMessageFiles: f.dm.admitFiles,
      admitSlackDirectMessageUnreadFiles: f.dm.admitUnreadFiles,
    },
  });
  const running = worker.run();
  t.after(async () => {
    worker.shutdown();
    await running;
    await connection.close();
    await clientConnection.close();
  });
  const client = new Client({ connection: clientConnection });
  async function pass() {
    const handles = [];
    for (const work of (await f.dm.admitPending(f.workspace.id)).files)
      handles.push(
        await client.workflow.start('slackDirectMessageFiles', {
          workflowId: `slack-dm-files-${work.workspaceId}-${work.eventId}`,
          taskQueue,
          args: [work],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        }),
      );
    return handles;
  }
  return { client, pass };
}

test(
  'a file DM whose bytes can never be stored is not downloaded again on every dispatch pass',
  { timeout: 120_000, skip: withoutTemporal },
  async t => {
    const f = await setup(t);
    f.served.set(fileUrl, await png(32, 24));
    f.bytes.failing = true;
    const { client, pass } = await temporal(t, f);
    const eventId = await f.event('UPERSON', 'DONE', fileShare([whiteboard]));
    const [handle] = await pass();
    for (let tick = 0; tick < 4; tick++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      await pass();
    }
    assert.equal(f.downloads.length, 1, 'five passes over eight seconds download the file once');
    f.bytes.failing = false;
    assert.equal(await client.workflow.getHandle(handle.workflowId).result(), true, 'a later attempt admits it');
    assert.equal(await f.admitted(eventId), true);
    assert.equal(f.downloads.length, 2);
  },
);

test(
  'a file DM whose bytes are never stored is admitted with the file named as not read, and its thread moves on',
  { timeout: 120_000, skip: withoutTemporal },
  async t => {
    const f = await setup(t);
    f.served.set(fileUrl, await png(32, 24));
    f.bytes.failing = true;
    const { pass } = await temporal(t, f, {
      workflowModules: [fileURLToPath(new URL('./fixtures/short-activity-backoff.mjs', import.meta.url))],
    });
    const fileEvent = await f.event('UPERSON', 'DONE', fileShare([whiteboard], 'Can you read this?'));
    const [{ ts: root }] = (
      await f.db.platform.query(`SELECT payload->>'ts' AS ts FROM ${f.table('tf_slack_events')} WHERE id=$1`, [
        fileEvent,
      ])
    ).rows;
    const textEvent = await f.event('UPERSON', 'DONE', { text: 'Any luck?', thread_ts: root });
    const [handle] = await pass();
    assert.equal(await f.admitted(textEvent), false, 'the reply waits for the file DM before it in its thread');
    assert.equal(await handle.result(), true, 'the last failed attempt still admits the message');
    assert.equal(f.downloads.length, 10, 'every attempt downloads the file once');
    const parts = (
      await f.db.platform.query(
        `SELECT kind,text FROM ${f.table('tf_conversation_parts')} WHERE message_id=$1 ORDER BY ordinal`,
        [fileEvent],
      )
    ).rows;
    assert.deepEqual(parts, [
      {
        kind: 'text',
        text: 'Can you read this?\n[File not read: whiteboard.png; reading it failed after repeated attempts]',
      },
    ]);
    assert.deepEqual(await pass(), [], 'no file workflow starts again');
    assert.equal(await f.admitted(textEvent), true, 'the reply in the same thread is admitted');
    assert.equal(f.downloads.length, 10, 'nothing is downloaded after the message is admitted');
    assert.equal(f.bytes.objects.size, 0);
  },
);

test('a file the workspace has no room for leaves no stored bytes behind', async t => {
  const f = await setup(t);
  f.served.set(fileUrl, await png(32, 24));
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_skill_package_objects')} (digest,size) SELECT encode(sha256(i::text::bytea),'hex'),10485760 FROM generate_series(1,103) i`,
  );
  const { parts } = await f.receive(fileShare([whiteboard]));
  assert.deepEqual(
    parts.map(part => part.kind),
    ['text'],
  );
  assert.match(parts[0].text, /File not read: whiteboard.png; the workspace's attachment storage is full/);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.bytes.objects.size, 0, 'the staged bytes were removed');
});

test('a Slack redirect to a Slack file host is followed without the token', async t => {
  const f = await setup(t);
  const image = await png(32, 24, '#3a3');
  const edge = 'https://files-edge.slack-edge.com/TONE-F1/whiteboard.png';
  f.routes.set(fileUrl, () => new Response(null, { status: 302, headers: { location: edge } }));
  f.routes.set(edge, () => new Response(image, { headers: { 'content-type': 'image/png' } }));
  const { requests, parts } = await f.receive(fileShare([whiteboard]));
  assert.deepEqual(
    f.downloads.map(download => download.url),
    [fileUrl, edge],
  );
  assert.ok(f.downloads[0].authorization, 'the token goes to files.slack.com');
  assert.equal(f.downloads[1].authorization, null, 'the token does not follow the redirect');
  assert.deepEqual(
    parts.map(part => part.filename),
    ['whiteboard.png'],
  );
  assert.equal(imageBlocks(requests[0]).length, 1);
});

test('a Slack redirect to a host outside Slack is refused', async t => {
  const f = await setup(t);
  f.routes.set(fileUrl, () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }));
  const { parts } = await f.receive(fileShare([whiteboard]));
  assert.deepEqual(
    f.downloads.map(download => download.url),
    [fileUrl],
    'the other host is never asked',
  );
  assert.match(parts[0].text, /^\[File not read: whiteboard.png; Slack did not return it\]$/);
  assert.equal(f.bytes.objects.size, 0);
});

test('a Slack file whose body runs past 10 MiB is cut off and named as too large', async t => {
  const f = await setup(t);
  let sent = 0;
  f.routes.set(
    fileUrl,
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent >= 11) return controller.close();
            sent++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  );
  const { parts } = await f.receive(fileShare([whiteboard]));
  assert.ok(sent <= 11);
  assert.match(parts[0].text, /^\[File not read: whiteboard.png; it is larger than 10 MiB\]$/);
  assert.equal(f.bytes.objects.size, 0);
});

test('a Slack file whose body stalls is named as timed out', { timeout: 60_000 }, async t => {
  const f = await setup(t);
  f.routes.set(
    fileUrl,
    init =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16));
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  );
  const { parts } = await f.receive(fileShare([whiteboard]));
  assert.match(parts[0].text, /^\[File not read: whiteboard.png; downloading it from Slack timed out\]$/);
  assert.equal(f.bytes.objects.size, 0);
});

test('an HTML page in place of a Slack file is not read', async t => {
  const f = await setup(t);
  f.routes.set(
    fileUrl,
    () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
  const { requests, parts } = await f.receive(fileShare([whiteboard]));
  assert.match(parts[0].text, /^\[File not read: whiteboard.png; Slack did not return it\]$/);
  assert.doesNotMatch(requestText(requests[0]), /sign in/);
  assert.equal(f.bytes.objects.size, 0);
});
