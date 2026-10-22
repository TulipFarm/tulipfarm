import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  createGoogleCorpusProvider,
  GoogleCorpusError,
  googleCorpusSelectionSchema,
  googleCorpusLimits,
} from '../src/corpus.ts';
import { GoogleWorkspaceError } from '../src/contracts.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const integrationId = '22222222-2222-4222-8222-222222222222';
const driveScope = 'https://www.googleapis.com/auth/drive';
const gmailScope = 'https://www.googleapis.com/auth/gmail.modify';
const binding = { integrationId, accountId: 'reader-account', generation: 3, requiredScopes: [driveScope] };
const gmailBinding = { ...binding, requiredScopes: [gmailScope] };
const shared = { kind: 'shared-drive', driveId: 'team' };
const folder = { kind: 'drive-folder', folderId: 'root' };
const gmail = { kind: 'gmail', labelId: 'INBOX', after: '2026-10-01', before: '2026-10-04' };
const folderMime = 'application/vnd.google-apps.folder';
const accessToken = 'reader-token-private';
const source = {
  id: 'file1',
  name: 'Plan.txt',
  mimeType: 'text/plain',
  version: '17',
  modifiedTime: '2026-10-02T00:00:00Z',
  trashed: false,
  parents: ['root'],
  driveId: 'team',
  size: '5',
  capabilities: { canDownload: true, canCopy: true },
  copyRequiresWriterPermission: false,
};
const root = { ...source, id: 'root', name: 'Selected', mimeType: folderMime, parents: [], size: undefined };
const childFolder = { ...root, id: 'nested', name: 'Nested', parents: ['root'] };
const part = (text, mimeType = 'text/plain', extra = {}) => ({
  mimeType,
  filename: '',
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset=UTF-8` }],
  body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') },
  ...extra,
});
const mail = {
  id: 'msg1',
  threadId: 'thread1',
  historyId: '812',
  internalDate: String(Date.parse('2026-10-02T00:00:00Z')),
  labelIds: ['INBOX'],
  snippet: 'DO NOT INGEST THIS SNIPPET',
  payload: {
    mimeType: 'multipart/alternative',
    filename: '',
    headers: [
      { name: 'Subject', value: 'Release' },
      { name: 'From', value: 'person@example.com' },
    ],
    body: { size: 0 },
    parts: [part('Full plain message'), part('<p>Full HTML message</p>', 'text/html')],
  },
};

function fixture(handler, overrides = {}) {
  const calls = [];
  const fences = [];
  const status = {
    status: 'connected',
    ...binding,
    email: 'reader@example.com',
    scopes: [driveScope, gmailScope],
    ...overrides,
  };
  const service = {
    async status(actualWorkspace, userId) {
      assert.equal(actualWorkspace, workspaceId);
      assert.equal(userId, 'reader');
      return status;
    },
    async withCredential(fence, run) {
      assert.equal(fence.actor, 'reader');
      assert.equal(fence.workspaceId, workspaceId);
      assert.equal(fence.accountId, 'reader-account');
      assert.equal(fence.generation, status.generation);
      assert.ok(fence.requiredScopes.every(scope => status.scopes.includes(scope)));
      fences.push(fence);
      return run({ accessToken, signal: AbortSignal.timeout(10000) });
    },
  };
  const provider = createGoogleCorpusProvider({
    service,
    providerFetch: async (url, init) => {
      assert.ok(['https://www.googleapis.com', 'https://gmail.googleapis.com'].includes(url.origin));
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.signal.aborted, false);
      calls.push(url);
      return handler(url, init, calls.length);
    },
  });
  return { provider, calls, fences, status, service };
}
const failure = code => error => {
  assert.ok(error instanceof GoogleCorpusError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.ok(!JSON.stringify(error).includes(accessToken));
  return true;
};
function driveResponse(url, item = source) {
  if (url.pathname.endsWith('/root')) return Response.json(root);
  if (url.pathname.endsWith('/nested')) return Response.json(childFolder);
  if (url.searchParams.get('alt') === 'media' || url.pathname.endsWith('/export')) return new Response('hello');
  if (url.pathname.endsWith('/file1')) return Response.json(item);
  throw new Error(`Unexpected route: ${url.pathname}`);
}

test('selection contracts bound mailbox dates, native IDs and reject extra fields', () => {
  for (const selection of [folder, shared, gmail, { ...gmail, labelId: null }])
    assert.deepEqual(googleCorpusSelectionSchema.parse(selection), selection);
  for (const selection of [
    { ...folder, folderId: "x' or trashed = false" },
    { ...folder, folderId: 'x'.repeat(257) },
    { ...shared, resourceKey: 'secret' },
    { ...gmail, after: '2026-02-30' },
    { ...gmail, after: '2026-10-04' },
    { ...gmail, before: '2028-01-01' },
    { ...gmail, after: '2026-10-01T00:00:00Z' },
    { kind: 'gmail', labelId: null },
  ])
    assert.equal(googleCorpusSelectionSchema.safeParse(selection).success, false);
  assert.equal(googleCorpusLimits.mailboxWindowDays, 366);
});

test('inspection derives the exact broader application scope and credential identity', async () => {
  const { provider, calls, fences } = fixture(url => driveResponse(url));
  assert.deepEqual(await provider.inspectSelection(workspaceId, 'reader', folder), {
    binding,
    selection: folder,
    title: 'Selected',
  });
  assert.equal(calls[0].searchParams.get('supportsAllDrives'), 'true');
  assert.match(calls[0].searchParams.get('fields'), /capabilities\(canDownload,canCopy\)/);
  assert.deepEqual(fences[0], { workspaceId, actor: 'reader', ...binding });
});

test('readonly scopes work while metadata/file-only scopes cannot establish a corpus', async () => {
  for (const scope of ['https://www.googleapis.com/auth/drive.readonly', driveScope]) {
    const { provider } = fixture(url => driveResponse(url), { scopes: [scope] });
    assert.deepEqual((await provider.inspectSelection(workspaceId, 'reader', folder)).binding.requiredScopes, [scope]);
  }
  for (const scope of [
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/documents',
  ]) {
    const { provider, calls } = fixture(
      () => {
        throw new Error('HTTP must not execute');
      },
      { scopes: [scope] },
    );
    await assert.rejects(provider.inspectSelection(workspaceId, 'reader', folder), failure('insufficient-scope'));
    assert.equal(calls.length, 0);
  }
});

test('reader checks never fall back to a manager binding or stale generation', async () => {
  for (const wrong of [
    { ...binding, accountId: 'manager' },
    { ...binding, generation: 2 },
    { ...binding, integrationId: workspaceId },
  ]) {
    const { provider, calls } = fixture(() => {
      throw new Error('no network');
    });
    await assert.rejects(provider.check(workspaceId, 'reader', wrong, shared, 'file1'), failure('stale-integration'));
    assert.equal(calls.length, 0);
  }
  const { provider } = fixture(() => {
    throw new Error('no network');
  });
  await assert.rejects(
    provider.check(workspaceId, 'reader', { ...binding, requiredScopes: ['openid'] }, shared, 'file1'),
    failure('insufficient-scope'),
  );
});

test('discovery pages folders and shared drives and returns Gmail labels', async () => {
  const { provider } = fixture(url => {
    if (url.pathname.endsWith('/drives')) {
      assert.equal(url.searchParams.get('pageToken'), 'drive-next');
      return Response.json({ drives: [{ id: 'team', name: 'Team' }] });
    }
    if (url.pathname.endsWith('/labels')) return Response.json({ labels: [{ id: 'INBOX', name: 'Inbox' }] });
    assert.match(url.searchParams.get('q'), /mimeType = 'application\/vnd.google-apps.folder'/);
    assert.equal(url.searchParams.get('pageToken'), 'folder-next');
    return Response.json({ files: [root], nextPageToken: 'more', incompleteSearch: false });
  });
  assert.deepEqual((await provider.discover(workspaceId, 'reader', 'drive-folder', 'folder-next')).items, [
    { nativeId: 'root', title: 'Selected', kind: 'drive-folder' },
  ]);
  assert.equal((await provider.discover(workspaceId, 'reader', 'shared-drive', 'drive-next')).nextCursor, null);
  assert.deepEqual(await provider.discover(workspaceId, 'reader', 'gmail'), {
    binding: gmailBinding,
    items: [{ nativeId: 'INBOX', title: 'Inbox', kind: 'gmail' }],
    nextCursor: null,
  });
  await assert.rejects(provider.discover(workspaceId, 'reader', 'gmail', 'no-paging'), failure('invalid-cursor'));
});

test('first folder page offers My Drive by its real folder id', async () => {
  const { provider, calls } = fixture(url => {
    if (url.pathname.endsWith('/files/root'))
      return Response.json({ ...root, id: 'my-drive-real-id', name: 'My Drive' });
    assert.equal(url.searchParams.get('pageToken'), null);
    return Response.json({ files: [childFolder], incompleteSearch: false });
  });
  assert.deepEqual((await provider.discover(workspaceId, 'reader', 'drive-folder')).items, [
    { nativeId: 'my-drive-real-id', title: 'My Drive (all files)', kind: 'drive-folder' },
    { nativeId: 'nested', title: 'Nested', kind: 'drive-folder' },
  ]);
  assert.equal(calls.length, 2);
});

test('folder list is one immediate page; caller can durably traverse a verified child folder', async () => {
  const { provider, calls } = fixture(url => {
    if (url.pathname.endsWith('/files')) {
      assert.equal(url.searchParams.get('q'), "trashed = false and 'nested' in parents");
      assert.equal(url.searchParams.get('pageToken'), 'next');
      return Response.json({
        files: [
          { ...source, parents: ['nested'] },
          { ...childFolder, id: 'deeper', parents: ['nested'] },
        ],
        nextPageToken: 'last',
      });
    }
    return driveResponse(url);
  });
  const result = await provider.list(workspaceId, 'reader', binding, folder, { folderId: 'nested', pageToken: 'next' });
  assert.deepEqual(
    result.observations.map(item => [item.nativeId, item.kind, item.coverage]),
    [
      ['file1', 'file', 'supported'],
      ['deeper', 'folder', 'folder'],
    ],
  );
  assert.deepEqual(result.nextCursor, { folderId: 'nested', pageToken: 'last' });
  assert.deepEqual(
    calls.map(url => url.pathname),
    ['/drive/v3/files/nested', '/drive/v3/files/root', '/drive/v3/files'],
  );
});

test('shared-drive pages use the selected drive corpus and retain unsupported observations', async () => {
  const { provider } = fixture(url => {
    assert.equal(url.searchParams.get('corpora'), 'drive');
    assert.equal(url.searchParams.get('driveId'), 'team');
    assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
    return Response.json({
      files: [
        source,
        { ...source, id: 'shortcut', mimeType: 'application/vnd.google-apps.shortcut' },
        { ...source, id: 'locked', capabilities: { canDownload: false } },
        { ...source, id: 'keyed', resourceKey: 'required' },
      ],
      nextPageToken: 'next',
    });
  });
  const result = await provider.list(workspaceId, 'reader', binding, shared, null);
  assert.deepEqual(
    result.observations.map(item => item.coverage),
    ['supported', 'unsupported', 'restricted', 'resource-key-required'],
  );
  assert.deepEqual(result.nextCursor, { pageToken: 'next' });
});

test('incompleteSearch errors even when the page has files or no continuation', async () => {
  const { provider } = fixture(url =>
    url.pathname.endsWith('/files') ? Response.json({ files: [], incompleteSearch: true }) : driveResponse(url),
  );
  await assert.rejects(provider.list(workspaceId, 'reader', binding, shared), failure('incomplete-search'));
  await assert.rejects(provider.discover(workspaceId, 'reader', 'drive-folder'), failure('incomplete-search'));
});

test('reads return whole originals with before/after authoritative revision and checksum checks', async () => {
  const md5Checksum = createHash('md5').update('hello').digest('hex');
  const { provider, calls } = fixture(url => driveResponse(url, { ...source, md5Checksum }));
  const start = Date.now();
  const result = await provider.read(workspaceId, 'reader', binding, shared, 'file1');
  assert.equal(Buffer.from(result.bytes).toString(), 'hello');
  assert.equal(result.filename, 'Plan.txt');
  assert.equal(result.normalizedContent, null);
  assert.equal(result.sourceRevision, '17');
  assert.equal(result.metadataBefore.sourceRevision, '17');
  assert.equal(result.metadataAfter.sourceRevision, '17');
  assert.ok(Date.parse(result.accessedAt) >= start);
  assert.equal(result.canonicalURL, 'https://drive.google.com/file/d/file1');
  assert.equal(calls.length, 3);
});

for (const [nativeMime, extension, exportedMime] of [
  ['document', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['spreadsheet', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['presentation', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])
  test(`native ${nativeMime} exports complete qualified ${extension} bytes`, async () => {
    const { provider, calls } = fixture(url =>
      driveResponse(url, { ...source, mimeType: `application/vnd.google-apps.${nativeMime}`, name: 'Complete' }),
    );
    const result = await provider.read(workspaceId, 'reader', binding, shared, 'file1');
    assert.equal(result.mediaType, exportedMime);
    assert.equal(result.filename, `Complete.${extension}`);
    assert.equal(calls[1].pathname, '/drive/v3/files/file1/export');
    assert.equal(calls[1].searchParams.get('mimeType'), exportedMime);
    assert.equal(Buffer.from(result.bytes).toString(), 'hello');
  });

for (const [change, code] of [
  [{ capabilities: { canDownload: false } }, 'restricted'],
  [{ capabilities: { canDownload: true, canCopy: false } }, 'restricted'],
  [{ capabilities: {} }, 'restricted'],
  [{ copyRequiresWriterPermission: true }, 'restricted'],
  [{ downloadRestrictions: { effectiveDownloadRestrictionWithContext: { restrictedForWriters: true } } }, 'restricted'],
  [{ trashed: true }, 'not-found'],
  [{ resourceKey: 'link-only-key' }, 'resource-key-required'],
  [{ mimeType: 'application/vnd.google-apps.shortcut' }, 'unsupported'],
  [{ mimeType: 'image/png' }, 'unsupported'],
  [{ driveId: 'another-drive' }, 'outside-selection'],
])
  test(`exact file check rejects ${JSON.stringify(change)}`, async () => {
    const { provider, calls } = fixture(url => driveResponse(url, { ...source, ...change }));
    await assert.rejects(provider.check(workspaceId, 'reader', binding, shared, 'file1'), failure(code));
    assert.equal(calls.length, 1);
  });

test('effective group/inherited API access succeeds without ACL labels or manager credentials', async () => {
  const { provider, calls } = fixture(url =>
    driveResponse(url, { ...source, permissions: [{ type: 'group', role: 'reader' }] }),
  );
  const result = await provider.check(workspaceId, 'reader', binding, shared, 'file1');
  assert.equal(result.nativeId, 'file1');
  assert.equal(result.coverage, 'supported');
  assert.equal(calls[0].pathname, '/drive/v3/files/file1');
  assert.equal(calls.length, 1);
});

test('folder reads verify ancestors, reject unrelated files and never follow shortcuts', async () => {
  const { provider, calls } = fixture(url => driveResponse(url, { ...source, parents: ['nested'] }));
  assert.equal((await provider.read(workspaceId, 'reader', binding, folder, 'file1')).sourceRevision, '17');
  assert.equal(calls.filter(url => url.pathname.endsWith('/root')).length, 2);
  const unrelated = fixture(url => driveResponse(url, { ...source, parents: [] })).provider;
  await assert.rejects(unrelated.read(workspaceId, 'reader', binding, folder, 'file1'), failure('outside-selection'));
  const cyclic = fixture(url =>
    url.pathname.endsWith('/root')
      ? Response.json({ ...root, id: 'root', parents: ['root'] })
      : driveResponse(url, { ...source, parents: ['file1'] }),
  ).provider;
  await assert.rejects(cyclic.check(workspaceId, 'reader', binding, folder, 'file1'), failure('outside-selection'));
});

for (const change of [{ version: '18' }, { name: 'Renamed' }, { modifiedTime: '2026-10-03T00:00:00Z' }])
  test(`read rejects edits during export: ${JSON.stringify(change)}`, async () => {
    let metadata = 0;
    const { provider } = fixture(url => {
      if (url.searchParams.get('alt') === 'media') return new Response('hello');
      return Response.json({ ...source, ...(metadata++ ? change : {}) });
    });
    await assert.rejects(provider.read(workspaceId, 'reader', binding, shared, 'file1'), failure('source-changed'));
  });

test('truncated downloads, mismatched checksum and partial responses cannot be ingested', async () => {
  for (const item of [
    { ...source, size: '6' },
    { ...source, md5Checksum: '0'.repeat(32) },
  ]) {
    const { provider } = fixture(url => driveResponse(url, item));
    await assert.rejects(provider.read(workspaceId, 'reader', binding, shared, 'file1'), failure('source-changed'));
  }
  const { provider } = fixture(url =>
    url.searchParams.get('alt') === 'media' ? new Response('hello', { status: 206 }) : driveResponse(url),
  );
  await assert.rejects(provider.read(workspaceId, 'reader', binding, shared, 'file1'), failure('invalid-response'));
});

test('missing blob size, denial after download and nonadvancing cursors fail closed', async () => {
  const absentSize = fixture(url => driveResponse(url, { ...source, size: undefined })).provider;
  await assert.rejects(absentSize.read(workspaceId, 'reader', binding, shared, 'file1'), failure('invalid-response'));
  let reads = 0;
  const revoked = fixture(url => {
    if (url.searchParams.get('alt') === 'media') return new Response('hello');
    return reads++ ? new Response('', { status: 403 }) : Response.json(source);
  }).provider;
  await assert.rejects(revoked.read(workspaceId, 'reader', binding, shared, 'file1'), failure('forbidden'));
  const repeated = fixture(() => Response.json({ files: [], nextPageToken: 'same' })).provider;
  await assert.rejects(
    repeated.list(workspaceId, 'reader', binding, shared, { pageToken: 'same' }),
    failure('invalid-cursor'),
  );
});

for (const [status, reason, code] of [
  [401, 'authError', 'unauthenticated'],
  [403, 'insufficientPermissions', 'forbidden'],
  [404, 'notFound', 'not-found'],
  [403, 'userRateLimitExceeded', 'rate-limited'],
  [403, 'rateLimitExceeded', 'rate-limited'],
  [429, '', 'rate-limited'],
  [503, '', 'transient'],
])
  test(`HTTP ${status} ${reason} has a stable secret-free failure`, async () => {
    const { provider } = fixture(() =>
      Response.json(
        { error: { message: accessToken, errors: [{ reason }] } },
        { status, headers: { 'retry-after': '12' } },
      ),
    );
    await assert.rejects(provider.check(workspaceId, 'reader', binding, shared, 'file1'), error => {
      failure(code)(error);
      assert.equal(error.retryAfterMs, ['rate-limited', 'transient'].includes(code) ? 12000 : null);
      return true;
    });
  });

test('HTTP-date Retry-After, malformed responses and invalid cursors are explicit', async () => {
  const future = new Date(Date.now() + 60000).toUTCString();
  const limited = fixture(() => new Response('', { status: 429, headers: { 'retry-after': future } })).provider;
  await assert.rejects(limited.check(workspaceId, 'reader', binding, shared, 'file1'), error => {
    assert.equal(error.code, 'rate-limited');
    assert.ok(error.retryAfterMs > 58000 && error.retryAfterMs <= 60000);
    return true;
  });
  const invalid = fixture(() => new Response('invalid', { status: 400 })).provider;
  await assert.rejects(
    invalid.list(workspaceId, 'reader', binding, shared, { pageToken: 'expired' }),
    failure('invalid-cursor'),
  );
  await assert.rejects(
    invalid.list(workspaceId, 'reader', binding, shared, { pageToken: 'x'.repeat(4097) }),
    failure('invalid-cursor'),
  );
  const malformed = fixture(() => new Response('not JSON')).provider;
  await assert.rejects(malformed.check(workspaceId, 'reader', binding, shared, 'file1'), failure('invalid-response'));
  const mismatch = fixture(() => Response.json({ ...source, id: 'another-file' })).provider;
  await assert.rejects(mismatch.check(workspaceId, 'reader', binding, shared, 'file1'), failure('invalid-response'));
});

test('oversized streamed responses are cancelled, never truncated', async () => {
  let cancelled = false;
  const { provider } = fixture(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(provider.check(workspaceId, 'reader', binding, shared, 'file1'), failure('response-too-large'));
  assert.equal(cancelled, true);
});

test('an abort during a stalled body cancels the read and grants no access proof', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const provider = createGoogleCorpusProvider({
    service: {
      status: async () => ({ status: 'connected', ...binding, email: 'reader@example.com', scopes: [driveScope] }),
      withCredential: async (_fence, operation) => operation({ accessToken, signal: controller.signal }),
    },
    providerFetch: async () =>
      new Response(
        new ReadableStream({
          start() {
            setTimeout(() => controller.abort(), 10);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(provider.check(workspaceId, 'reader', binding, shared, 'file1'), failure('transient'));
  assert.equal(cancelled, true);
});

test('Gmail label and bounded mailbox inspection use the owner credential', async () => {
  const { provider } = fixture(url => {
    if (url.pathname.endsWith('/labels/INBOX')) return Response.json({ id: 'INBOX', name: 'Inbox' });
    assert.equal(url.pathname, '/gmail/v1/users/me/profile');
    return Response.json({ historyId: '812' });
  });
  assert.deepEqual(await provider.inspectSelection(workspaceId, 'reader', gmail), {
    binding: gmailBinding,
    selection: gmail,
    title: 'Inbox',
  });
  assert.equal((await provider.inspectSelection(workspaceId, 'reader', { ...gmail, labelId: null })).title, 'Mailbox');
});

test('Gmail pages recheck full message labels and UTC dates and expose attachment coverage', async () => {
  const { provider } = fixture(url => {
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('labelIds'), 'INBOX');
      assert.equal(
        url.searchParams.get('q'),
        `after:${Date.parse(gmail.after) / 1000 - 1} before:${Date.parse(gmail.before) / 1000}`,
      );
      assert.equal(url.searchParams.get('pageToken'), 'page2');
      return Response.json({ messages: [{ id: 'msg1' }], nextPageToken: 'page3' });
    }
    assert.equal(url.searchParams.get('format'), 'full');
    return Response.json({
      ...mail,
      payload: {
        ...mail.payload,
        parts: [...mail.payload.parts, part('attached', 'text/plain', { filename: 'notes.txt' })],
      },
    });
  });
  const page = await provider.list(workspaceId, 'reader', gmailBinding, gmail, { pageToken: 'page2' });
  assert.equal(page.observations[0].coverage, 'attachments-unsupported');
  assert.deepEqual(page.nextCursor, { pageToken: 'page3' });
  await assert.rejects(
    provider.read(workspaceId, 'reader', gmailBinding, gmail, 'msg1'),
    failure('attachments-unsupported'),
  );
});

test('Gmail serializer includes complete text, HTML and headers, never snippets or truncation', async () => {
  const longText = 'Complete body '.repeat(10000) + 'END-OF-MESSAGE';
  const full = { ...mail, payload: { ...mail.payload, parts: [part(longText), part('<p>All HTML</p>', 'text/html')] } };
  const { provider, calls } = fixture(() => Response.json(full));
  const result = await provider.read(workspaceId, 'reader', gmailBinding, gmail, 'msg1');
  assert.ok(result.normalizedContent.includes(longText));
  assert.ok(result.normalizedContent.includes('<p>All HTML</p>'));
  assert.ok(result.normalizedContent.includes('From: person@example.com'));
  assert.ok(!result.normalizedContent.includes(mail.snippet));
  const original = JSON.parse(Buffer.from(result.bytes).toString());
  assert.equal(Buffer.from(original.payload.parts[0].body.data, 'base64url').toString(), longText);
  assert.equal(original.snippet, undefined);
  assert.equal(result.sourceRevision, '812');
  assert.equal(result.metadataBefore.sourceRevision, result.metadataAfter.sourceRevision);
  assert.equal(result.filename, 'msg1.json');
  assert.equal(calls.length, 2);
});

for (const change of [
  { labelIds: ['SENT'] },
  { internalDate: String(Date.parse(gmail.before)) },
  { internalDate: String(Date.parse(gmail.after) - 1) },
])
  test(`Gmail exact read rejects message outside selection: ${JSON.stringify(change)}`, async () => {
    const { provider } = fixture(() => Response.json({ ...mail, ...change }));
    await assert.rejects(
      provider.check(workspaceId, 'reader', gmailBinding, gmail, 'msg1'),
      failure('outside-selection'),
    );
  });

test('Gmail detects history and body changes across the read', async () => {
  for (const changed of [
    { ...mail, historyId: '813' },
    { ...mail, payload: part('edited') },
  ]) {
    let calls = 0;
    const { provider } = fixture(() => Response.json(calls++ ? changed : mail));
    await assert.rejects(provider.read(workspaceId, 'reader', gmailBinding, gmail, 'msg1'), failure('source-changed'));
  }
});

for (const [payload, code] of [
  [part('x', 'application/pdf'), 'mime-unsupported'],
  [part('x', 'text/plain', { body: { attachmentId: 'attachment', size: 1 } }), 'attachments-unsupported'],
  [part('x', 'text/plain', { body: { size: 3, data: 'eA' } }), 'invalid-response'],
  [
    part('x', 'text/plain', { headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }] }),
    'mime-unsupported',
  ],
  [part('x', 'text/plain', { body: { size: 1, data: '_w' } }), 'mime-unsupported'],
  [{ mimeType: 'multipart/encrypted', body: { size: 0 }, parts: [part('secret')] }, 'mime-unsupported'],
])
  test(`Gmail MIME failures remain explicit (${code}, ${JSON.stringify(payload)})`, async () => {
    const { provider } = fixture(() => Response.json({ ...mail, payload }));
    await assert.rejects(provider.read(workspaceId, 'reader', gmailBinding, gmail, 'msg1'), failure(code));
  });

test('credential refresh errors are stable and cannot leak service details', async () => {
  const { service } = fixture(() => Response.json(source));
  service.withCredential = async () => {
    throw new GoogleWorkspaceError('reconnect-required');
  };
  const provider = createGoogleCorpusProvider({ service });
  await assert.rejects(provider.check(workspaceId, 'reader', binding, shared, 'file1'), failure('reconnect-required'));
});

test('all-Drive selection lists every readable non-folder file across drives and reads without ancestry', async () => {
  const all = { kind: 'drive-all' };
  assert.equal(googleCorpusSelectionSchema.safeParse(all).success, true);
  assert.equal(googleCorpusSelectionSchema.safeParse({ ...all, folderId: 'root' }).success, false);
  const unrelated = { ...source, id: 'file1', parents: ['elsewhere'], driveId: undefined };
  const { provider, calls } = fixture(url => {
    if (url.pathname.endsWith('/files')) {
      assert.equal(url.searchParams.get('corpora'), 'allDrives');
      assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(url.searchParams.get('q'), `trashed = false and mimeType != '${folderMime}'`);
      return Response.json({ files: [unrelated, { ...source, id: 'shared', driveId: 'team' }] });
    }
    return driveResponse(url, unrelated);
  });
  const page = await provider.list(workspaceId, 'reader', binding, all, null);
  assert.deepEqual(
    page.observations.map(item => item.nativeId),
    ['file1', 'shared'],
  );
  assert.equal(page.nextCursor, null);
  const read = await provider.read(workspaceId, 'reader', binding, all, 'file1');
  assert.equal(Buffer.from(read.bytes).toString(), 'hello');
  assert.ok(!calls.some(url => url.pathname.endsWith('/elsewhere')), 'no ancestry walk for all-Drive selections');
  await assert.rejects(provider.discover(workspaceId, 'reader', 'drive-all'), failure('invalid-selection'));
});

test('rolling Gmail selections exclude spam and trash at listing and on every read', async () => {
  const rolling = { ...gmail, labelId: null, window: 'rolling-90d', excludeSpamTrash: true };
  assert.equal(googleCorpusSelectionSchema.safeParse(rolling).success, true);
  assert.equal(googleCorpusSelectionSchema.safeParse({ ...rolling, excludeSpamTrash: false }).success, false);
  let labels = ['INBOX'];
  const { provider } = fixture(url => {
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('includeSpamTrash'), 'false');
      assert.equal(
        url.searchParams.get('q'),
        `after:${Date.parse(gmail.after) / 1000 - 1} before:${Date.parse(gmail.before) / 1000} -in:spam -in:trash`,
      );
      return Response.json({ messages: [{ id: 'msg1' }] });
    }
    return Response.json({ ...mail, labelIds: labels });
  });
  assert.deepEqual(
    (await provider.list(workspaceId, 'reader', gmailBinding, rolling, null)).observations.map(item => item.nativeId),
    ['msg1'],
  );
  labels = ['TRASH'];
  await assert.rejects(
    provider.read(workspaceId, 'reader', gmailBinding, rolling, 'msg1'),
    failure('outside-selection'),
  );
  labels = ['SPAM', 'INBOX'];
  await assert.rejects(
    provider.check(workspaceId, 'reader', gmailBinding, rolling, 'msg1'),
    failure('outside-selection'),
  );
});
