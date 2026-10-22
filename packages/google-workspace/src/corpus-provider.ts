import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { z } from 'zod';
import { GoogleWorkspaceError } from './contracts.ts';
import { googleAppScopes } from './public-contracts.ts';
import type { createGoogleWorkspaceService, GoogleExecutionFence } from './service.ts';
import {
  GoogleCorpusError,
  googleCorpusLimits as limits,
  googleCorpusIdSchema as id,
  googleCorpusPageTokenSchema as token,
  googleCorpusSelectionSchema,
  googleCorpusBindingSchema,
  googleCorpusCursorSchema,
  googleCorpusKindSchema,
  type GoogleCorpusSelection,
  type GoogleCorpusBinding,
  type GoogleCorpusCursor,
  type GoogleCorpusKind,
  type GoogleCorpusObservation,
  type GoogleCorpusPage,
  type GoogleCorpusRead,
  type GoogleCorpusDiscovery,
  type GoogleCorpusInspection,
  type GoogleCorpusErrorCode,
} from './corpus-contracts.ts';

const folderMime = 'application/vnd.google-apps.folder';
const driveBase = 'https://www.googleapis.com/drive/v3/';
const gmailBase = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const revision = z.string().regex(/^\d{1,30}$/);
const fileSchema = z.object({
  id,
  name: z.string().max(2048),
  mimeType: z.string().max(256),
  version: revision,
  modifiedTime: z.iso.datetime({ offset: true }),
  trashed: z.boolean(),
  parents: z.array(id).max(100).default([]),
  driveId: id.optional(),
  resourceKey: z.string().max(256).optional(),
  size: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  md5Checksum: z.string().max(64).optional(),
  copyRequiresWriterPermission: z.boolean().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional(), canCopy: z.boolean().optional() }).optional(),
  downloadRestrictions: z
    .object({
      effectiveDownloadRestrictionWithContext: z
        .object({
          restrictedForReaders: z.boolean().optional(),
          restrictedForWriters: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
type File = z.infer<typeof fileSchema>;
const fileFields =
  'id,name,mimeType,version,modifiedTime,trashed,parents,driveId,resourceKey,size,md5Checksum,copyRequiresWriterPermission,capabilities(canDownload,canCopy),downloadRestrictions(effectiveDownloadRestrictionWithContext)';
const filePageSchema = z.object({
  files: z.array(fileSchema).max(limits.pageSize).default([]),
  nextPageToken: token.optional(),
  incompleteSearch: z.boolean().optional(),
});
const namedSchema = z.object({ id, name: z.string().max(2048) });
const formats: Record<string, { extension: string; mediaType: string }> = Object.fromEntries(
  [
    ['text/plain', 'txt'],
    ['text/markdown', 'md'],
    ['text/html', 'html'],
    ['text/csv', 'csv'],
    ['application/json', 'json'],
    ['application/xml', 'xml'],
    ['text/xml', 'xml'],
    ['application/pdf', 'pdf'],
    ['application/msword', 'doc'],
    ['application/rtf', 'rtf'],
    ['text/rtf', 'rtf'],
    ['application/epub+zip', 'epub'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.ms-powerpoint', 'ppt'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ['application/vnd.oasis.opendocument.text', 'odt'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
    ['application/vnd.oasis.opendocument.presentation', 'odp'],
  ].map(([mediaType, extension]) => [mediaType, { mediaType, extension }]),
);
const nativeFormats: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const headerSchema = z.object({ name: z.string().max(1024), value: z.string().max(65536) });
const partSchema = z.object({
  mimeType: z.string().max(256),
  filename: z.string().max(2048).default(''),
  headers: z.array(headerSchema).max(1000).default([]),
  body: z.object({
    size: z.number().int().nonnegative(),
    data: z.string().optional(),
    attachmentId: z.string().optional(),
  }),
  parts: z.array(z.unknown()).max(limits.mimeParts).optional(),
});
const messageSchema = z.object({
  id,
  threadId: id,
  labelIds: z.array(id).max(1000).default([]),
  historyId: revision,
  internalDate: z.string().regex(/^\d{1,16}$/),
  payload: partSchema,
});
type Message = z.infer<typeof messageSchema>;
const errorSchema = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }) });

function parse<T>(schema: z.ZodType<T>, value: unknown, code: GoogleCorpusErrorCode = 'invalid-response'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GoogleCorpusError(code);
  return result.data;
}
function coverage(file: File): GoogleCorpusObservation['coverage'] {
  if (file.resourceKey) return 'resource-key-required';
  if (file.trashed) return 'restricted';
  if (file.mimeType === folderMime) return 'folder';
  const restriction = file.downloadRestrictions?.effectiveDownloadRestrictionWithContext;
  if (
    file.capabilities?.canDownload !== true ||
    file.capabilities.canCopy === false ||
    file.copyRequiresWriterPermission === true ||
    restriction?.restrictedForReaders ||
    restriction?.restrictedForWriters
  )
    return 'restricted';
  return formats[nativeFormats[file.mimeType] ?? file.mimeType] ? 'supported' : 'unsupported';
}
function requireFile(file: File, content = false) {
  const state = coverage(file);
  if (file.trashed) throw new GoogleCorpusError('not-found');
  if (state === 'resource-key-required' || state === 'restricted' || (content && state === 'unsupported'))
    throw new GoogleCorpusError(state);
  if (content && state === 'folder') throw new GoogleCorpusError('unsupported');
}
function fileObservation(file: File, accessedAt = new Date().toISOString()): GoogleCorpusObservation {
  return {
    nativeId: file.id,
    title: file.name,
    canonicalURL: `https://drive.google.com/${file.mimeType === folderMime ? 'drive/folders' : 'file/d'}/${file.id}`,
    sourceRevision: file.version,
    accessedAt,
    kind: file.mimeType === folderMime ? 'folder' : 'file',
    mediaType: file.mimeType,
    parentIds: file.parents,
    coverage: coverage(file),
  };
}
function messageObservation(message: Message, accessedAt = new Date().toISOString()): GoogleCorpusObservation {
  return {
    nativeId: message.id,
    title: message.payload.headers.find(header => header.name.toLowerCase() === 'subject')?.value ?? '(no subject)',
    canonicalURL: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    sourceRevision: message.historyId,
    accessedAt,
    kind: 'message',
    mediaType: 'application/json',
    parentIds: [],
    coverage: 'supported',
  };
}
function checkMessageSelection(message: Message, selection: Extract<GoogleCorpusSelection, { kind: 'gmail' }>) {
  const timestamp = Number(message.internalDate);
  if (
    timestamp < Date.parse(selection.after) ||
    timestamp >= Date.parse(selection.before) ||
    (selection.labelId !== null && !message.labelIds.includes(selection.labelId)) ||
    (selection.excludeSpamTrash && (message.labelIds.includes('SPAM') || message.labelIds.includes('TRASH')))
  )
    throw new GoogleCorpusError('outside-selection');
}
function literal(value: string) {
  const runs = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}\n${value}\n${fence}`;
}
function serializeMessage(message: Message): string {
  const content = [literal(message.payload.headers.map(header => `${header.name}: ${header.value}`).join('\n'))];
  const pending: { value: unknown; depth: number }[] = [{ value: message.payload, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (++count > limits.mimeParts || next.depth > limits.mimeDepth) throw new GoogleCorpusError('response-too-large');
    const part = parse(partSchema, next.value);
    if (
      part.filename ||
      part.body.attachmentId ||
      part.headers.some(
        header => header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value),
      )
    )
      throw new GoogleCorpusError('attachments-unsupported');
    if (part.mimeType.startsWith('multipart/')) {
      if (
        !['multipart/mixed', 'multipart/alternative', 'multipart/related'].includes(part.mimeType) ||
        !part.parts?.length ||
        part.body.size ||
        part.body.data
      )
        throw new GoogleCorpusError('mime-unsupported');
      pending.push(...[...part.parts].reverse().map(value => ({ value, depth: next.depth + 1 })));
      continue;
    }
    if (!['text/plain', 'text/html'].includes(part.mimeType) || part.parts?.length)
      throw new GoogleCorpusError('mime-unsupported');
    const encoded = part.body.data ?? '';
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded) || encoded.replace(/=+$/, '').length % 4 === 1)
      throw new GoogleCorpusError('invalid-response');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length !== part.body.size || bytes.toString('base64url') !== encoded.replace(/=+$/, ''))
      throw new GoogleCorpusError('invalid-response');
    const contentType = part.headers.find(header => header.name.toLowerCase() === 'content-type')?.value ?? '';
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
    if (!['utf-8', 'utf8', 'us-ascii'].includes(charset)) throw new GoogleCorpusError('mime-unsupported');
    if (charset === 'us-ascii' && bytes.some(byte => byte > 127)) throw new GoogleCorpusError('mime-unsupported');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new GoogleCorpusError('mime-unsupported');
    }
    content.push(`## ${part.mimeType}\n\n${literal(text)}`);
  }
  const text = content.join('\n\n').normalize('NFC').replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(text) > limits.responseBytes) throw new GoogleCorpusError('response-too-large');
  return text;
}
function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createGoogleCorpusProvider(options: {
  service: Pick<ReturnType<typeof createGoogleWorkspaceService>, 'status' | 'withCredential'>;
  providerFetch?: typeof fetch;
}) {
  const fetcher = observeFetch('google', 'request', options.providerFetch ?? fetch);
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GoogleCorpusError) throw error;
      if (error instanceof GoogleWorkspaceError) {
        switch (error.code) {
          case 'stale-integration':
          case 'reconnect-required':
          case 'insufficient-scope':
          case 'credential-unavailable':
            throw new GoogleCorpusError(error.code);
          default:
            throw new GoogleCorpusError('credential-unavailable');
        }
      }
      throw new GoogleCorpusError('credential-unavailable');
    }
  }
  async function bind(workspaceId: string, userId: string, kind: GoogleCorpusKind, expected?: GoogleCorpusBinding) {
    const status = await options.service.status(workspaceId, userId);
    if (status.status !== 'connected') throw new GoogleCorpusError('reconnect-required');
    const accepted =
      kind === 'gmail'
        ? ['https://www.googleapis.com/auth/gmail.readonly', googleAppScopes.gmail[0], 'https://mail.google.com/']
        : ['https://www.googleapis.com/auth/drive.readonly', googleAppScopes.drive[0]];
    const scope = accepted.find(value => status.scopes.includes(value));
    if (!scope) throw new GoogleCorpusError('insufficient-scope');
    if (expected) {
      expected = parse(googleCorpusBindingSchema, expected, 'stale-integration');
      if (
        status.integrationId !== expected.integrationId ||
        status.accountId !== expected.accountId ||
        status.generation !== expected.generation
      )
        throw new GoogleCorpusError('stale-integration');
      if (
        !expected.requiredScopes.some(value => accepted.includes(value)) ||
        !expected.requiredScopes.every(value => status.scopes.includes(value))
      )
        throw new GoogleCorpusError('insufficient-scope');
      return expected;
    }
    return parse(googleCorpusBindingSchema, {
      integrationId: status.integrationId,
      accountId: status.accountId,
      generation: status.generation,
      requiredScopes: [scope],
    });
  }
  async function bytes(fence: GoogleExecutionFence, url: URL): Promise<Uint8Array> {
    return options.service.withCredential(fence, async ({ accessToken, signal }) => {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(limits.requestTimeoutMs)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const aborted = () => {
        void reader?.cancel().catch(() => undefined);
      };
      timeout.addEventListener('abort', aborted, { once: true });
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${accessToken}` },
          signal: timeout,
          redirect: 'error',
        });
        reader = response.body?.getReader();
        const maximum = response.ok ? limits.responseBytes : limits.errorBytes;
        if (Number(response.headers.get('content-length')) > maximum) throw new GoogleCorpusError('response-too-large');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          timeout.throwIfAborted();
          const chunk = await reader?.read();
          timeout.throwIfAborted();
          if (!chunk || chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximum) throw new GoogleCorpusError('response-too-large');
          chunks.push(chunk.value);
        }
        const result = Buffer.concat(chunks);
        if (!response.ok) {
          let reasons: string[] = [];
          try {
            const body = errorSchema.safeParse(JSON.parse(result.toString('utf8')));
            if (body.success) reasons = body.data.error.errors?.map(error => error.reason) ?? [];
          } catch {
            /* HTTP status remains authoritative without an error envelope. */
          }
          const retry = response.headers.get('retry-after');
          const delay =
            retry === null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          const retryAfterMs = Number.isFinite(delay)
            ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(delay)))
            : null;
          if (
            response.status === 429 ||
            (response.status === 403 &&
              reasons.some(reason =>
                [
                  'rateLimitExceeded',
                  'userRateLimitExceeded',
                  'dailyLimitExceeded',
                  'quotaExceeded',
                  'sharingRateLimitExceeded',
                ].includes(reason),
              ))
          )
            throw new GoogleCorpusError('rate-limited', retryAfterMs);
          if (response.status === 401) throw new GoogleCorpusError('unauthenticated');
          if (response.status === 403)
            throw new GoogleCorpusError(
              reasons.some(reason => ['exportSizeLimitExceeded', 'fileNotExportable'].includes(reason))
                ? 'unsupported'
                : 'forbidden',
            );
          if (response.status === 404) throw new GoogleCorpusError('not-found');
          if (response.status >= 500) throw new GoogleCorpusError('transient', retryAfterMs);
          if ((response.status === 400 || response.status === 410) && url.searchParams.has('pageToken'))
            throw new GoogleCorpusError('invalid-cursor');
          throw new GoogleCorpusError('invalid-response');
        }
        if (response.status !== 200 || response.headers.has('content-range'))
          throw new GoogleCorpusError('invalid-response');
        return result;
      } catch (error) {
        if (error instanceof GoogleCorpusError) throw error;
        throw new GoogleCorpusError('transient');
      } finally {
        timeout.removeEventListener('abort', aborted);
        await reader?.cancel().catch(() => undefined);
      }
    });
  }
  function url(base: string, path: string, query: Record<string, string> = {}) {
    const value = new URL(path, base);
    value.search = new URLSearchParams(query).toString();
    return value;
  }
  async function json<T>(fence: GoogleExecutionFence, endpoint: URL, schema: z.ZodType<T>): Promise<T> {
    const data = await bytes(fence, endpoint);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      throw new GoogleCorpusError('invalid-response');
    }
    return parse(schema, value);
  }
  async function file(fence: GoogleExecutionFence, nativeId: string) {
    const result = await json(
      fence,
      url(driveBase, `files/${parse(id, nativeId, 'invalid-selection')}`, {
        fields: fileFields,
        supportsAllDrives: 'true',
      }),
      fileSchema,
    );
    if (result.id !== nativeId) throw new GoogleCorpusError('invalid-response');
    return result;
  }
  async function membership(
    fence: GoogleExecutionFence,
    selection: Exclude<GoogleCorpusSelection, { kind: 'gmail' }>,
    item: File,
  ) {
    if (selection.kind === 'drive-all') return;
    if (selection.kind === 'shared-drive') {
      if (item.driveId !== selection.driveId && item.id !== selection.driveId)
        throw new GoogleCorpusError('outside-selection');
      return;
    }
    let current = item;
    const seen = new Set<string>();
    for (let depth = 0; depth < limits.ancestorDepth; depth++) {
      requireFile(current);
      if (current.id === selection.folderId) {
        if (current.mimeType !== folderMime) throw new GoogleCorpusError('outside-selection');
        return;
      }
      if (seen.has(current.id) || current.parents.length !== 1) throw new GoogleCorpusError('outside-selection');
      seen.add(current.id);
      const parent = current.parents[0];
      if (!parent) throw new GoogleCorpusError('outside-selection');
      current = await file(fence, parent);
      if (current.mimeType !== folderMime) throw new GoogleCorpusError('outside-selection');
    }
    throw new GoogleCorpusError('ancestry-limit');
  }
  async function selectedFile(
    fence: GoogleExecutionFence,
    selection: Exclude<GoogleCorpusSelection, { kind: 'gmail' }>,
    nativeId: string,
    content: boolean,
  ) {
    const accessedAt = new Date().toISOString();
    const item = await file(fence, nativeId);
    requireFile(item, content);
    await membership(fence, selection, item);
    return { item, accessedAt };
  }
  async function message(
    fence: GoogleExecutionFence,
    selection: Extract<GoogleCorpusSelection, { kind: 'gmail' }>,
    nativeId: string,
  ) {
    const result = await json(
      fence,
      url(gmailBase, `messages/${parse(id, nativeId, 'invalid-selection')}`, { format: 'full' }),
      messageSchema,
    );
    if (result.id !== nativeId) throw new GoogleCorpusError('invalid-response');
    checkMessageSelection(result, selection);
    return result;
  }
  async function context(
    workspaceId: string,
    userId: string,
    binding: GoogleCorpusBinding,
    input: GoogleCorpusSelection,
  ) {
    const selection = parse(googleCorpusSelectionSchema, input, 'invalid-selection');
    const current = await bind(workspaceId, userId, selection.kind, binding);
    return { selection, fence: { workspaceId, actor: userId, ...current } };
  }
  return {
    discover(
      workspaceId: string,
      userId: string,
      kind: GoogleCorpusKind,
      cursor?: string | null,
    ): Promise<GoogleCorpusDiscovery> {
      return safe(async () => {
        kind = parse(googleCorpusKindSchema, kind, 'invalid-selection');
        if (cursor !== undefined && cursor !== null) cursor = parse(token, cursor, 'invalid-cursor');
        const binding = await bind(workspaceId, userId, kind);
        const fence = { workspaceId, actor: userId, ...binding };
        if (kind === 'drive-all') throw new GoogleCorpusError('invalid-selection');
        if (kind === 'gmail') {
          if (cursor) throw new GoogleCorpusError('invalid-cursor');
          const result = await json(
            fence,
            url(gmailBase, 'labels'),
            z.object({ labels: z.array(namedSchema).max(10000).default([]) }),
          );
          return {
            binding,
            items: result.labels.map(label => ({ nativeId: label.id, title: label.name, kind })),
            nextCursor: null,
          };
        }
        const query: Record<string, string> = { pageSize: String(limits.pageSize) };
        if (cursor) query.pageToken = cursor;
        if (kind === 'shared-drive') {
          query.fields = 'nextPageToken,drives(id,name)';
          const result = await json(
            fence,
            url(driveBase, 'drives', query),
            z.object({
              drives: z.array(namedSchema).max(limits.pageSize).default([]),
              nextPageToken: token.optional(),
            }),
          );
          return {
            binding,
            items: result.drives.map(drive => ({ nativeId: drive.id, title: drive.name, kind })),
            nextCursor: result.nextPageToken ?? null,
          };
        }
        Object.assign(query, {
          q: `trashed = false and mimeType = '${folderMime}'`,
          corpora: 'user',
          spaces: 'drive',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
        });
        const result = await json(fence, url(driveBase, 'files', query), filePageSchema);
        if (result.incompleteSearch) throw new GoogleCorpusError('incomplete-search');
        for (const item of result.files) {
          requireFile(item);
          if (item.mimeType !== folderMime) throw new GoogleCorpusError('invalid-response');
        }
        const items = result.files.map(item => ({ nativeId: item.id, title: item.name, kind }));
        if (!cursor) {
          // 'root' is an alias; selections store the real My Drive id so ancestry checks compare real parent ids.
          const myDrive = await json(fence, url(driveBase, 'files/root', { fields: fileFields }), fileSchema);
          if (myDrive.mimeType !== folderMime) throw new GoogleCorpusError('invalid-response');
          items.unshift({ nativeId: myDrive.id, title: 'My Drive (all files)', kind });
        }
        return { binding, items, nextCursor: result.nextPageToken ?? null };
      });
    },
    inspectSelection(
      workspaceId: string,
      userId: string,
      input: GoogleCorpusSelection,
    ): Promise<GoogleCorpusInspection> {
      return safe(async () => {
        const selection = parse(googleCorpusSelectionSchema, input, 'invalid-selection');
        const binding = await bind(workspaceId, userId, selection.kind);
        const fence = { workspaceId, actor: userId, ...binding };
        if (selection.kind === 'gmail') {
          if (selection.labelId === null) {
            await json(fence, url(gmailBase, 'profile'), z.object({ historyId: revision }));
            return { binding, selection, title: 'Mailbox' };
          }
          const label = await json(fence, url(gmailBase, `labels/${selection.labelId}`), namedSchema);
          if (label.id !== selection.labelId) throw new GoogleCorpusError('invalid-response');
          return { binding, selection, title: label.name };
        }
        if (selection.kind === 'shared-drive') {
          const drive = await json(
            fence,
            url(driveBase, `drives/${selection.driveId}`, { fields: 'id,name' }),
            namedSchema,
          );
          if (drive.id !== selection.driveId) throw new GoogleCorpusError('invalid-response');
          return { binding, selection, title: drive.name };
        }
        if (selection.kind === 'drive-all') {
          await json(fence, url(driveBase, 'files/root', { fields: fileFields }), fileSchema);
          return { binding, selection, title: 'Drive' };
        }
        const root = await selectedFile(fence, selection, selection.folderId, false);
        return { binding, selection, title: root.item.name };
      });
    },
    list(
      workspaceId: string,
      userId: string,
      binding: GoogleCorpusBinding,
      input: GoogleCorpusSelection,
      cursor: GoogleCorpusCursor | null = null,
    ): Promise<GoogleCorpusPage> {
      return safe(async () => {
        const { selection, fence } = await context(workspaceId, userId, binding, input);
        if (cursor !== null) cursor = parse(googleCorpusCursorSchema, cursor, 'invalid-cursor');
        const query: Record<string, string> = {};
        if (cursor?.pageToken) query.pageToken = cursor.pageToken;
        if (selection.kind === 'gmail') {
          if (cursor?.folderId) throw new GoogleCorpusError('invalid-cursor');
          Object.assign(query, {
            maxResults: String(limits.pageSize),
            includeSpamTrash: selection.excludeSpamTrash ? 'false' : 'true',
            q: `after:${Date.parse(selection.after) / 1000 - 1} before:${Date.parse(selection.before) / 1000}${selection.excludeSpamTrash ? ' -in:spam -in:trash' : ''}`,
          });
          if (selection.labelId !== null) query.labelIds = selection.labelId;
          const result = await json(
            fence,
            url(gmailBase, 'messages', query),
            z.object({
              messages: z.array(z.object({ id })).max(limits.pageSize).default([]),
              nextPageToken: token.optional(),
            }),
          );
          if (result.nextPageToken && result.nextPageToken === cursor?.pageToken)
            throw new GoogleCorpusError('invalid-cursor');
          const observations: GoogleCorpusObservation[] = [];
          for (const item of result.messages) {
            const accessedAt = new Date().toISOString();
            const full = await message(fence, selection, item.id);
            const observation = messageObservation(full, accessedAt);
            try {
              serializeMessage(full);
            } catch (error) {
              if (
                !(error instanceof GoogleCorpusError) ||
                !['attachments-unsupported', 'mime-unsupported'].includes(error.code)
              )
                throw error;
              observation.coverage =
                error.code === 'attachments-unsupported' ? 'attachments-unsupported' : 'mime-unsupported';
            }
            observations.push(observation);
          }
          return { observations, nextCursor: result.nextPageToken ? { pageToken: result.nextPageToken } : null };
        }
        Object.assign(query, {
          pageSize: String(limits.pageSize),
          spaces: 'drive',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
          q: 'trashed = false',
        });
        let parentId: string | undefined;
        if (selection.kind === 'drive-folder') {
          parentId = cursor?.folderId ?? selection.folderId;
          const { item: parent } = await selectedFile(fence, selection, parentId, false);
          if (parent.mimeType !== folderMime) throw new GoogleCorpusError('outside-selection');
          query.q += ` and '${parentId}' in parents`;
          query.corpora = parent.driveId ? 'drive' : 'user';
          if (parent.driveId) query.driveId = parent.driveId;
        } else if (selection.kind === 'drive-all') {
          if (cursor?.folderId) throw new GoogleCorpusError('invalid-cursor');
          // Flat listing of every readable file; folders carry no content and need no traversal.
          query.corpora = 'allDrives';
          query.q += ` and mimeType != '${folderMime}'`;
        } else {
          if (cursor?.folderId) throw new GoogleCorpusError('invalid-cursor');
          query.corpora = 'drive';
          query.driveId = selection.driveId;
        }
        const accessedAt = new Date().toISOString();
        const result = await json(fence, url(driveBase, 'files', query), filePageSchema);
        if (result.incompleteSearch) throw new GoogleCorpusError('incomplete-search');
        if (result.nextPageToken && result.nextPageToken === cursor?.pageToken)
          throw new GoogleCorpusError('invalid-cursor');
        for (const item of result.files) {
          if (
            item.trashed ||
            (parentId && !item.parents.includes(parentId)) ||
            (selection.kind === 'shared-drive' && item.driveId !== selection.driveId)
          )
            throw new GoogleCorpusError('invalid-response');
        }
        return {
          observations: result.files.map(item => fileObservation(item, accessedAt)),
          nextCursor: result.nextPageToken
            ? { pageToken: result.nextPageToken, ...(parentId ? { folderId: parentId } : {}) }
            : null,
        };
      });
    },
    read(
      workspaceId: string,
      userId: string,
      binding: GoogleCorpusBinding,
      input: GoogleCorpusSelection,
      nativeId: string,
    ): Promise<GoogleCorpusRead> {
      return safe(async () => {
        const { selection, fence } = await context(workspaceId, userId, binding, input);
        if (selection.kind === 'gmail') {
          const beforeAt = new Date().toISOString();
          const before = await message(fence, selection, nativeId);
          const metadataBefore = messageObservation(before, beforeAt);
          const normalizedContent = serializeMessage(before);
          const original = Buffer.from(JSON.stringify(before));
          const afterAt = new Date().toISOString();
          const after = await message(fence, selection, nativeId);
          if (fingerprint(before) !== fingerprint(after)) throw new GoogleCorpusError('source-changed');
          const metadataAfter = messageObservation(after, afterAt);
          return {
            ...metadataAfter,
            bytes: original,
            filename: `${nativeId}.json`,
            normalizedContent,
            metadataBefore,
            metadataAfter,
          };
        }
        const { item: before, accessedAt: beforeAt } = await selectedFile(fence, selection, nativeId, true);
        const metadataBefore = fileObservation(before, beforeAt);
        const format = formats[nativeFormats[before.mimeType] ?? before.mimeType];
        if (!format) throw new GoogleCorpusError('unsupported');
        if (before.size && BigInt(before.size) > BigInt(limits.responseBytes))
          throw new GoogleCorpusError('response-too-large');
        const exported = nativeFormats[before.mimeType] !== undefined;
        if (!exported && before.size === undefined) throw new GoogleCorpusError('invalid-response');
        const original = await bytes(
          fence,
          url(
            driveBase,
            `files/${nativeId}${exported ? '/export' : ''}`,
            exported ? { mimeType: format.mediaType } : { alt: 'media', supportsAllDrives: 'true' },
          ),
        );
        if (!exported && before.size !== undefined && BigInt(original.byteLength) !== BigInt(before.size))
          throw new GoogleCorpusError('source-changed');
        if (!exported && before.md5Checksum && createHash('md5').update(original).digest('hex') !== before.md5Checksum)
          throw new GoogleCorpusError('source-changed');
        const { item: after, accessedAt: afterAt } = await selectedFile(fence, selection, nativeId, true);
        if (fingerprint(before) !== fingerprint(after)) throw new GoogleCorpusError('source-changed');
        const metadataAfter = fileObservation(after, afterAt);
        const name = [...before.name]
          .map(char =>
            char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '_' : char,
          )
          .join('');
        const filename = name.toLowerCase().endsWith(`.${format.extension}`) ? name : `${name}.${format.extension}`;
        if (filename.length > 2048) throw new GoogleCorpusError('response-too-large');
        return {
          ...metadataAfter,
          mediaType: format.mediaType,
          bytes: original,
          filename,
          normalizedContent: null,
          metadataBefore,
          metadataAfter,
        };
      });
    },
    check(
      workspaceId: string,
      userId: string,
      binding: GoogleCorpusBinding,
      input: GoogleCorpusSelection,
      nativeId: string,
    ): Promise<GoogleCorpusObservation> {
      return safe(async () => {
        const { selection, fence } = await context(workspaceId, userId, binding, input);
        if (selection.kind === 'gmail') {
          const accessedAt = new Date().toISOString();
          const full = await message(fence, selection, nativeId);
          serializeMessage(full);
          return messageObservation(full, accessedAt);
        }
        const result = await selectedFile(fence, selection, nativeId, true);
        return fileObservation(result.item, result.accessedAt);
      });
    },
  };
}
export type GoogleCorpusProvider = ReturnType<typeof createGoogleCorpusProvider>;
