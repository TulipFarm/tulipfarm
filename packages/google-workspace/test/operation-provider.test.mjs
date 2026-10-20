import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dispatchGoogleOperation, readGoogleRevision } from '../src/operation-provider.ts';
import { freshPresentation, slidesFake } from './slides-fixture.mjs';
import {
  googleAgentOperationSchema,
  googleOperationSchema,
  googleOperationCatalog,
  googleWriteTarget,
  isGoogleWrite,
  GoogleOperationError,
} from '../src/operation-contracts.ts';

const accessToken = 'test-access-token-private-1234567890';
const message = { to: ['person@example.com'], subject: 'Hello', body: 'Body' };
const raw = Buffer.from(
  'To: person@example.com\r\nSubject: =?UTF-8?B?SGVsbG8=?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nQm9keQ==\r\n',
).toString('base64url');
const event = { summary: 'Review', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } };
const fileFields = 'id,name,mimeType,description,parents,trashed,starred,size,modifiedTime,webViewLink';
const permissionFields = 'id,type,role,emailAddress,domain,allowFileDiscovery';
const slideText = 'text(textElements(startIndex,endIndex,textRun/content))';
const slideElementFields = `objectId,size,transform,title,description,shape(shapeType,placeholder(type,parentObjectId),${slideText}),table(rows,columns,tableRows(tableCells(location,${slideText}))),elementGroup(children(objectId)),line(lineType),wordArt(renderedText)`;
const slidesContentFields = `presentationId,title,locale,revisionId,pageSize,slides(objectId,slideProperties(layoutObjectId),pageElements(${slideElementFields}))`;
const slidesPageFields = `objectId,pageType,revisionId,slideProperties(layoutObjectId),pageElements(${slideElementFields})`;
const cases = [
  [
    'gmail.messages.list',
    { q: 'from:a@example.com', labelIds: ['INBOX', 'UNREAD'], pageToken: 'next' },
    'GET',
    '/gmail/v1/users/me/messages',
    undefined,
    { q: 'from:a@example.com', labelIds: ['INBOX', 'UNREAD'], pageToken: 'next', maxResults: '50' },
  ],
  ['gmail.messages.get', { messageId: 'm1' }, 'GET', '/gmail/v1/users/me/messages/m1', undefined, { format: 'full' }],
  [
    'gmail.messages.modify',
    { messageId: 'm1', addLabelIds: ['INBOX'] },
    'POST',
    '/gmail/v1/users/me/messages/m1/modify',
    { addLabelIds: ['INBOX'], removeLabelIds: [] },
  ],
  ['gmail.messages.trash', { messageId: 'm1' }, 'POST', '/gmail/v1/users/me/messages/m1/trash', {}],
  ['gmail.messages.untrash', { messageId: 'm1' }, 'POST', '/gmail/v1/users/me/messages/m1/untrash', {}],
  ['gmail.messages.send', { message }, 'POST', '/gmail/v1/users/me/messages/send', { raw }],
  ['gmail.drafts.list', {}, 'GET', '/gmail/v1/users/me/drafts', undefined, { maxResults: '50' }],
  ['gmail.drafts.get', { draftId: 'd1' }, 'GET', '/gmail/v1/users/me/drafts/d1', undefined, { format: 'full' }],
  ['gmail.drafts.create', { message }, 'POST', '/gmail/v1/users/me/drafts', { message: { raw } }],
  ['gmail.drafts.update', { draftId: 'd1', message }, 'PUT', '/gmail/v1/users/me/drafts/d1', { message: { raw } }],
  ['gmail.drafts.delete', { draftId: 'd1' }, 'DELETE', '/gmail/v1/users/me/drafts/d1'],
  [
    'gmail.drafts.send',
    { draftId: 'd1', message },
    'POST',
    '/gmail/v1/users/me/drafts/send',
    { id: 'd1', message: { raw } },
  ],
  ['gmail.labels.list', {}, 'GET', '/gmail/v1/users/me/labels'],
  ['gmail.labels.get', { labelId: 'l1' }, 'GET', '/gmail/v1/users/me/labels/l1'],
  ['gmail.labels.create', { label: { name: 'Review' } }, 'POST', '/gmail/v1/users/me/labels', { name: 'Review' }],
  [
    'gmail.labels.update',
    { labelId: 'l1', label: { name: 'Done', labelListVisibility: 'labelHide' } },
    'PATCH',
    '/gmail/v1/users/me/labels/l1',
    { name: 'Done', labelListVisibility: 'labelHide' },
  ],
  ['gmail.labels.delete', { labelId: 'l1' }, 'DELETE', '/gmail/v1/users/me/labels/l1'],
  ['calendar.calendars.list', {}, 'GET', '/calendar/v3/users/me/calendarList', undefined, { maxResults: '50' }],
  ['calendar.calendars.get', { calendarId: 'a@example.com' }, 'GET', '/calendar/v3/calendars/a%40example.com'],
  [
    'calendar.calendars.create',
    { calendar: { summary: 'Team' } },
    'POST',
    '/calendar/v3/calendars',
    { summary: 'Team' },
  ],
  [
    'calendar.calendars.update',
    { calendarId: 'primary', calendar: { summary: 'Team' } },
    'PATCH',
    '/calendar/v3/calendars/primary',
    { summary: 'Team' },
  ],
  ['calendar.calendars.delete', { calendarId: 'team' }, 'DELETE', '/calendar/v3/calendars/team'],
  [
    'calendar.events.list',
    { calendarId: 'primary', singleEvents: true, timeMin: '2026-10-01T00:00:00Z' },
    'GET',
    '/calendar/v3/calendars/primary/events',
    undefined,
    { singleEvents: 'true', timeMin: '2026-10-01T00:00:00Z', maxResults: '50' },
  ],
  ['calendar.events.get', { calendarId: 'primary', eventId: 'e1' }, 'GET', '/calendar/v3/calendars/primary/events/e1'],
  [
    'calendar.events.create',
    { calendarId: 'primary', event, sendUpdates: 'all' },
    'POST',
    '/calendar/v3/calendars/primary/events',
    event,
    { sendUpdates: 'all' },
  ],
  [
    'calendar.events.update',
    { calendarId: 'primary', eventId: 'e1', event },
    'PATCH',
    '/calendar/v3/calendars/primary/events/e1',
    event,
    { sendUpdates: 'none' },
  ],
  [
    'calendar.events.delete',
    { calendarId: 'primary', eventId: 'e1' },
    'DELETE',
    '/calendar/v3/calendars/primary/events/e1',
    undefined,
    { sendUpdates: 'none' },
  ],
  [
    'drive.files.list',
    { q: 'trashed = false' },
    'GET',
    '/drive/v3/files',
    undefined,
    { q: 'trashed = false', pageSize: '50', fields: `nextPageToken,files(${fileFields})` },
  ],
  ['drive.files.get', { fileId: 'f1' }, 'GET', '/drive/v3/files/f1', undefined, { fields: fileFields }],
  [
    'drive.files.create',
    { file: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' } },
    'POST',
    '/drive/v3/files',
    { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
    { fields: fileFields },
  ],
  [
    'drive.files.update',
    { fileId: 'f1', file: { name: 'New' }, addParents: ['folder'], removeParents: ['old'] },
    'PATCH',
    '/drive/v3/files/f1',
    { name: 'New' },
    { fields: fileFields, addParents: 'folder', removeParents: 'old' },
  ],
  [
    'drive.files.copy',
    { fileId: 'f1', file: { name: 'Copy' } },
    'POST',
    '/drive/v3/files/f1/copy',
    { name: 'Copy' },
    { fields: fileFields },
  ],
  ['drive.files.trash', { fileId: 'f1' }, 'PATCH', '/drive/v3/files/f1', { trashed: true }, { fields: fileFields }],
  [
    'drive.files.upload',
    { fileId: 'f1', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' },
    'PATCH',
    '/upload/drive/v3/files/f1',
    Buffer.from('hello'),
    { uploadType: 'media', fields: fileFields },
  ],
  ['drive.files.download', { fileId: 'f1' }, 'GET', '/drive/v3/files/f1', undefined, { alt: 'media' }],
  [
    'drive.files.export',
    { fileId: 'f1', mimeType: 'application/pdf' },
    'GET',
    '/drive/v3/files/f1/export',
    undefined,
    { mimeType: 'application/pdf' },
  ],
  [
    'drive.permissions.list',
    { fileId: 'f1' },
    'GET',
    '/drive/v3/files/f1/permissions',
    undefined,
    { pageSize: '50', fields: `nextPageToken,permissions(${permissionFields})` },
  ],
  [
    'drive.permissions.get',
    { fileId: 'f1', permissionId: 'p1' },
    'GET',
    '/drive/v3/files/f1/permissions/p1',
    undefined,
    { fields: permissionFields },
  ],
  [
    'drive.permissions.create',
    { fileId: 'f1', permission: { type: 'user', role: 'reader', emailAddress: 'person@example.com' } },
    'POST',
    '/drive/v3/files/f1/permissions',
    { type: 'user', role: 'reader', emailAddress: 'person@example.com' },
    { sendNotificationEmail: 'false', fields: permissionFields },
  ],
  [
    'drive.permissions.update',
    { fileId: 'f1', permissionId: 'p1', role: 'writer' },
    'PATCH',
    '/drive/v3/files/f1/permissions/p1',
    { role: 'writer' },
    { fields: permissionFields },
  ],
  ['drive.permissions.delete', { fileId: 'f1', permissionId: 'p1' }, 'DELETE', '/drive/v3/files/f1/permissions/p1'],
  [
    'sheets.spreadsheets.get',
    { spreadsheetId: 's1', ranges: ['Sheet 1!A1:B2', 'Sheet2!A1'] },
    'GET',
    '/v4/spreadsheets/s1',
    undefined,
    { ranges: ['Sheet 1!A1:B2', 'Sheet2!A1'], includeGridData: 'false' },
  ],
  [
    'sheets.spreadsheets.create',
    { title: 'Report', sheets: [{ title: 'Sales' }] },
    'POST',
    '/v4/spreadsheets',
    { properties: { title: 'Report' }, sheets: [{ properties: { title: 'Sales' } }] },
  ],
  [
    'sheets.values.get',
    { spreadsheetId: 's1', range: 'Sheet 1!A1:B2' },
    'GET',
    '/v4/spreadsheets/s1/values/Sheet%201!A1%3AB2',
  ],
  [
    'sheets.values.update',
    { spreadsheetId: 's1', range: 'A1', values: [['ok', 2, true, null]], valueInputOption: 'RAW' },
    'PUT',
    '/v4/spreadsheets/s1/values/A1',
    { range: 'A1', values: [['ok', 2, true, null]] },
    { valueInputOption: 'RAW' },
  ],
  [
    'sheets.values.append',
    { spreadsheetId: 's1', range: 'A1', values: [[3]], valueInputOption: 'USER_ENTERED' },
    'POST',
    '/v4/spreadsheets/s1/values/A1:append',
    { range: 'A1', values: [[3]] },
    { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
  ],
  ['sheets.values.clear', { spreadsheetId: 's1', range: 'A1' }, 'POST', '/v4/spreadsheets/s1/values/A1:clear', {}],
  [
    'sheets.values.batchGet',
    { spreadsheetId: 's1', ranges: ['A1', 'B1'] },
    'GET',
    '/v4/spreadsheets/s1/values:batchGet',
    undefined,
    { ranges: ['A1', 'B1'] },
  ],
  [
    'sheets.values.batchUpdate',
    { spreadsheetId: 's1', valueInputOption: 'RAW', data: [{ range: 'A1', values: [[1]] }] },
    'POST',
    '/v4/spreadsheets/s1/values:batchUpdate',
    { valueInputOption: 'RAW', data: [{ range: 'A1', values: [[1]] }] },
  ],
  [
    'sheets.values.batchClear',
    { spreadsheetId: 's1', ranges: ['A1'] },
    'POST',
    '/v4/spreadsheets/s1/values:batchClear',
    { ranges: ['A1'] },
  ],
  [
    'sheets.spreadsheets.batchUpdate',
    { spreadsheetId: 's1', requests: [{ addSheet: { properties: { title: 'Sales' } } }] },
    'POST',
    '/v4/spreadsheets/s1:batchUpdate',
    { requests: [{ addSheet: { properties: { title: 'Sales' } } }] },
  ],
  ['docs.documents.create', { title: 'Notes' }, 'POST', '/v1/documents', { title: 'Notes' }],
  [
    'docs.documents.get',
    { documentId: 'doc1' },
    'GET',
    '/v1/documents/doc1',
    undefined,
    { includeTabsContent: 'true' },
  ],
  [
    'docs.documents.batchUpdate',
    {
      documentId: 'doc1',
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
      requiredRevisionId: 'rev1',
    },
    'POST',
    '/v1/documents/doc1:batchUpdate',
    {
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
      writeControl: { requiredRevisionId: 'rev1' },
    },
  ],
  ['slides.presentations.create', { title: 'Deck' }, 'POST', '/v1/presentations', { title: 'Deck' }],
  [
    'slides.presentations.get',
    { presentationId: 'pres1' },
    'GET',
    '/v1/presentations/pres1',
    undefined,
    { fields: slidesContentFields },
  ],
  [
    'slides.presentations.pages.get',
    { presentationId: 'pres1', pageObjectId: 'slide1' },
    'GET',
    '/v1/presentations/pres1/pages/slide1',
    undefined,
    { fields: slidesPageFields },
  ],
  [
    'slides.presentations.batchUpdate',
    {
      presentationId: 'pres1',
      requests: [{ createSlide: { objectId: 'slide1', slideLayoutReference: { predefinedLayout: 'BLANK' } } }],
    },
    'POST',
    '/v1/presentations/pres1:batchUpdate',
    { requests: [{ createSlide: { objectId: 'slide1', slideLayoutReference: { predefinedLayout: 'BLANK' } } }] },
  ],
];

const hosts = {
  gmail: 'gmail.googleapis.com',
  calendar: 'www.googleapis.com',
  drive: 'www.googleapis.com',
  sheets: 'sheets.googleapis.com',
  docs: 'docs.googleapis.com',
  slides: 'slides.googleapis.com',
};

test('Calendar create and update request Google Meet without dropping the conference contract', async () => {
  const conferenceData = {
    createRequest: {
      requestId: '33333333-3333-4333-8333-333333333333',
      conferenceSolutionKey: { type: 'hangoutsMeet' },
    },
  };
  for (const kind of ['calendar.events.create', 'calendar.events.update']) {
    const operation = {
      kind,
      calendarId: 'primary',
      ...(kind.endsWith('update') ? { eventId: 'e1' } : {}),
      event: { ...event, conferenceData },
      sendUpdates: 'all',
    };
    assert.equal(googleAgentOperationSchema.safeParse(operation).success, true);
    const result = await dispatchGoogleOperation({
      operation,
      accessToken,
      fetcher: async (url, init) => {
        assert.equal(url.searchParams.get('conferenceDataVersion'), '1');
        assert.equal(url.searchParams.get('sendUpdates'), 'all');
        assert.deepEqual(JSON.parse(init.body).conferenceData, conferenceData);
        return Response.json({ id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } });
      },
    });
    assert.equal(result.conferenceData.createRequest.status.statusCode, 'pending');
  }
  assert.equal(
    googleOperationSchema.safeParse({
      kind: 'calendar.events.create',
      calendarId: 'primary',
      event: { ...event, conferenceData: { createRequest: { conferenceSolutionKey: { type: 'unsupported' } } } },
    }).success,
    false,
  );
});

for (const [kind, input, method, pathname, expectedBody, query = {}] of cases) {
  test(`${kind} serializes its bounded HTTP contract`, async () => {
    const operation = googleOperationSchema.parse({ kind, ...input });
    let calls = 0;
    const result = await dispatchGoogleOperation({
      operation,
      accessToken,
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url.origin, `https://${hosts[kind.split('.')[0]]}`);
        assert.equal(url.pathname, pathname);
        const actualQuery = {};
        for (const key of new Set(url.searchParams.keys()))
          actualQuery[key] = Array.isArray(query[key]) ? url.searchParams.getAll(key) : url.searchParams.get(key);
        assert.deepEqual(actualQuery, query);
        assert.equal(init.method, method);
        assert.equal(init.redirect, 'error');
        assert.equal(init.signal.aborted, false);
        assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
        if (Buffer.isBuffer(expectedBody)) {
          assert.deepEqual(init.body, expectedBody);
          assert.equal(init.headers['content-type'], 'text/plain');
        } else assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), expectedBody);
        return kind.endsWith('.download') || kind.endsWith('.export')
          ? new Response('hello')
          : Response.json({ id: 'result1' });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(
      result,
      kind.endsWith('.download') || kind.endsWith('.export')
        ? { contentBase64: 'aGVsbG8=', byteLength: 5 }
        : { id: 'result1' },
    );
    const metadata = googleOperationCatalog.find(entry => entry.kind === kind);
    assert.equal(isGoogleWrite(operation), method !== 'GET');
    assert.equal(metadata.approvalRequired, method !== 'GET');
    assert.equal(metadata.effect, method === 'GET' ? 'read' : 'write');
    const versioned = [
      'sheets.values.update',
      'sheets.values.batchUpdate',
      'sheets.values.clear',
      'sheets.spreadsheets.batchUpdate',
    ].includes(kind);
    assert.equal(metadata.requiredScopes.length, versioned ? 2 : 1);
    if (versioned)
      assert.equal(
        metadata.requiredScopes[1],
        'https://www.googleapis.com/auth/drive',
        'the Drive version read needs a Drive scope',
      );
  });
}

test('a new one-slide presentation reads within the model tool result limit', async () => {
  const presentation = freshPresentation();
  assert.ok(JSON.stringify(presentation).length > 96_000, 'the unprojected presentation exceeds the tool result limit');
  const google = slidesFake(presentation);
  const content = await dispatchGoogleOperation({
    operation: { kind: 'slides.presentations.get', presentationId: 'qa-deck' },
    accessToken,
    fetcher: google.fetcher,
  });
  assert.ok(JSON.stringify(content).length < 4_000, `projected read is ${JSON.stringify(content).length} characters`);
  assert.deepEqual(Object.keys(content), ['presentationId', 'title', 'locale', 'revisionId', 'pageSize', 'slides']);
  assert.deepEqual(
    [content.presentationId, content.title, content.revisionId],
    ['qa-deck', 'qa-20261003-cloud-agent-created-slides', 'rev-fresh-1'],
  );
  assert.deepEqual(
    content.slides.map(slide => [
      slide.objectId,
      slide.slideProperties.layoutObjectId,
      slide.pageElements.map(element => [element.objectId, element.shape.placeholder.type]),
    ]),
    [
      [
        'p',
        'p2',
        [
          ['i0', 'CENTERED_TITLE'],
          ['i1', 'SUBTITLE'],
        ],
      ],
    ],
  );
  assert.deepEqual(content.slides[0].pageElements[0].shape.text, {
    textElements: [{ endIndex: 1 }, { startIndex: 0, endIndex: 1, textRun: { content: '\n' } }],
  });

  const outline = await dispatchGoogleOperation({
    operation: { kind: 'slides.presentations.get', presentationId: 'qa-deck', view: 'outline' },
    accessToken,
    fetcher: google.fetcher,
  });
  assert.deepEqual(outline, {
    presentationId: 'qa-deck',
    title: 'qa-20261003-cloud-agent-created-slides',
    locale: 'en',
    revisionId: 'rev-fresh-1',
    pageSize: presentation.pageSize,
    slides: [{ objectId: 'p' }],
  });

  const page = await dispatchGoogleOperation({
    operation: { kind: 'slides.presentations.pages.get', presentationId: 'qa-deck', pageObjectId: 'p' },
    accessToken,
    fetcher: google.fetcher,
  });
  assert.deepEqual(
    [page.objectId, page.pageType, page.revisionId, page.pageElements.map(element => element.objectId)],
    ['p', 'SLIDE', 'rev-fresh-1', ['i0', 'i1']],
  );
  assert.equal('notesPage' in page.slideProperties, false);
  assert.deepEqual(
    google.requests.map(url => url.searchParams.get('fields')),
    [slidesContentFields, 'presentationId,title,locale,revisionId,pageSize,slides(objectId)', slidesPageFields],
  );
});

test('HTTP examples cover every catalog operation exactly once', () => {
  assert.deepEqual(cases.map(([kind]) => kind).sort(), googleOperationCatalog.map(entry => entry.kind).sort());
  assert.equal(new Set(cases.map(([kind]) => kind)).size, cases.length);
});

const read = { kind: 'gmail.labels.list' };
const write = { kind: 'gmail.messages.send', message };
function code(expected) {
  return error => {
    assert.equal(error instanceof GoogleOperationError, true);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(accessToken), false);
    return true;
  };
}

const invalid = [
  { kind: 'gmail.drafts.send', draftId: 'd1' },
  { kind: 'request', url: 'https://evil.example', method: 'GET' },
  { ...read, accessToken },
  { ...read, token: accessToken },
  { ...read, url: 'https://evil.example' },
  { ...read, headers: { authorization: accessToken } },
  { kind: 'gmail.messages.get', messageId: '../labels' },
  { kind: 'gmail.messages.get', messageId: '%2e%2e' },
  { kind: 'calendar.calendars.get', calendarId: '..' },
  { kind: 'calendar.calendars.get', calendarId: 'a?key=secret' },
  { kind: 'drive.files.get', fileId: 'https://evil.example' },
  { kind: 'gmail.messages.list', maxResults: 101 },
  { kind: 'gmail.messages.list', pageToken: 'x'.repeat(2049) },
  { kind: 'gmail.messages.send', message: { ...message, raw: 'arbitrary' } },
  { kind: 'gmail.messages.send', message: { ...message, subject: 'Hello\r\nBcc: victim@example.com' } },
  { kind: 'gmail.messages.send', message: { ...message, to: ['person@example.com\nBcc: victim@example.com'] } },
  { kind: 'gmail.messages.send', message: { ...message, inReplyTo: '<id@example.com>\r\nX: bad' } },
  { kind: 'gmail.messages.send', message: { ...message, body: 'x'.repeat(100_001) } },
  { kind: 'drive.files.upload', contentBase64: 'a===', mimeType: 'text/plain' },
  { kind: 'drive.files.upload', contentBase64: 'aGVsbG8=', mimeType: 'text/plain\r\nX: bad' },
  {
    kind: 'drive.permissions.create',
    fileId: 'f1',
    permission: { type: 'user', role: 'owner', emailAddress: 'a@example.com' },
  },
  {
    kind: 'sheets.values.update',
    spreadsheetId: 's1',
    range: 'A1',
    values: [[{ arbitrary: true }]],
    valueInputOption: 'RAW',
  },
  { kind: 'sheets.values.get', spreadsheetId: 's1', range: '..' },
  { kind: 'sheets.values.get', spreadsheetId: 's1', range: '\ud800' },
  { kind: 'calendar.events.create', calendarId: 'primary', event: { ...event, end: { date: '2026-09-01' } } },
  {
    kind: 'calendar.events.create',
    calendarId: 'primary',
    event: { ...event, end: { dateTime: '2026-10-02T00:00:00Z' } },
  },
  { kind: 'docs.documents.batchUpdate', documentId: 'd1', requests: [{ arbitrary: {} }] },
  {
    kind: 'docs.documents.batchUpdate',
    documentId: 'd1',
    requests: [{ insertText: { text: 'hello', location: { index: 1 }, unknown: true } }],
  },
  {
    kind: 'slides.presentations.batchUpdate',
    presentationId: 'p1',
    requests: [{ createImage: { url: 'https://evil.example' } }],
  },
  {
    kind: 'sheets.spreadsheets.batchUpdate',
    spreadsheetId: 's1',
    requests: [{ addDataSource: { spec: { arbitrary: true } } }],
  },
  { kind: 'docs.documents.batchUpdate', documentId: 'd1', requests: [] },
  {
    kind: 'docs.documents.batchUpdate',
    documentId: 'd1',
    requests: Array.from({ length: 101 }, () => ({ insertPageBreak: { location: { index: 1 } } })),
  },
];

for (const [i, operation] of invalid.entries())
  test(`rejects unapproved request shape ${i + 1} before HTTP`, async () => {
    let calls = 0;
    assert.equal(googleOperationSchema.safeParse(operation).success, false);
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        fetcher: async () => {
          calls++;
          return Response.json({ ok: true });
        },
      }),
      code('invalid-operation'),
    );
    assert.equal(calls, 0);
  });

for (const [status, readCode, writeCode] of [
  [400, 'provider-rejected', 'provider-rejected'],
  [401, 'reconnect-required', 'reconnect-required'],
  [403, 'insufficient-scope', 'insufficient-scope'],
  [429, 'rate-limited', 'rate-limited'],
  [500, 'provider-unavailable', 'outcome-unknown'],
  [503, 'provider-unavailable', 'outcome-unknown'],
  [408, 'provider-rejected', 'outcome-unknown'],
  [302, 'provider-rejected', 'outcome-unknown'],
]) {
  test(`HTTP ${status} is sanitized and write uncertainty is preserved`, async () => {
    for (const [operation, expected] of [
      [read, readCode],
      [write, writeCode],
    ]) {
      let calls = 0;
      await assert.rejects(
        dispatchGoogleOperation({
          operation,
          accessToken,
          fetcher: async () => {
            calls++;
            return new Response(accessToken, { status, headers: { location: 'https://evil.example' } });
          },
        }),
        code(expected),
      );
      assert.equal(calls, 1);
    }
  });
}

test('integration loss is not retried and writes have unknown outcomes', async () => {
  for (const [operation, expected] of [
    [read, 'provider-unavailable'],
    [write, 'outcome-unknown'],
  ]) {
    let calls = 0;
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        fetcher: async () => {
          calls++;
          throw new Error(accessToken);
        },
      }),
      code(expected),
    );
    assert.equal(calls, 1);
  }
});

test('pre-aborted calls never dispatch; cancellation after dispatch cannot prove write failure', async () => {
  const before = new AbortController();
  before.abort(accessToken);
  await assert.rejects(
    dispatchGoogleOperation({ operation: write, accessToken, signal: before.signal }),
    code('cancelled'),
  );
  for (const [operation, expected] of [
    [read, 'cancelled'],
    [write, 'outcome-unknown'],
  ]) {
    const controller = new AbortController();
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        signal: controller.signal,
        fetcher: async (_url, init) => {
          controller.abort(accessToken);
          init.signal.throwIfAborted();
        },
      }),
      code(expected),
    );
  }
});

test('bounds streamed response bytes and cancels oversized bodies without trusting Content-Length', async () => {
  for (const [operation, expected] of [
    [read, 'response-too-large'],
    [write, 'outcome-unknown'],
  ]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        fetcher: async () => new Response(stream, { headers: { 'content-length': '1' } }),
      }),
      code(expected),
    );
    assert.equal(cancelled, true);
  }
});

test('oversized declared responses cancel before reading', async () => {
  let cancelled = false;
  await assert.rejects(
    dispatchGoogleOperation({
      operation: read,
      accessToken,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-length': '2097153' } },
        ),
    }),
    code('response-too-large'),
  );
  assert.equal(cancelled, true);
});

test('a stalled response body is cancelled on abort', async () => {
  const controller = new AbortController();
  let cancelled = false;
  await assert.rejects(
    dispatchGoogleOperation({
      operation: read,
      accessToken,
      signal: controller.signal,
      fetcher: async () => {
        setTimeout(() => controller.abort(), 10);
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    }),
    code('cancelled'),
  );
  assert.equal(cancelled, true);
});

test('response tokens never escape through JSON, escaped JSON, binary or error bodies', async () => {
  for (const body of [
    JSON.stringify({ value: accessToken }),
    `{"value":"${accessToken.replaceAll('t', '\\u0074')}"}`,
    JSON.stringify({ value: Buffer.from(accessToken).toString('base64') }),
  ]) {
    await assert.rejects(
      dispatchGoogleOperation({ operation: read, accessToken, fetcher: async () => new Response(body) }),
      code('invalid-response'),
    );
    await assert.rejects(
      dispatchGoogleOperation({ operation: write, accessToken, fetcher: async () => new Response(body) }),
      code('outcome-unknown'),
    );
  }
  await assert.rejects(
    dispatchGoogleOperation({
      operation: { kind: 'drive.files.download', fileId: 'f1' },
      accessToken,
      fetcher: async () => new Response(accessToken),
    }),
    code('invalid-response'),
  );
});

test('malformed success after a write has unknown outcome', async () => {
  await assert.rejects(
    dispatchGoogleOperation({ operation: write, accessToken, fetcher: async () => new Response('not json') }),
    code('outcome-unknown'),
  );
  assert.deepEqual(
    await dispatchGoogleOperation({
      operation: { kind: 'gmail.drafts.delete', draftId: 'd1' },
      accessToken,
      fetcher: async () => new Response(null, { status: 204 }),
    }),
    { success: true },
  );
});

test('UTF-8 subject and MIME body are folded, encoded and preserve exact content', async () => {
  const subject = '🌷 café '.repeat(40);
  const body = 'Bcc: not-a-header@example.com\r\n\r\n你好🌷'.repeat(100);
  await dispatchGoogleOperation({
    operation: {
      kind: 'gmail.messages.send',
      message: {
        ...message,
        subject,
        body,
        cc: ['other@example.com'],
        bcc: ['private@example.com'],
        threadId: 't1',
        inReplyTo: '<id@example.com>',
      },
    },
    accessToken,
    fetcher: async (_url, init) => {
      const payload = JSON.parse(init.body);
      assert.equal(payload.threadId, 't1');
      const decoded = Buffer.from(payload.raw, 'base64url').toString('utf8');
      const [headers, encodedBody] = decoded.split('\r\n\r\n');
      const words = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
      assert.equal(words.map(([, value]) => Buffer.from(value, 'base64').toString('utf8')).join(''), subject);
      assert.equal(Buffer.from(encodedBody.replaceAll('\r\n', ''), 'base64').toString('utf8'), body);
      assert.equal(
        decoded.split('\r\n').every(line => Buffer.byteLength(line) <= 78),
        true,
      );
      assert.equal(headers.includes('References: <id@example.com>'), true);
      return Response.json({ id: 'sent1' });
    },
  });
});

test('upload creates media and decodes base64 only once', async () => {
  const result = await dispatchGoogleOperation({
    operation: { kind: 'drive.files.upload', mimeType: 'application/octet-stream', contentBase64: 'AP8=' },
    accessToken,
    fetcher: async (url, init) => {
      assert.equal(url.pathname, '/upload/drive/v3/files');
      assert.equal(init.method, 'POST');
      assert.deepEqual([...init.body], [0, 255]);
      return Response.json({ id: 'f2' });
    },
  });
  assert.deepEqual(result, { id: 'f2' });
});

test('upload with metadata sends one multipart body that names and converts the file', async () => {
  const file = { name: 'Plan', mimeType: 'application/vnd.google-apps.document', parents: ['folder1'] };
  await dispatchGoogleOperation({
    operation: { kind: 'drive.files.upload', mimeType: 'application/octet-stream', contentBase64: 'AP8=', file },
    accessToken,
    fetcher: async (url, init) => {
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      const boundary = /^multipart\/related; boundary=(.+)$/.exec(init.headers['content-type'])[1];
      const body = Buffer.from(init.body);
      const metadata = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(file)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
      assert.deepEqual(
        body,
        Buffer.concat([Buffer.from(metadata), Buffer.from([0, 255]), Buffer.from(`\r\n--${boundary}--`)]),
      );
      return Response.json({ id: 'f3' });
    },
  });
});

test('aggregate request byte limit rejects a valid but oversized values batch', async () => {
  let calls = 0;
  const operation = {
    kind: 'sheets.values.update',
    spreadsheetId: 's1',
    range: 'A1',
    valueInputOption: 'RAW',
    values: [Array(100).fill('x'.repeat(50_000))],
  };
  await assert.rejects(
    dispatchGoogleOperation({
      operation,
      accessToken,
      fetcher: async () => {
        calls++;
        return Response.json({});
      },
    }),
    code('invalid-operation'),
  );
  assert.equal(calls, 0);
});

const sheetBatch = [
  { addSheet: { properties: { title: 'Sales', sheetId: 1 } } },
  { deleteSheet: { sheetId: 2 } },
  { updateSheetProperties: { properties: { sheetId: 1, title: 'Revenue' }, fields: 'title' } },
  {
    repeatCell: {
      range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat',
    },
  },
  {
    insertDimension: { range: { sheetId: 1, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: true },
  },
  { deleteDimension: { range: { sheetId: 1, dimension: 'ROWS', startIndex: 1, endIndex: 2 } } },
  { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 } } },
  { mergeCells: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2 }, mergeType: 'MERGE_ALL' } },
  { unmergeCells: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2 } } },
];
const docsBatch = [
  { insertText: { location: { index: 1, tabId: 't.0' }, text: 'Hello' } },
  { replaceAllText: { containsText: { text: 'Hello', matchCase: true }, replaceText: 'Goodbye' } },
  { deleteContentRange: { range: { startIndex: 1, endIndex: 3, tabId: 't.0' } } },
  {
    updateTextStyle: {
      range: { startIndex: 1, endIndex: 3 },
      textStyle: { bold: true, italic: false },
      fields: 'bold,italic',
    },
  },
  { insertTable: { rows: 2, columns: 3, location: { index: 1 } } },
  { insertPageBreak: { location: { index: 5 } } },
];
const slidesBatch = [
  { createSlide: { objectId: 'slide:1', insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'TITLE' } } },
  { deleteObject: { objectId: 'slide:1' } },
  { duplicateObject: { objectId: 'slide:1' } },
  { insertText: { objectId: 'shape:1', insertionIndex: 0, text: 'Hello' } },
  { deleteText: { objectId: 'shape:1', textRange: { type: 'ALL' } } },
  {
    replaceAllText: {
      containsText: { text: 'Hello', matchCase: false },
      replaceText: 'Goodbye',
      pageObjectIds: ['slide:1'],
    },
  },
  {
    updateTextStyle: {
      objectId: 'shape:1',
      textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: 2 },
      style: { underline: true },
      fields: 'underline',
    },
  },
  { createShape: { objectId: 'shape:1', shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: 'slide:1' } } },
];
for (const [kind, target, requests] of [
  ['sheets.spreadsheets.batchUpdate', { spreadsheetId: 's1' }, sheetBatch],
  ['docs.documents.batchUpdate', { documentId: 'd1' }, docsBatch],
  ['slides.presentations.batchUpdate', { presentationId: 'p1' }, slidesBatch],
])
  for (const batchRequest of requests)
    test(`${kind} serializes curated ${Object.keys(batchRequest)[0]}`, async () => {
      const result = await dispatchGoogleOperation({
        operation: { kind, ...target, requests: [batchRequest] },
        accessToken,
        fetcher: async (_url, init) => {
          assert.deepEqual(JSON.parse(init.body), { requests: [batchRequest] });
          return Response.json({ replies: [{}] });
        },
      });
      assert.deepEqual(result, { replies: [{}] });
    });

test('credential validation rejects header injection before HTTP', async () => {
  await assert.rejects(
    dispatchGoogleOperation({ operation: read, accessToken: 'secret\r\nX: bad' }),
    code('invalid-credential'),
  );
});

test('a read completes at the exact streamed byte limit', async () => {
  const operation = { kind: 'drive.files.download', fileId: 'f1' };
  const result = await dispatchGoogleOperation({
    operation,
    accessToken,
    fetcher: async () => new Response(new Uint8Array(2_097_152)),
  });
  assert.equal(result.byteLength, 2_097_152);
  assert.equal(Buffer.from(result.contentBase64, 'base64').byteLength, 2_097_152);
});

test('provider timeout covers a stalled body without caller cancellation', { timeout: 20_000 }, async () => {
  let cancelled = false;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      dispatchGoogleOperation({
        operation: write,
        accessToken,
        fetcher: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      }),
      code('outcome-unknown'),
    );
    assert.equal(cancelled, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('native HTTP transport returns data, rejects redirects, and sanitizes a lost write acknowledgement', async t => {
  let mode = 'read';
  let redirected = 0;
  let sends = 0;
  const bodies = [];
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/redirect-target') {
      redirected++;
      outgoing.end('{}');
      return;
    }
    if (mode === 'redirect') {
      outgoing.writeHead(302, { location: '/redirect-target' });
      outgoing.end();
      return;
    }
    if (incoming.method === 'POST') {
      sends++;
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      incoming.socket.destroy();
      return;
    }
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end('{"labels":[{"id":"INBOX","name":"INBOX"}]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const fetcher = (url, init) => {
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, init);
  };
  assert.deepEqual(await dispatchGoogleOperation({ operation: read, accessToken, fetcher }), {
    labels: [{ id: 'INBOX', name: 'INBOX' }],
  });
  mode = 'redirect';
  await assert.rejects(
    dispatchGoogleOperation({ operation: read, accessToken, fetcher }),
    code('provider-unavailable'),
  );
  assert.equal(redirected, 0);
  mode = 'write';
  await assert.rejects(dispatchGoogleOperation({ operation: write, accessToken, fetcher }), code('outcome-unknown'));
  assert.equal(sends, 1);
  assert.deepEqual(bodies, [{ raw }]);
});

test('draft send supplies approved MIME even when the remote draft changes before dispatch', async t => {
  const approved = { kind: 'gmail.drafts.send', draftId: 'd1', message: { ...message, to: [...message.to] } };
  let remoteRaw = raw;
  const requests = [];
  const sent = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ method: incoming.method, url: incoming.url, payload });
    sent.push(payload.message?.raw ?? remoteRaw);
    outgoing.setHeader('content-type', 'application/json');
    outgoing.end('{"id":"sent-approved"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  remoteRaw = Buffer.from('To: changed@example.com\r\nSubject: Changed\r\n\r\nUnapproved content').toString(
    'base64url',
  );
  const result = await dispatchGoogleOperation({
    operation: approved,
    accessToken,
    fetcher: (url, init) => {
      assert.equal(url.origin, 'https://gmail.googleapis.com');
      return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, init);
    },
  });
  assert.deepEqual(result, { id: 'sent-approved' });
  assert.deepEqual(requests, [
    { method: 'POST', url: '/gmail/v1/users/me/drafts/send', payload: { id: 'd1', message: { raw } } },
  ]);
  assert.deepEqual(sent, [raw]);
  assert.notEqual(sent[0], remoteRaw);
});

const docsUpdate = {
  kind: 'docs.documents.batchUpdate',
  documentId: 'doc1',
  requests: [{ insertText: { location: { index: 1 }, text: 'Hello' } }],
  requiredRevisionId: 'rev-observed',
};
const slidesUpdate = {
  kind: 'slides.presentations.batchUpdate',
  presentationId: 'pres1',
  requests: [{ deleteObject: { objectId: 'shape1' } }],
  requiredRevisionId: 'rev-observed',
};
const preconditionFailure = () =>
  Response.json(
    {
      error: {
        code: 400,
        message: 'The required revision ID does not match the latest revision.',
        status: 'FAILED_PRECONDITION',
      },
    },
    { status: 400 },
  );

test('Google-original updates classify by enforceable revision precondition', () => {
  assert.deepEqual(googleWriteTarget(docsUpdate), {
    kind: 'revision',
    service: 'docs',
    id: 'doc1',
    requiredRevisionId: 'rev-observed',
  });
  assert.deepEqual(googleWriteTarget({ ...slidesUpdate, requiredRevisionId: undefined }), {
    kind: 'revision',
    service: 'slides',
    id: 'pres1',
    requiredRevisionId: undefined,
  });
  for (const operation of [
    { kind: 'sheets.values.update', spreadsheetId: 's1', range: 'A1', values: [[1]], valueInputOption: 'RAW' },
    {
      kind: 'sheets.values.batchUpdate',
      spreadsheetId: 's1',
      valueInputOption: 'RAW',
      data: [{ range: 'A1', values: [[1]] }],
    },
    { kind: 'sheets.values.clear', spreadsheetId: 's1', range: 'A1' },
    { kind: 'sheets.spreadsheets.batchUpdate', spreadsheetId: 's1', requests: [{ deleteSheet: { sheetId: 1 } }] },
  ]) {
    assert.deepEqual(
      googleWriteTarget(operation),
      { kind: 'created-spreadsheet', id: 's1', requiredVersion: undefined },
      operation.kind,
    );
    assert.deepEqual(
      googleWriteTarget({ ...operation, requiredVersion: '42' }),
      { kind: 'created-spreadsheet', id: 's1', requiredVersion: '42' },
      operation.kind,
    );
    assert.deepEqual(
      googleAgentOperationSchema.parse(operation),
      operation,
      `${operation.kind} is open to agents without a version`,
    );
    assert.equal(
      googleAgentOperationSchema.safeParse({ ...operation, requiredVersion: '42' }).success,
      false,
      'only TulipFarm binds the version for an agent proposal',
    );
  }
  assert.equal(
    googleOperationSchema.safeParse({
      kind: 'sheets.values.clear',
      spreadsheetId: 's1',
      range: 'A1',
      requiredVersion: 'v42',
    }).success,
    false,
    'a Drive version is a decimal number',
  );
  for (const operation of [
    { kind: 'sheets.values.batchClear', spreadsheetId: 's1', ranges: ['A1'] },
    { kind: 'drive.files.upload', fileId: 'f1', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' },
  ])
    assert.deepEqual(googleWriteTarget(operation), { kind: 'unguarded' }, operation.kind);
  for (const operation of [
    { kind: 'drive.files.upload', mimeType: 'text/plain', contentBase64: 'aGVsbG8=' },
    { kind: 'sheets.values.append', spreadsheetId: 's1', range: 'A1', values: [[1]], valueInputOption: 'RAW' },
    { kind: 'docs.documents.create', title: 'New' },
    { kind: 'drive.files.copy', fileId: 'f1', file: { name: 'Copy' } },
  ])
    assert.deepEqual(googleWriteTarget(operation), { kind: 'unbound' }, operation.kind);
});

test('a Sheets append that would overwrite cells is unguarded, closed to agents, and refused by the provider before any request', async () => {
  const appendRows = {
    kind: 'sheets.values.append',
    spreadsheetId: 's1',
    range: 'A1',
    values: [[1]],
    valueInputOption: 'RAW',
  };
  const overwrite = { ...appendRows, insertDataOption: 'OVERWRITE' };
  assert.deepEqual(googleWriteTarget(googleOperationSchema.parse(overwrite)), { kind: 'unguarded' });
  assert.equal(googleAgentOperationSchema.safeParse(overwrite).success, false);
  assert.equal(googleOperationSchema.safeParse({ ...overwrite, unknown: true }).success, false);
  for (const operation of [appendRows, { ...appendRows, insertDataOption: 'INSERT_ROWS' }]) {
    assert.deepEqual(googleWriteTarget(googleOperationSchema.parse(operation)), { kind: 'unbound' });
    assert.deepEqual(googleAgentOperationSchema.parse(operation), operation);
  }
  let calls = 0;
  await assert.rejects(
    dispatchGoogleOperation({
      operation: googleOperationSchema.parse(overwrite),
      accessToken,
      fetcher: async () => {
        calls++;
        return Response.json({});
      },
    }),
    code('invalid-operation'),
  );
  assert.equal(calls, 0);
});

test('revision-bound writes send writeControl and map a provider revision mismatch to target-stale', async () => {
  for (const operation of [docsUpdate, slidesUpdate]) {
    const bodies = [];
    await assert.rejects(
      dispatchGoogleOperation({
        operation,
        accessToken,
        fetcher: async (url, init) => {
          bodies.push(JSON.parse(init.body));
          return preconditionFailure();
        },
      }),
      code('target-stale'),
    );
    assert.deepEqual(
      bodies.map(body => body.writeControl),
      [{ requiredRevisionId: 'rev-observed' }],
    );
  }
  await assert.rejects(
    dispatchGoogleOperation({
      operation: docsUpdate,
      accessToken,
      fetcher: async () =>
        Response.json(
          {
            error: {
              code: 400,
              message: 'Invalid requests[0].insertText: Index 9 must be less than the end index.',
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        ),
    }),
    code('provider-rejected'),
  );
  await assert.rejects(
    dispatchGoogleOperation({
      operation: { ...docsUpdate, requiredRevisionId: undefined },
      accessToken,
      fetcher: async () => preconditionFailure(),
    }),
    code('provider-rejected'),
  );
  await assert.rejects(
    dispatchGoogleOperation({
      operation: docsUpdate,
      accessToken,
      fetcher: async () => new Response('not json', { status: 400 }),
    }),
    code('provider-rejected'),
  );
});

test('target revision reads request only the revision field', async () => {
  for (const [target, path] of [
    [googleWriteTarget(docsUpdate), '/v1/documents/doc1'],
    [googleWriteTarget(slidesUpdate), '/v1/presentations/pres1'],
  ]) {
    const revision = await readGoogleRevision({
      target,
      accessToken,
      fetcher: async (url, init) => {
        assert.equal(url.pathname, path);
        assert.equal(init.method, 'GET');
        assert.equal(url.searchParams.get('fields'), 'revisionId');
        return Response.json({ revisionId: 'rev-current' });
      },
    });
    assert.equal(revision, 'rev-current');
  }
  const sheet = googleWriteTarget({ kind: 'sheets.values.clear', spreadsheetId: 's1/x', range: 'A1' });
  const bodies = [];
  assert.equal(
    await readGoogleRevision({
      target: sheet,
      accessToken,
      fetcher: async (url, init) => {
        assert.equal(url.href, 'https://www.googleapis.com/drive/v3/files/s1%2Fx?fields=version');
        assert.equal(init.method, 'GET');
        bodies.push(init.body);
        return Response.json({ version: '1207' });
      },
    }),
    '1207',
    'a spreadsheet reads the Drive version, the only change counter Google exposes for Sheets',
  );
  assert.deepEqual(bodies, [undefined]);
  await assert.rejects(
    readGoogleRevision({ target: sheet, accessToken, fetcher: async () => Response.json({ version: 1207 }) }),
    code('invalid-response'),
  );
  for (const operation of [
    {
      kind: 'sheets.values.update',
      spreadsheetId: 's1',
      range: 'A1',
      values: [[1]],
      valueInputOption: 'RAW',
      requiredVersion: '7',
    },
    {
      kind: 'sheets.values.batchUpdate',
      spreadsheetId: 's1',
      valueInputOption: 'RAW',
      data: [{ range: 'A1', values: [[1]] }],
      requiredVersion: '7',
    },
    { kind: 'sheets.values.clear', spreadsheetId: 's1', range: 'A1', requiredVersion: '7' },
    {
      kind: 'sheets.spreadsheets.batchUpdate',
      spreadsheetId: 's1',
      requests: [{ deleteSheet: { sheetId: 1 } }],
      requiredVersion: '7',
    },
  ]) {
    let sent;
    await dispatchGoogleOperation({
      operation,
      accessToken,
      fetcher: async (url, init) => {
        sent = `${url.search} ${init.body}`;
        return Response.json({});
      },
    });
    assert.doesNotMatch(
      sent,
      /requiredVersion|"7"/,
      `${operation.kind} keeps the reviewed version out of the Sheets request`,
    );
  }
  await assert.rejects(
    readGoogleRevision({ target: googleWriteTarget(docsUpdate), accessToken, fetcher: async () => Response.json({}) }),
    code('invalid-response'),
  );
  await assert.rejects(
    readGoogleRevision({
      target: googleWriteTarget(docsUpdate),
      accessToken,
      fetcher: async () => new Response(null, { status: 401 }),
    }),
    code('reconnect-required'),
  );
});
