import { randomUUID } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import {
  GoogleOperationError,
  googleOperationSchema,
  isGoogleWrite,
  type GoogleOperation,
  type GoogleWriteTarget,
} from './operation-contracts.ts';
import { selectDocument, selectSlidePage, type Json } from './document-reads.ts';

type Query = Record<string, string | number | boolean | string[] | undefined>;
type Request = {
  url: URL;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: string | Uint8Array<ArrayBuffer>;
  contentType?: string;
  binary?: boolean;
  revisionBound?: boolean;
};
const origins = {
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  sheets: 'https://sheets.googleapis.com/v4/spreadsheets',
  docs: 'https://docs.googleapis.com/v1/documents',
  slides: 'https://slides.googleapis.com/v1/presentations',
};
const responseLimit = 2_097_152;
const requestLimit = 2_097_152;
const fileFields = 'id,name,mimeType,description,parents,trashed,starred,size,modifiedTime,webViewLink';
const permissionFields = 'id,type,role,emailAddress,domain,allowFileDiscovery';
// A full presentation repeats every master and layout with complete styling, which alone outgrows a model tool result.
const slideText = 'text(textElements(startIndex,endIndex,textRun/content))';
const slideElementFields = `objectId,size,transform,title,description,shape(shapeType,placeholder(type,parentObjectId),${slideText}),table(rows,columns,tableRows(tableCells(location,${slideText}))),elementGroup(children(objectId)),line(lineType),wordArt(renderedText)`;
const slidesOutlineFields = 'presentationId,title,locale,revisionId,pageSize,slides(objectId)';
const slidesContentFields = `presentationId,title,locale,revisionId,pageSize,slides(objectId,slideProperties(layoutObjectId),pageElements(${slideElementFields}))`;
const slidesPageFields = `objectId,pageType,revisionId,slideProperties(layoutObjectId),pageElements(${slideElementFields})`;
const path = encodeURIComponent;

function request(
  service: keyof typeof origins,
  suffix: string,
  method: Request['method'] = 'GET',
  body?: unknown,
  query: Query = {},
): Request {
  const url = new URL(`${origins[service]}${suffix}`);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return body === undefined
    ? { url, method }
    : { url, method, body: JSON.stringify(body), contentType: 'application/json' };
}

function mime(message: Extract<GoogleOperation, { kind: 'gmail.messages.send' }>['message']) {
  const words: string[] = [];
  let word = '';
  for (const character of message.subject) {
    if (Buffer.byteLength(word + character) > 42) {
      words.push(word);
      word = '';
    }
    word += character;
  }
  if (word) words.push(word);
  const headers = [`To: ${message.to.join(',\r\n ')}`];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.join(',\r\n ')}`);
  if (message.bcc?.length) headers.push(`Bcc: ${message.bcc.join(',\r\n ')}`);
  headers.push(`Subject: ${words.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ')}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`, `References: ${message.inReplyTo}`);
  headers.push(
    'MIME-Version: 1.0',
    `Content-Type: ${message.contentType ?? 'text/plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
  );
  const body =
    Buffer.from(message.body)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  return {
    raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`).toString('base64url'),
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}

function serialize(op: GoogleOperation): Request {
  switch (op.kind) {
    case 'gmail.messages.list':
      return request('gmail', '/messages', 'GET', undefined, {
        q: op.q,
        labelIds: op.labelIds,
        pageToken: op.pageToken,
        maxResults: op.maxResults ?? 50,
        includeSpamTrash: op.includeSpamTrash,
      });
    case 'gmail.messages.get':
      return request('gmail', `/messages/${path(op.messageId)}`, 'GET', undefined, { format: op.format ?? 'full' });
    case 'gmail.messages.modify':
      return request('gmail', `/messages/${path(op.messageId)}/modify`, 'POST', {
        addLabelIds: op.addLabelIds ?? [],
        removeLabelIds: op.removeLabelIds ?? [],
      });
    case 'gmail.messages.trash':
      return request('gmail', `/messages/${path(op.messageId)}/trash`, 'POST', {});
    case 'gmail.messages.untrash':
      return request('gmail', `/messages/${path(op.messageId)}/untrash`, 'POST', {});
    case 'gmail.messages.send':
      return request('gmail', '/messages/send', 'POST', mime(op.message));
    case 'gmail.drafts.list':
      return request('gmail', '/drafts', 'GET', undefined, {
        q: op.q,
        pageToken: op.pageToken,
        maxResults: op.maxResults ?? 50,
      });
    case 'gmail.drafts.get':
      return request('gmail', `/drafts/${path(op.draftId)}`, 'GET', undefined, { format: op.format ?? 'full' });
    case 'gmail.drafts.create':
      return request('gmail', '/drafts', 'POST', { message: mime(op.message) });
    case 'gmail.drafts.update':
      return request('gmail', `/drafts/${path(op.draftId)}`, 'PUT', { message: mime(op.message) });
    case 'gmail.drafts.delete':
      return request('gmail', `/drafts/${path(op.draftId)}`, 'DELETE');
    case 'gmail.drafts.send':
      return request('gmail', '/drafts/send', 'POST', { id: op.draftId, message: mime(op.message) });
    case 'gmail.labels.list':
      return request('gmail', '/labels');
    case 'gmail.labels.get':
      return request('gmail', `/labels/${path(op.labelId)}`);
    case 'gmail.labels.create':
      return request('gmail', '/labels', 'POST', op.label);
    case 'gmail.labels.update':
      return request('gmail', `/labels/${path(op.labelId)}`, 'PATCH', op.label);
    case 'gmail.labels.delete':
      return request('gmail', `/labels/${path(op.labelId)}`, 'DELETE');
    case 'calendar.calendars.list':
      return request('calendar', '/users/me/calendarList', 'GET', undefined, {
        pageToken: op.pageToken,
        maxResults: op.maxResults ?? 50,
      });
    case 'calendar.calendars.get':
      return request('calendar', `/calendars/${path(op.calendarId)}`);
    case 'calendar.calendars.create':
      return request('calendar', '/calendars', 'POST', op.calendar);
    case 'calendar.calendars.update':
      return request('calendar', `/calendars/${path(op.calendarId)}`, 'PATCH', op.calendar);
    case 'calendar.calendars.delete':
      return request('calendar', `/calendars/${path(op.calendarId)}`, 'DELETE');
    case 'calendar.events.list':
      return request('calendar', `/calendars/${path(op.calendarId)}/events`, 'GET', undefined, {
        q: op.q,
        timeMin: op.timeMin,
        timeMax: op.timeMax,
        singleEvents: op.singleEvents,
        orderBy: op.orderBy,
        pageToken: op.pageToken,
        maxResults: op.maxResults ?? 50,
      });
    case 'calendar.events.get':
      return request('calendar', `/calendars/${path(op.calendarId)}/events/${path(op.eventId)}`);
    case 'calendar.events.create':
      return request('calendar', `/calendars/${path(op.calendarId)}/events`, 'POST', op.event, {
        sendUpdates: op.sendUpdates ?? 'none',
        conferenceDataVersion: op.event.conferenceData ? 1 : undefined,
      });
    case 'calendar.events.update':
      return request('calendar', `/calendars/${path(op.calendarId)}/events/${path(op.eventId)}`, 'PATCH', op.event, {
        sendUpdates: op.sendUpdates ?? 'none',
        conferenceDataVersion: op.event.conferenceData ? 1 : undefined,
      });
    case 'calendar.events.delete':
      return request('calendar', `/calendars/${path(op.calendarId)}/events/${path(op.eventId)}`, 'DELETE', undefined, {
        sendUpdates: op.sendUpdates ?? 'none',
      });
    case 'drive.files.list':
      return request('drive', '/files', 'GET', undefined, {
        q: op.q,
        pageToken: op.pageToken,
        pageSize: op.pageSize ?? 50,
        orderBy: op.orderBy,
        fields: `nextPageToken,files(${fileFields})`,
      });
    case 'drive.files.get':
      return request('drive', `/files/${path(op.fileId)}`, 'GET', undefined, { fields: fileFields });
    case 'drive.files.create':
      return request('drive', '/files', 'POST', op.file, { fields: fileFields });
    case 'drive.files.update':
      return request('drive', `/files/${path(op.fileId)}`, 'PATCH', op.file, {
        fields: fileFields,
        addParents: op.addParents?.join(','),
        removeParents: op.removeParents?.join(','),
      });
    case 'drive.files.copy':
      return request('drive', `/files/${path(op.fileId)}/copy`, 'POST', op.file, { fields: fileFields });
    case 'drive.files.trash':
      return request('drive', `/files/${path(op.fileId)}`, 'PATCH', { trashed: true }, { fields: fileFields });
    case 'drive.files.upload': {
      const target = request(
        'upload',
        `/files${op.fileId ? `/${path(op.fileId)}` : ''}`,
        op.fileId ? 'PATCH' : 'POST',
        undefined,
        { uploadType: op.file ? 'multipart' : 'media', fields: fileFields },
      );
      if (!op.file) return { ...target, body: Buffer.from(op.contentBase64, 'base64'), contentType: op.mimeType };
      // Metadata names the file and, with a Google mimeType, asks Drive to convert the uploaded content.
      const boundary = `tulipfarm-${randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(op.file)}\r\n--${boundary}\r\nContent-Type: ${op.mimeType}\r\n\r\n`,
        ),
        Buffer.from(op.contentBase64, 'base64'),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return { ...target, body, contentType: `multipart/related; boundary=${boundary}` };
    }
    case 'drive.files.download':
      return { ...request('drive', `/files/${path(op.fileId)}`, 'GET', undefined, { alt: 'media' }), binary: true };
    case 'drive.files.export':
      return {
        ...request('drive', `/files/${path(op.fileId)}/export`, 'GET', undefined, { mimeType: op.mimeType }),
        binary: true,
      };
    case 'drive.permissions.list':
      return request('drive', `/files/${path(op.fileId)}/permissions`, 'GET', undefined, {
        pageToken: op.pageToken,
        pageSize: op.pageSize ?? 50,
        fields: `nextPageToken,permissions(${permissionFields})`,
      });
    case 'drive.permissions.get':
      return request('drive', `/files/${path(op.fileId)}/permissions/${path(op.permissionId)}`, 'GET', undefined, {
        fields: permissionFields,
      });
    case 'drive.permissions.create':
      return request('drive', `/files/${path(op.fileId)}/permissions`, 'POST', op.permission, {
        sendNotificationEmail: op.sendNotificationEmail ?? false,
        fields: permissionFields,
      });
    case 'drive.permissions.update':
      return request(
        'drive',
        `/files/${path(op.fileId)}/permissions/${path(op.permissionId)}`,
        'PATCH',
        { role: op.role },
        { fields: permissionFields },
      );
    case 'drive.permissions.delete':
      return request('drive', `/files/${path(op.fileId)}/permissions/${path(op.permissionId)}`, 'DELETE');
    case 'sheets.spreadsheets.get':
      return request('sheets', `/${path(op.spreadsheetId)}`, 'GET', undefined, {
        ranges: op.ranges,
        includeGridData: op.includeGridData ?? false,
      });
    case 'sheets.spreadsheets.create':
      return request('sheets', '', 'POST', {
        properties: { title: op.title },
        sheets: op.sheets?.map(properties => ({ properties })),
      });
    case 'sheets.values.get':
      return request('sheets', `/${path(op.spreadsheetId)}/values/${path(op.range)}`, 'GET', undefined, {
        valueRenderOption: op.valueRenderOption,
      });
    case 'sheets.values.update':
      return request(
        'sheets',
        `/${path(op.spreadsheetId)}/values/${path(op.range)}`,
        'PUT',
        { range: op.range, values: op.values },
        { valueInputOption: op.valueInputOption },
      );
    case 'sheets.values.append':
      if (op.insertDataOption === 'OVERWRITE') throw new GoogleOperationError('invalid-operation');
      return request(
        'sheets',
        `/${path(op.spreadsheetId)}/values/${path(op.range)}:append`,
        'POST',
        { range: op.range, values: op.values },
        { valueInputOption: op.valueInputOption, insertDataOption: 'INSERT_ROWS' },
      );
    case 'sheets.values.clear':
      return request('sheets', `/${path(op.spreadsheetId)}/values/${path(op.range)}:clear`, 'POST', {});
    case 'sheets.values.batchGet':
      return request('sheets', `/${path(op.spreadsheetId)}/values:batchGet`, 'GET', undefined, { ranges: op.ranges });
    case 'sheets.values.batchUpdate':
      return request('sheets', `/${path(op.spreadsheetId)}/values:batchUpdate`, 'POST', {
        valueInputOption: op.valueInputOption,
        data: op.data,
      });
    case 'sheets.values.batchClear':
      return request('sheets', `/${path(op.spreadsheetId)}/values:batchClear`, 'POST', { ranges: op.ranges });
    case 'sheets.spreadsheets.batchUpdate':
      return request('sheets', `/${path(op.spreadsheetId)}:batchUpdate`, 'POST', { requests: op.requests });
    case 'docs.documents.create':
      return request('docs', '', 'POST', { title: op.title });
    case 'docs.documents.get':
      return request('docs', `/${path(op.documentId)}`, 'GET', undefined, { includeTabsContent: true });
    case 'docs.documents.batchUpdate':
      return {
        ...request('docs', `/${path(op.documentId)}:batchUpdate`, 'POST', {
          requests: op.requests,
          writeControl: op.requiredRevisionId ? { requiredRevisionId: op.requiredRevisionId } : undefined,
        }),
        revisionBound: op.requiredRevisionId !== undefined,
      };
    case 'slides.presentations.create':
      return request('slides', '', 'POST', { title: op.title });
    case 'slides.presentations.get':
      return request('slides', `/${path(op.presentationId)}`, 'GET', undefined, {
        fields: op.view === 'outline' ? slidesOutlineFields : slidesContentFields,
      });
    case 'slides.presentations.pages.get':
      return request('slides', `/${path(op.presentationId)}/pages/${path(op.pageObjectId)}`, 'GET', undefined, {
        fields: op.detail
          ? 'objectId,pageType,revisionId,slideProperties(layoutObjectId),pageElements'
          : slidesPageFields,
      });
    case 'slides.presentations.batchUpdate':
      return {
        ...request('slides', `/${path(op.presentationId)}:batchUpdate`, 'POST', {
          requests: op.requests,
          writeControl: op.requiredRevisionId ? { requiredRevisionId: op.requiredRevisionId } : undefined,
        }),
        revisionBound: op.requiredRevisionId !== undefined,
      };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

export async function readBounded(response: Response, signal: AbortSignal, limit = responseLimit): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new GoogleOperationError('response-too-large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) return Buffer.concat(chunks, total);
      total += next.value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        throw new GoogleOperationError('response-too-large');
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function containsCredential(bytes: Buffer, accessToken: string): boolean {
  return [
    accessToken,
    encodeURIComponent(accessToken),
    Buffer.from(accessToken).toString('base64'),
    Buffer.from(accessToken).toString('base64url'),
  ].some(value => bytes.includes(Buffer.from(value)));
}

// Docs and Slides answer a requiredRevisionId mismatch with 400; the body names the revision precondition.
async function staleRevision(response: Response, signal: AbortSignal) {
  const body = await readBounded(response, signal, 16_384).catch(() => Buffer.alloc(0));
  let json: unknown = null;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return false;
  }
  const error = z
    .object({ error: z.object({ status: z.string().optional(), message: z.string().optional() }) })
    .safeParse(json);
  return (
    error.success &&
    (error.data.error.status === 'FAILED_PRECONDITION' || /revision/i.test(error.data.error.message ?? ''))
  );
}

async function send(
  outgoing: Request,
  write: boolean,
  accessToken: string,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<Json> {
  const deadline = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let dispatched = false;
  try {
    combined.throwIfAborted();
    dispatched = true;
    const response = await observeFetch(
      'google',
      'request',
      fetcher,
    )(outgoing.url, {
      method: outgoing.method,
      ...(outgoing.body === undefined ? {} : { body: outgoing.body }),
      redirect: 'error',
      signal: combined,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: outgoing.binary ? '*/*' : 'application/json',
        ...(outgoing.contentType ? { 'content-type': outgoing.contentType } : {}),
      },
    });
    if (!response.ok) {
      if (outgoing.revisionBound && response.status === 400 && (await staleRevision(response, combined)))
        throw new GoogleOperationError('target-stale');
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new GoogleOperationError('reconnect-required');
      if (response.status === 403) throw new GoogleOperationError('insufficient-scope');
      if (response.status === 429) throw new GoogleOperationError('rate-limited');
      if (
        write &&
        (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400))
      )
        throw new GoogleOperationError('outcome-unknown');
      throw new GoogleOperationError(response.status >= 500 ? 'provider-unavailable' : 'provider-rejected');
    }
    const body = await readBounded(response, combined);
    if (containsCredential(body, accessToken)) throw new GoogleOperationError('invalid-response');
    if (outgoing.binary) return { contentBase64: body.toString('base64'), byteLength: body.byteLength };
    if (response.status === 204) return { success: true };
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    const result = z.json().safeParse(json);
    if (!result.success || containsCredential(Buffer.from(JSON.stringify(result.data)), accessToken))
      throw new GoogleOperationError('invalid-response');
    return result.data;
  } catch (error) {
    if (
      error instanceof GoogleOperationError &&
      [
        'target-stale',
        'reconnect-required',
        'insufficient-scope',
        'rate-limited',
        'provider-rejected',
        'outcome-unknown',
      ].includes(error.code)
    )
      throw error;
    if (write && dispatched) throw new GoogleOperationError('outcome-unknown');
    if (error instanceof GoogleOperationError) throw error;
    throw new GoogleOperationError(combined.aborted ? 'cancelled' : 'provider-unavailable');
  }
}

export async function dispatchGoogleOperation({
  operation,
  accessToken,
  signal,
  fetcher = fetch,
}: {
  operation: GoogleOperation;
  accessToken: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<Json> {
  const parsed = googleOperationSchema.safeParse(operation);
  if (!parsed.success) throw new GoogleOperationError('invalid-operation');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken) || accessToken.length > 16384)
    throw new GoogleOperationError('invalid-credential');
  if (signal?.aborted) throw new GoogleOperationError('cancelled');
  const outgoing = serialize(parsed.data);
  const bytes = typeof outgoing.body === 'string' ? Buffer.byteLength(outgoing.body) : (outgoing.body?.byteLength ?? 0);
  if (bytes > requestLimit) throw new GoogleOperationError('invalid-operation');
  const result = await send(outgoing, isGoogleWrite(parsed.data), accessToken, signal, fetcher);
  if (parsed.data.kind === 'docs.documents.get' && parsed.data.selection)
    return selectDocument(result, parsed.data.selection);
  if (parsed.data.kind === 'slides.presentations.pages.get' && parsed.data.detail)
    return selectSlidePage(result, parsed.data.detail);
  return result;
}

/**
 * The target's current revision: Docs and Slides `revisionId`, or the Drive `version` of a spreadsheet.
 * Drive's `version` rises with every server-side change, metadata included, so a rename also reads as a newer version.
 */
export async function readGoogleRevision({
  target,
  accessToken,
  signal,
  fetcher = fetch,
}: {
  target: Extract<GoogleWriteTarget, { kind: 'revision' | 'created-spreadsheet' }>;
  accessToken: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<string> {
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken) || accessToken.length > 16384)
    throw new GoogleOperationError('invalid-credential');
  if (target.kind === 'created-spreadsheet') {
    const result = z
      .object({ version: z.string().regex(/^\d{1,19}$/) })
      .safeParse(
        await send(
          request('drive', `/files/${path(target.id)}`, 'GET', undefined, { fields: 'version' }),
          false,
          accessToken,
          signal,
          fetcher,
        ),
      );
    if (!result.success) throw new GoogleOperationError('invalid-response');
    return result.data.version;
  }
  const result = z
    .object({ revisionId: z.string().min(1) })
    .safeParse(
      await send(
        request(target.service, `/${path(target.id)}`, 'GET', undefined, { fields: 'revisionId' }),
        false,
        accessToken,
        signal,
        fetcher,
      ),
    );
  if (!result.success) throw new GoogleOperationError('invalid-response');
  return result.data.revisionId;
}
