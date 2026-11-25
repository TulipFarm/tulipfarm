import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserHostError } from '@tulipfarm/browser';
import { SecretError } from '@tulipfarm/secrets';
import { invokeBrowser, runBrowserCall } from '../src/browser-tools.ts';
import { withBrowserGrant } from '../src/tool-capabilities.ts';
import { outboundRefusal } from '../src/mcp-catalog-egress.ts';
import { discoverToolNames, isExternalTool } from '../src/tools.ts';

const origin = {
  workspaceId: '6f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  conversationId: '0b0e7a51-3c5d-4b8e-9f21-6d2a7c4e1f00',
  actor: { kind: 'human', userId: 'u1', membershipId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' },
};
const state = { sessionId: 's', url: 'https://example.com/', title: 'Example', controller: 'agent', needsPerson: null };

function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    open: async (id, options) => (calls.push(['open', id, options]), state),
    state: async id => (calls.push(['state', id]), null),
    act: async (id, action) => (
      calls.push(['act', id, action]),
      { state, snapshot: '- button "Sign up" [ref=e3]', truncated: false, screenshot: 'AAAA' }
    ),
    needsPerson: async (id, reason) => (calls.push(['needsPerson', id, reason]), state),
    ...overrides,
  };
  return { client, calls };
}

test('Chat lists the browser tools only when the reply offers a browser', () => {
  const chat = discoverToolNames({ kind: 'chat' });
  assert.equal(chat.includes('browser.act'), false);
  const offered = discoverToolNames({ kind: 'chat', browser: true });
  assert.ok(offered.includes('browser.act') && offered.includes('browser.handoff'));
  assert.equal(discoverToolNames({ kind: 'agent', tools: ['browser.act'] }).includes('browser.act'), false);
  // A browser step can take a minute and signing in opens its own secrets transaction, so none holds the reply's.
  for (const tool of ['browser.act', 'browser.handoff', 'browser.signIn', 'browser.upload'])
    assert.equal(isExternalTool(tool), true, tool);
});

test('A step opens the chat session, returns the page as untrusted data and shows the screenshot', async () => {
  const { client, calls } = fakeClient();
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'navigate', url: 'https://example.com' },
  });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['open', 'act'],
  );
  assert.equal(calls[0][1], calls[1][1]);
  assert.deepEqual(output.result, {
    url: 'https://example.com/',
    title: 'Example',
    snapshot: '- button "Sign up" [ref=e3]',
    untrusted: true,
  });
  assert.deepEqual(output.sources, [{ kind: 'private-conversation', conversationId: origin.conversationId }]);
  assert.equal(output.images.images[0].data, 'AAAA');
  const text = await invokeBrowser({ client, imageInput: false }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(text.images, undefined);
  assert.equal(JSON.stringify(text.result).includes('AAAA'), false);
  const withheld = fakeClient({
    act: async () => ({ state, snapshot: '', truncated: false, notice: 'No screenshot' }),
  });
  const shown = await invokeBrowser({ client: withheld.client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(shown.images, undefined);
  assert.equal(shown.result.notice, 'No screenshot');
});

test('A handoff flags the session and tells the model to stop', async () => {
  const { client, calls } = fakeClient();
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Tick the terms box',
  });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['state', 'open', 'needsPerson'],
  );
  assert.deepEqual(calls[2][2], { reason: 'Tick the terms box' });
  assert.equal(output.result.status, 'waiting-for-person');
});

test('A sign-in handoff names the site, and a URL in its place is refused', async () => {
  const { client, calls } = fakeClient();
  await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Sign in to Amazon',
    signIn: 'WWW.Amazon.com',
  });
  assert.deepEqual(calls.at(-1)[2], { reason: 'Sign in to Amazon', signIn: 'amazon.com' });
  const refused = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.handoff',
    reason: 'Sign in',
    signIn: 'https://amazon.com/login',
  });
  assert.equal(refused.result.error, 'invalid-site');
});

test('A host refusal becomes an instruction, not a failed turn', async () => {
  const { client } = fakeClient({
    act: async () => {
      throw new BrowserHostError('person-in-control', 'A member controls this browser', 409);
    },
  });
  const output = await invokeBrowser({ client, imageInput: true }, origin, {
    tool: 'browser.act',
    action: { action: 'click', ref: 'e3' },
  });
  assert.equal(output.result.error, 'person-in-control');
  assert.match(output.result.instruction, /hand it back/);
  const broken = fakeClient({
    act: async () => {
      throw new Error('bug');
    },
  });
  await assert.rejects(
    invokeBrowser({ client: broken.client, imageInput: true }, origin, {
      tool: 'browser.act',
      action: { action: 'back' },
    }),
    /bug/,
  );
});

test('With MCP tools offered, the browser opens only sites the person named', () => {
  const call = { tool: 'browser.act', action: { action: 'navigate', url: 'https://evil.example/steal' } };
  assert.ok(outboundRefusal(call, { person: 'sign me up on example.com', web: '' }));
  assert.equal(
    outboundRefusal(
      { ...call, action: { action: 'navigate', url: 'https://example.com/signup' } },
      {
        person: 'sign me up on example.com',
        web: '',
      },
    ),
    undefined,
  );
  assert.equal(
    outboundRefusal({ tool: 'browser.act', action: { action: 'click', ref: 'e1' } }, { person: '', web: '' }),
    undefined,
  );
});

const login = { username: 'ada@example.com', password: 'correct horse battery' };

function fakeSecrets(secret, uses = []) {
  return {
    uses,
    secrets: holder => ({
      resolve: async ({ reference }, url) => {
        assert.equal(holder.conversationId, origin.conversationId);
        if (reference !== 'ref-1') throw new SecretError('not-found');
        if (new URL(url).hostname !== 'example.com') throw new SecretError('destination-denied');
        return {
          secretId: 'sec-1',
          kind: 'username-password',
          placement: { kind: 'browser' },
          destinations: [{ kind: 'host', value: 'example.com' }],
          value: login,
          ...secret,
        };
      },
      recordUse: async (id, url) => void uses.push([id, url]),
    }),
  };
}

const signedIn = { state, snapshot: '- heading "Welcome" [ref=e9]', truncated: false, screenshot: 'BBBB' };

test('Sign-in types the secret through the host and never returns it', async () => {
  const { client, calls } = fakeClient({
    state: async id => (calls.push(['state', id]), state),
    typeSecret: async (id, input) => (calls.push(['typeSecret', id, input]), signedIn),
  });
  const { secrets, uses } = fakeSecrets();
  const output = await invokeBrowser({ client, imageInput: true, secrets }, origin, {
    tool: 'browser.signIn',
    secret: 'ref-1',
    username: 'e1',
    password: 'e2',
    submit: 'e3',
  });
  assert.deepEqual(calls.at(-1)[2], {
    hosts: ['example.com'],
    fields: [
      { ref: 'e1', kind: 'username', value: login.username },
      { ref: 'e2', kind: 'password', value: login.password },
    ],
    submit: 'e3',
  });
  assert.deepEqual(uses, [['sec-1', 'https://example.com/']]);
  const text = JSON.stringify(output);
  assert.equal(text.includes(login.username) || text.includes(login.password), false);
  assert.equal(output.result.snapshot, signedIn.snapshot);
  // The page may show what was just typed, so sign-in never passes a screenshot on.
  assert.equal(output.images, undefined);
});

test('Sign-in refuses unusable secrets and mismatched fields without typing', async () => {
  const { client, calls } = fakeClient({
    state: async id => (calls.push(['state', id]), state),
    typeSecret: async () => assert.fail('typed'),
  });
  const call = { tool: 'browser.signIn', secret: 'ref-1', username: 'e1', password: 'e2' };
  const run = (secret, overrides = {}) =>
    invokeBrowser({ client, imageInput: false, secrets: fakeSecrets(secret).secrets }, origin, {
      ...call,
      ...overrides,
    });
  assert.equal((await run({ placement: { kind: 'basic' } })).result.error, 'placement-unsupported');
  assert.equal((await run({}, { secret: 'other' })).result.error, 'secret-not-found');
  assert.equal((await run({ kind: 'password', value: { value: 'hunter2' } })).result.error, 'invalid-fields');
  assert.equal((await run({}, { username: undefined })).result.error, 'invalid-fields');
  assert.equal(
    (await run({ destinations: [{ kind: 'endpoint', value: 'https://example.com/api' }] })).result.error,
    'secret-destination-denied',
  );
  const elsewhere = fakeClient({ state: async () => ({ ...state, url: 'https://evil.example/' }) });
  const denied = await invokeBrowser(
    { client: elsewhere.client, imageInput: false, secrets: fakeSecrets().secrets },
    origin,
    call,
  );
  assert.equal(denied.result.error, 'secret-destination-denied');
  const none = await invokeBrowser({ client, imageInput: false }, origin, call);
  assert.equal(none.result.error, 'secrets-unavailable');
});

test('A host refusal to type becomes an instruction', async () => {
  const { client } = fakeClient({
    state: async () => state,
    typeSecret: async () => {
      throw new BrowserHostError('field-refused', 'That field is not a password box', 422);
    },
  });
  const { secrets, uses } = fakeSecrets();
  const output = await invokeBrowser({ client, imageInput: false, secrets }, origin, {
    tool: 'browser.signIn',
    secret: 'ref-1',
    username: 'e1',
    password: 'e2',
  });
  assert.equal(output.result.error, 'field-refused');
  assert.match(output.result.instruction, /password box/);
  assert.deepEqual(uses, []);
});

const fileSource = '3c9f0d2e-7b1a-4e5f-9a8b-2c1d0e9f8a7b';
function fakeFiles(
  read,
  save = async download => ({
    file: {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
      name: download.name,
      mediaType: 'text/csv',
      size: download.bytes.byteLength,
    },
  }),
) {
  const calls = [];
  return {
    calls,
    files: {
      read: async source => (calls.push(['read', source]), read(source)),
      save: async (download, folderId) => (calls.push(['save', download, folderId]), save(download, folderId)),
    },
  };
}

test('Upload sends a file the chat may read and refuses one it may not', async () => {
  const bytes = new TextEncoder().encode('a,b\n1,2\n');
  const fileSources = [{ kind: 'file', fileId: fileSource }];
  const { client, calls } = fakeClient({
    state: async id => (calls.push(['state', id]), state),
    upload: async (id, upload, body) => (
      calls.push(['upload', id, upload, body]),
      { state, snapshot: '- button "Choose file" [ref=e2]', truncated: false }
    ),
  });
  const { files } = fakeFiles(source =>
    source === fileSource
      ? { name: 'report.csv', mediaType: 'text/csv', bytes, sources: fileSources }
      : { error: 'file-not-found' },
  );
  const output = await invokeBrowser(
    { client, imageInput: false },
    origin,
    { tool: 'browser.upload', file: fileSource, ref: 'e2' },
    files,
  );
  const sent = calls.find(call => call[0] === 'upload');
  assert.deepEqual(sent[2], { ref: 'e2', name: 'report.csv', mediaType: 'text/csv' });
  assert.equal(sent[3], bytes);
  assert.equal(output.result.uploaded, 'report.csv');
  assert.deepEqual(output.sources, [
    { kind: 'private-conversation', conversationId: origin.conversationId },
    ...fileSources,
  ]);

  calls.length = 0;
  const refused = await invokeBrowser(
    { client, imageInput: false },
    origin,
    { tool: 'browser.upload', file: 'someone-elses-file', ref: 'e2' },
    files,
  );
  assert.equal(refused.result.error, 'file-not-found');
  assert.equal(
    calls.some(call => call[0] === 'upload'),
    false,
  );
  const unavailable = await invokeBrowser({ client, imageInput: false }, origin, {
    tool: 'browser.upload',
    file: fileSource,
    ref: 'e2',
  });
  assert.equal(unavailable.result.error, 'files-unavailable');
});

test('A step saves what the page downloaded to Files and says so', async () => {
  const downloads = [
    { id: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'report.csv', size: 4 },
    { id: '2e3d4c5b-6f7a-4b8c-9d0e-1f2a3b4c5d6e', name: 'big/../..\u0001.bin', size: 4 },
    { id: '3f4e5d6c-7a8b-4c9d-8e0f-2a3b4c5d6e7f', name: 'gone.txt', size: 4 },
  ];
  const { client, calls } = fakeClient({
    act: async () => ({ state, snapshot: '', truncated: false, downloads }),
    download: async (id, downloadId) => {
      calls.push(['download', id, downloadId]);
      if (downloadId === downloads[2].id) throw new BrowserHostError('download-not-found', 'gone', 404);
      return { name: 'x', bytes: new Uint8Array([1, 2, 3, 4]) };
    },
  });
  const { files, calls: fileCalls } = fakeFiles(
    () => ({ error: 'file-not-found' }),
    async download =>
      download.name === 'report.csv'
        ? { file: { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', name: 'report.csv', mediaType: 'text/csv', size: 4 } }
        : { error: 'quota-exceeded', instruction: 'Storage is full.' },
  );
  const folderId = '7b6a5f4e-3d2c-4b1a-9f8e-7d6c5b4a3f2e';
  const output = await invokeBrowser(
    { client, imageInput: false },
    origin,
    { tool: 'browser.act', action: { action: 'click', ref: 'e3' }, folderId },
    files,
  );
  assert.deepEqual(output.result.files, [{ id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', name: 'report.csv', size: 4 }]);
  assert.deepEqual(output.result.downloadsNotSaved, [
    { name: downloads[1].name, error: 'quota-exceeded', instruction: 'Storage is full.' },
  ]);
  assert.match(output.result.downloadInstruction, /saved them to Files/);
  const saves = fileCalls.filter(call => call[0] === 'save');
  assert.deepEqual(
    saves.map(call => [call[1].name, call[2]]),
    [
      ['report.csv', folderId],
      ['big_.._.._.bin', folderId],
    ],
  );
  assert.deepEqual(saves[0][1].bytes, new Uint8Array([1, 2, 3, 4]));

  const noFiles = await invokeBrowser({ client, imageInput: false }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(noFiles.result.files, undefined);
  assert.deepEqual(
    noFiles.result.downloadsNotSaved,
    downloads.map(download => download.name),
  );
});

test('A run is offered uploads; without Files its downloads are not saved and uploads are refused', async () => {
  const runTools = discoverToolNames({ kind: 'agent', task: true, tools: withBrowserGrant(['browser.act']) });
  assert.ok(['browser.act', 'browser.signIn', 'browser.upload'].every(tool => runTools.includes(tool)));

  const downloads = [{ id: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'report.csv', size: 4 }];
  const { client, calls } = fakeClient({ act: async () => ({ state, snapshot: '', truncated: false, downloads }) });
  const run = { client, sessionId: 'run-session', mode: 'task', imageInput: false };
  const step = await runBrowserCall(run, { tool: 'browser.act', action: { action: 'snapshot' } });
  assert.deepEqual(step.result.downloadsNotSaved, ['report.csv']);
  assert.match(step.result.downloadInstruction, /not saved in runs/);
  const refused = await runBrowserCall(run, { tool: 'browser.upload', file: 'f', ref: 'e2' });
  assert.equal(refused.result.error, 'files-unavailable');
  assert.equal(
    refused.result.instruction,
    'Runs cannot upload files, so nothing was uploaded. Finish without the upload and say why in your result.',
  );
  assert.equal(
    calls.some(call => call[0] === 'upload' || call[0] === 'download'),
    false,
  );
});

test('A run with Files saves downloads to its named folder and refuses files outside the run', async () => {
  const downloads = [{ id: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'report.csv', size: 4 }];
  const { client, calls } = fakeClient({
    state: async () => state,
    act: async () => ({ state, snapshot: '', truncated: false, downloads }),
    download: async () => ({ name: 'report.csv', bytes: new TextEncoder().encode('a,b\n') }),
  });
  const { files, calls: fileCalls } = fakeFiles(() => ({ error: 'file-not-allowed' }));
  const run = { client, sessionId: 'run-session', mode: 'task', imageInput: false, files };
  const folderId = '7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b';
  const step = await runBrowserCall(run, { tool: 'browser.act', action: { action: 'click', ref: 'e4' }, folderId });
  assert.deepEqual(
    step.result.files.map(file => file.name),
    ['report.csv'],
  );
  assert.match(step.result.downloadInstruction, /saved them to the Files folder you named/);
  assert.equal(fileCalls.find(call => call[0] === 'save')[2], folderId);

  const refused = await runBrowserCall(run, { tool: 'browser.upload', file: fileSource, ref: 'e2' });
  assert.equal(refused.result.error, 'file-not-allowed');
  assert.match(refused.result.instruction, /^Runs upload only the files attached to the run or saved by it\./);
  assert.equal(
    calls.some(call => call[0] === 'upload'),
    false,
  );
});

function testMeter(refusal) {
  const events = [];
  return {
    events,
    meter: {
      admit: async () => (events.push('admit'), refusal),
      record: async recorded => void events.push(['record', recorded.url]),
      end: async () => void events.push('end'),
    },
  };
}

test('A metered chat records its browser time and refuses a new browser without credits', async () => {
  const { client, calls } = fakeClient();
  const metered = testMeter(undefined);
  const origins = [];
  const chat = {
    client,
    imageInput: false,
    meter: meterOrigin => (origins.push(meterOrigin), metered.meter),
  };
  await invokeBrowser(chat, origin, { tool: 'browser.act', action: { action: 'snapshot' } });
  assert.deepEqual(metered.events, ['admit', ['record', state.url], ['record', state.url]]);
  assert.equal(origins[0].conversationId, origin.conversationId);
  assert.deepEqual(calls[1], ['open', calls[0][1], { allowedSites: undefined, workspaceId: origin.workspaceId }]);

  const refused = testMeter('out-of-credits');
  const broke = fakeClient();
  const output = await invokeBrowser({ ...chat, client: broke.client, meter: () => refused.meter }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.deepEqual(output.result, {
    error: 'out-of-credits',
    instruction:
      "This workspace is out of credits, so a new browser can't open. Tell the member and finish without the browser.",
  });
  assert.deepEqual(
    broke.calls.map(call => call[0]),
    ['state'],
    'no browser opens',
  );

  // A browser already open keeps working: only a new one is refused.
  const open = fakeClient({ state: async () => state });
  const kept = await invokeBrowser({ ...chat, client: open.client, meter: () => refused.meter }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.equal(kept.result.url, state.url);
});

test('A run refuses a new browser once its allowance or the workspace credits are used up', async () => {
  const run = refusal => ({
    client: fakeClient().client,
    sessionId: 's',
    mode: 'task',
    imageInput: false,
    meter: testMeter(refusal).meter,
  });
  const call = { tool: 'browser.act', action: { action: 'snapshot' } };
  assert.deepEqual((await runBrowserCall(run('allowance-used'), call)).result, {
    error: 'credit-allowance-used',
    instruction:
      "This run has used its credit allowance, so a new browser can't open. Finish without the browser and say why.",
  });
  assert.deepEqual((await runBrowserCall(run('out-of-credits'), call)).result, {
    error: 'out-of-credits',
    instruction:
      "This workspace is out of credits, so a new browser can't open. Finish without the browser and say why.",
  });
  const handoff = await runBrowserCall(run('out-of-credits'), { tool: 'browser.handoff', reason: 'Sign in' });
  assert.equal(handoff.result.error, 'out-of-credits');
});

test('A step queued behind busy browsers tells the agent its place and to wait', async () => {
  const message = 'All 3 browsers for this workspace are in use. This step is number 2 in line.';
  const { client } = fakeClient({
    open: async () => {
      throw new BrowserHostError('browser-busy', message, 429, 2);
    },
  });
  const output = await invokeBrowser({ client, imageInput: false }, origin, {
    tool: 'browser.act',
    action: { action: 'snapshot' },
  });
  assert.deepEqual(output.result, { error: 'browser-busy', message, instruction: 'Wait a minute, then try again.' });
});
