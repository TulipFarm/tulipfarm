import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listGoogleFiles, getGoogleFile, readGoogleFile, readGoogleFileText } from '../src/file-provider.ts';
import { googleFileListRequestSchema, googleFileContentRequestSchema } from '../src/file-contracts.ts';

const expectedIntegration = {
  integrationId: '00000000-0000-4000-8000-000000000001',
  accountId: 'account',
  generation: 1,
};
const reference = { fileId: 'file-1', expectedIntegration };
const metadata = { id: 'file-1', name: 'Report', mimeType: 'application/pdf', capabilities: { canDownload: true } };
const credential = fetcher => ({ accessToken: 'synthetic-private-token', signal: AbortSignal.timeout(5000), fetcher });

test('Files listing escapes names, fixes projection and scope, preserves empty pages with continuation', async () => {
  const input = googleFileListRequestSchema.parse({
    expectedIntegration,
    parentId: 'root',
    name: "Bob's \\ report",
    pageToken: 'next+page',
    pageSize: 2,
  });
  const result = await listGoogleFiles(
    input,
    credential(async (url, init) => {
      assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/drive/v3/files');
      assert.equal(
        url.searchParams.get('q'),
        "trashed = false and 'root' in parents and name contains 'Bob\\'s \\\\ report'",
      );
      assert.equal(url.searchParams.get('pageToken'), 'next+page');
      assert.equal(url.searchParams.get('pageSize'), '2');
      assert.equal(url.searchParams.get('orderBy'), 'folder,name_natural');
      assert.equal(url.searchParams.get('corpora'), 'user');
      assert.equal(url.searchParams.get('spaces'), 'drive');
      assert.match(url.searchParams.get('fields'), /owners\(displayName,emailAddress,me\)/);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer synthetic-private-token');
      return Response.json({ files: [], nextPageToken: 'next', incompleteSearch: true });
    }),
  );
  assert.deepEqual(result, { files: [], nextPageToken: 'next', incompleteSearch: true, skipped: 0 });
  assert.deepEqual(
    await listGoogleFiles(
      googleFileListRequestSchema.parse({ expectedIntegration, sharedWithMe: true }),
      credential(async url => {
        assert.equal(url.searchParams.get('q'), 'trashed = false and sharedWithMe = true');
        return Response.json({ files: [metadata] });
      }),
    ),
    { files: [metadata], incompleteSearch: false, skipped: 0 },
  );
  const linked = { ...metadata, id: 'file-2', webViewLink: 'https://docs.google.com/document/d/file-2/edit' };
  assert.deepEqual(
    await listGoogleFiles(
      input,
      credential(async () => Response.json({ files: [{ name: 'missing identity' }], nextPageToken: 'more' })),
    ),
    { files: [], nextPageToken: 'more', incompleteSearch: false, skipped: 1 },
  );
  assert.deepEqual(
    await listGoogleFiles(
      input,
      credential(async url => {
        assert.match(url.searchParams.get('fields'), /capabilities\(canDownload,canCopy\),webViewLink\)$/);
        return Response.json({
          files: [metadata, { ...metadata, id: 'bad id/..' }, linked, { ...metadata, mimeType: 'not a type' }],
        });
      }),
    ),
    { files: [metadata, linked], incompleteSearch: false, skipped: 2 },
  );
  for (const data of [{ files: 'bad' }, { files: [], nextPageToken: 123 }, { files: Array(101).fill(metadata) }]) {
    await assert.rejects(
      listGoogleFiles(
        input,
        credential(async () => Response.json(data)),
      ),
      /invalid-response/,
    );
  }
});

test('binary download exceeds old cap, PDF exports Docs and Slides, sheet ranges are formatted and bounded', async () => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 0x71);
  for (const source of [
    'application/pdf',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.presentation',
  ]) {
    const kind = source === 'application/pdf' ? 'download' : 'pdf';
    const result = await readGoogleFile(
      { ...reference, kind },
      credential(async (url, init) => {
        assert.equal(url.origin, 'https://www.googleapis.com');
        assert.equal(init.method, undefined);
        if (url.searchParams.has('fields')) return Response.json({ ...metadata, mimeType: source });
        assert.equal(url.pathname, kind === 'pdf' ? '/drive/v3/files/file-1/export' : '/drive/v3/files/file-1');
        assert.equal(url.search, kind === 'pdf' ? '?mimeType=application%2Fpdf' : '?alt=media');
        return new Response(payload);
      }),
    );
    assert.equal(result.kind, 'binary');
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.byteLength, 3 * 1024 * 1024);
    assert.deepEqual(result.bytes, payload);
  }
  const result = await readGoogleFile(
    googleFileContentRequestSchema.parse({
      ...reference,
      kind: 'sheet-range',
      sheetName: "Bob's sheet",
      startRow: 2,
      rowCount: 3,
      startColumn: 26,
      columnCount: 2,
    }),
    credential(async url => {
      assert.equal(url.origin, 'https://sheets.googleapis.com');
      assert.equal(decodeURIComponent(url.pathname), "/v4/spreadsheets/file-1/values/'Bob''s sheet'!Z2:AA4");
      assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
      return Response.json({ range: "'Bob''s sheet'!Z2:AA4", values: [['$12', '10/4/2026']] });
    }),
  );
  assert.deepEqual(result, {
    kind: 'sheet-range',
    data: { range: "'Bob''s sheet'!Z2:AA4", majorDimension: 'ROWS', values: [['$12', '10/4/2026']] },
  });
  assert.equal(
    googleFileContentRequestSchema.safeParse({ ...reference, kind: 'download', url: 'https://evil.test' }).success,
    false,
  );
});

test('known and unknown-length responses stop at 10 MiB and cancel their source', async () => {
  const exact = await readGoogleFile(
    { ...reference, kind: 'download' },
    credential(async url =>
      url.searchParams.has('fields') ? Response.json(metadata) : new Response(Buffer.alloc(10 * 1024 * 1024, 0x62)),
    ),
  );
  assert.equal(exact.byteLength, 10 * 1024 * 1024);
  assert.equal(exact.bytes.at(-1), 0x62);
  for (const known of [true, false]) {
    let cancelled = false;
    let count = 0;
    const body = new ReadableStream({
      pull(controller) {
        count++;
        controller.enqueue(Buffer.alloc(1024 * 1024, 0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      readGoogleFile(
        { ...reference, kind: 'download' },
        credential(async url =>
          url.searchParams.has('fields')
            ? Response.json(metadata)
            : new Response(body, { headers: known ? { 'content-length': String(11 * 1024 * 1024) } : {} }),
        ),
      ),
      /response-too-large/,
    );
    assert.equal(cancelled, true);
    assert.ok(count <= 12);
  }
});

test('abort and deadline cancel a stalled body without releasing bytes', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(
      () => controller.abort(timeout ? new DOMException('deadline', 'TimeoutError') : undefined),
      20,
    );
    try {
      await assert.rejects(
        readGoogleFile(
          { ...reference, kind: 'download' },
          {
            ...credential(async url =>
              url.searchParams.has('fields')
                ? Response.json(metadata)
                : new Response(
                    new ReadableStream({
                      cancel() {
                        cancelled = true;
                      },
                    }),
                  ),
            ),
            signal: controller.signal,
          },
        ),
        timeout ? /transfer-timeout/ : /cancelled/,
      );
      assert.equal(cancelled, true);
    } finally {
      clearTimeout(timer);
    }
  }
});

test('source denial, scope, export rejection, reconnect and transient errors are distinct', async () => {
  for (const [status, reason, code, detail = null] of [
    [401, '', 'reconnect-required'],
    [403, 'insufficientPermissions', 'insufficient-scope'],
    [403, 'insufficientFilePermissions', 'source-access-denied'],
    [404, 'notFound', 'source-not-found'],
    [403, 'exportSizeLimitExceeded', 'export-rejected'],
    [403, 'fileNotExportable', 'export-rejected', 'not-exportable'],
    [403, 'cannotDownloadFile', 'export-rejected', 'download-restricted'],
    [403, 'rateLimitExceeded', 'rate-limited'],
    [429, '', 'rate-limited'],
    [503, '', 'provider-unavailable'],
    [403, 'unknown', 'source-access-denied'],
    [400, 'badRequest', 'provider-rejected'],
  ]) {
    await assert.rejects(
      getGoogleFile(
        'file-1',
        credential(async () => Response.json({ error: { errors: [{ reason }] } }, { status })),
      ),
      error => error.code === code && (error.detail ?? null) === detail,
      `${status} ${reason}`,
    );
  }
  await assert.rejects(
    readGoogleFileText(
      'file-1',
      credential(async () => Response.json({ ...metadata, capabilities: { canDownload: false } })),
    ),
    error => error.code === 'source-access-denied' && error.detail === 'download-restricted',
  );
  await assert.rejects(
    getGoogleFile(
      'file-1',
      credential(async () => Response.json({ ...metadata, name: 'synthetic-private-token' })),
    ),
    /invalid-response/,
  );
  await assert.rejects(
    getGoogleFile(
      'file-1',
      credential(async () => new Response('{bad')),
    ),
    /invalid-response/,
  );
  await assert.rejects(
    readGoogleFile(
      { ...reference, kind: 'download' },
      credential(async () => Response.json({ ...metadata, mimeType: 'application/vnd.google-apps.folder' })),
    ),
    /unsupported-representation/,
  );
  await assert.rejects(
    readGoogleFile(
      { ...reference, kind: 'pdf' },
      credential(async () => Response.json(metadata)),
    ),
    /unsupported-representation/,
  );
});

test('copy exports request the chosen Drive format and reject formats that do not fit the native type', async () => {
  const sheet = 'application/vnd.google-apps.spreadsheet';
  for (const [source, format, mimeType] of [
    [
      'application/vnd.google-apps.document',
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [sheet, 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [sheet, 'csv', 'text/csv'],
    [sheet, 'pdf', 'application/pdf'],
    [
      'application/vnd.google-apps.presentation',
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ]) {
    const result = await readGoogleFile(
      googleFileContentRequestSchema.parse({ ...reference, kind: 'export', format }),
      credential(async url => {
        if (url.searchParams.has('fields')) return Response.json({ ...metadata, mimeType: source });
        assert.equal(
          `${url.pathname}${url.search}`,
          `/drive/v3/files/file-1/export?mimeType=${encodeURIComponent(mimeType)}`,
        );
        return new Response(`${format} bytes`);
      }),
    );
    assert.deepEqual(
      { ...result, bytes: Buffer.from(result.bytes).toString() },
      { kind: 'binary', mimeType, byteLength: format.length + 6, bytes: `${format} bytes` },
    );
  }
  const versioned = await readGoogleFile(
    googleFileContentRequestSchema.parse({ ...reference, kind: 'export', format: 'pdf' }),
    credential(async url =>
      url.searchParams.has('fields')
        ? Response.json({ ...metadata, mimeType: sheet, version: '42' })
        : new Response('pdf bytes'),
    ),
  );
  assert.equal(versioned.version, '42', 'a copy records the Drive version it read');
  for (const [source, format] of [
    [sheet, 'docx'],
    ['application/vnd.google-apps.document', 'csv'],
    ['application/pdf', 'pdf'],
  ]) {
    await assert.rejects(
      readGoogleFile(
        { ...reference, kind: 'export', format },
        credential(async () => Response.json({ ...metadata, mimeType: source })),
      ),
      /unsupported-representation/,
    );
  }
  await assert.rejects(
    readGoogleFile(
      { ...reference, kind: 'pdf' },
      credential(async () => Response.json({ ...metadata, mimeType: sheet })),
    ),
    /unsupported-representation/,
  );
  assert.equal(
    googleFileContentRequestSchema.safeParse({ ...reference, kind: 'export', format: 'html' }).success,
    false,
  );
});

test('text reads export Docs and Slides as plain text, Sheets as CSV, download other files, and reject other native types', async () => {
  const cases = [
    ['application/vnd.google-apps.document', '/files/doc-1/export', 'text/plain', 'export'],
    ['application/vnd.google-apps.presentation', '/files/doc-1/export', 'text/plain', 'export'],
    ['application/vnd.google-apps.spreadsheet', '/files/doc-1/export', 'text/csv', 'export'],
    ['text/markdown', '/files/doc-1', 'text/markdown', 'download'],
  ];
  for (const [mimeType, path, contentType, representation] of cases) {
    const result = await readGoogleFileText(
      'doc-1',
      credential(async url => {
        if (url.searchParams.has('fields'))
          return Response.json({
            id: 'doc-1',
            name: 'Plan',
            mimeType,
            version: '7',
            modifiedTime: '2026-10-05T08:00:00.000Z',
          });
        assert.equal(url.pathname, `/drive/v3${path}`);
        assert.equal(
          url.searchParams.get('mimeType') ?? url.searchParams.get('alt'),
          representation === 'export' ? contentType : 'media',
        );
        return new Response('current text');
      }),
    );
    assert.deepEqual(
      { ...result, bytes: Buffer.from(result.bytes).toString() },
      {
        metadata: { id: 'doc-1', name: 'Plan', mimeType, version: '7', modifiedTime: '2026-10-05T08:00:00.000Z' },
        bytes: 'current text',
        contentType,
        representation,
      },
    );
  }
  await assert.rejects(
    readGoogleFileText(
      'doc-1',
      credential(async () =>
        Response.json({ id: 'doc-1', name: 'Survey', mimeType: 'application/vnd.google-apps.form' }),
      ),
    ),
    /unsupported-representation/,
  );
  await assert.rejects(
    readGoogleFileText(
      'doc-1',
      credential(async () => Response.json({ id: 'doc-1', name: 'Old', mimeType: 'text/plain', trashed: true })),
    ),
    /source-not-found/,
  );
  await assert.rejects(
    readGoogleFileText(
      'doc-1',
      credential(async () => Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status: 403 })),
    ),
    /source-access-denied/,
  );
});
