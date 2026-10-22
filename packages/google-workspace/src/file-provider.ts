import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { GoogleOperationError } from './operation-contracts.ts';
import { containsCredential, readBounded } from './operation-provider.ts';
import {
  GoogleFileError,
  googleExportFormats,
  googleFileByteLimit,
  googleFileMetadataSchema,
  googleSheetRangeSchema,
  type GoogleFileContent,
  type GoogleFileContentRequest,
  type GoogleFileText,
  type googleFileListRequestSchema,
} from './file-contracts.ts';

const fields =
  'id,name,mimeType,parents,size,modifiedTime,version,trashed,shared,owners(displayName,emailAddress,me),capabilities(canDownload,canCopy),webViewLink';
const drive = 'https://www.googleapis.com/drive/v3/files';
const errorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});
// One malformed entry must not hide the rest of a page. The page envelope stays strict.
const providerPageSchema = z.object({
  files: z.array(z.unknown()).max(100),
  nextPageToken: z.string().max(2048).optional(),
  incompleteSearch: z.boolean().default(false),
});
const quote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
type Credential = { accessToken: string; signal: AbortSignal; fetcher?: typeof fetch };

async function request(url: URL, credential: Credential, binary = false) {
  const { accessToken, signal } = credential;
  const fetcher = observeFetch('google', 'download', credential.fetcher ?? fetch);
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(accessToken) || accessToken.length > 16384)
    throw new GoogleOperationError('invalid-credential');
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, {
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${accessToken}`, accept: binary ? '*/*' : 'application/json' },
    });
    if (!response.ok) {
      const body = await readBounded(response, signal, 65536);
      let reasons: string[] = [];
      try {
        const parsed = errorSchema.safeParse(JSON.parse(body.toString('utf8')));
        if (parsed.success)
          reasons = [...(parsed.data.error.errors ?? []), ...(parsed.data.error.details ?? [])].flatMap(item =>
            item.reason ? [item.reason] : [],
          );
      } catch {
        /* Google can return a non-JSON error body. */
      }
      if (response.status === 401) throw new GoogleOperationError('reconnect-required');
      if (
        response.status === 429 ||
        reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason))
      )
        throw new GoogleOperationError('rate-limited');
      if (response.status >= 500 || response.status === 408) throw new GoogleOperationError('provider-unavailable');
      if (reasons.some(reason => ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason)))
        throw new GoogleOperationError('insufficient-scope');
      if (response.status === 404) throw new GoogleFileError('source-not-found');
      if (reasons.includes('cannotDownloadFile')) throw new GoogleFileError('export-rejected', 'download-restricted');
      if (reasons.includes('fileNotExportable')) throw new GoogleFileError('export-rejected', 'not-exportable');
      if (reasons.includes('exportSizeLimitExceeded')) throw new GoogleFileError('export-rejected');
      if (response.status === 403) throw new GoogleFileError('source-access-denied');
      throw new GoogleOperationError('provider-rejected');
    }
    const body = await readBounded(response, signal, binary ? googleFileByteLimit : 2_097_152);
    if (containsCredential(body, accessToken)) throw new GoogleOperationError('invalid-response');
    return body;
  } catch (error) {
    if (signal.aborted)
      throw signal.reason?.name === 'TimeoutError'
        ? new GoogleFileError('transfer-timeout')
        : new GoogleOperationError('cancelled');
    if (error instanceof GoogleOperationError || error instanceof GoogleFileError) throw error;
    throw new GoogleOperationError('provider-unavailable');
  }
}
async function json<T>(url: URL, credential: Credential, schema: z.ZodType<T>): Promise<T> {
  const bytes = await request(url, credential);
  try {
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (containsCredential(Buffer.from(JSON.stringify(data)), credential.accessToken)) throw new Error('credential');
    return schema.parse(data);
  } catch {
    throw new GoogleOperationError('invalid-response');
  }
}
export async function listGoogleFiles(input: z.infer<typeof googleFileListRequestSchema>, credential: Credential) {
  const q = ['trashed = false'];
  if (input.parentId) q.push(`${quote(input.parentId)} in parents`);
  if (input.sharedWithMe) q.push('sharedWithMe = true');
  if (input.name) q.push(`name contains ${quote(input.name)}`);
  const url = new URL(drive);
  url.search = new URLSearchParams({
    q: q.join(' and '),
    spaces: 'drive',
    corpora: 'user',
    pageSize: String(input.pageSize),
    orderBy: input.orderBy,
    fields: `nextPageToken,incompleteSearch,files(${fields})`,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
  }).toString();
  const page = await json(url, credential, providerPageSchema);
  const files = page.files.flatMap(item => {
    const parsed = googleFileMetadataSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return { ...page, files, skipped: page.files.length - files.length };
}
export function getGoogleFile(fileId: string, credential: Credential) {
  const url = new URL(`${drive}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', fields);
  return json(url, credential, googleFileMetadataSchema);
}
function column(index: number): string {
  let name = '';
  while (index > 0) {
    index--;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}
export async function readGoogleFile(
  input: GoogleFileContentRequest,
  credential: Credential,
): Promise<GoogleFileContent> {
  if (input.kind === 'sheet-range') {
    const range = `'${input.sheetName.replaceAll("'", "''")}'!${column(input.startColumn)}${input.startRow}:${column(input.startColumn + input.columnCount - 1)}${input.startRow + input.rowCount - 1}`;
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.fileId)}/values/${encodeURIComponent(range)}`,
    );
    url.search = 'valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
    return { kind: 'sheet-range', data: await json(url, credential, googleSheetRangeSchema) };
  }
  const metadata = await getGoogleFile(input.fileId, credential);
  if (metadata.trashed) throw new GoogleFileError('source-not-found');
  if (metadata.capabilities?.canDownload === false)
    throw new GoogleFileError('source-access-denied', 'download-restricted');
  if (input.kind === 'download') {
    if (metadata.mimeType.startsWith('application/vnd.google-apps.'))
      throw new GoogleFileError('unsupported-representation');
    const url = new URL(`${drive}/${encodeURIComponent(input.fileId)}`);
    url.search = 'alt=media';
    const bytes = await request(url, credential, true);
    return {
      kind: 'binary',
      bytes,
      byteLength: bytes.byteLength,
      mimeType: metadata.mimeType,
      ...(metadata.version ? { version: metadata.version } : {}),
    };
  }
  // The viewer's `pdf` representation predates sheet exports and stays limited to Docs and Slides.
  const target = googleExportFormats[input.kind === 'pdf' ? 'pdf' : input.format];
  const sources: readonly string[] =
    input.kind === 'pdf'
      ? ['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation']
      : target.sources;
  if (!sources.includes(metadata.mimeType)) throw new GoogleFileError('unsupported-representation');
  const url = new URL(`${drive}/${encodeURIComponent(input.fileId)}/export`);
  url.searchParams.set('mimeType', target.mimeType);
  const bytes = await request(url, credential, true);
  return {
    kind: 'binary',
    bytes,
    byteLength: bytes.byteLength,
    mimeType: target.mimeType,
    ...(metadata.version ? { version: metadata.version } : {}),
  };
}
const textExports: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
/** Reads a file for a text reader: native Docs, Slides, and Sheets through Google's text exports, other files as stored. */
export async function readGoogleFileText(fileId: string, credential: Credential): Promise<GoogleFileText> {
  const found = await getGoogleFile(fileId, credential);
  if (found.trashed) throw new GoogleFileError('source-not-found');
  if (found.capabilities?.canDownload === false)
    throw new GoogleFileError('source-access-denied', 'download-restricted');
  const metadata = {
    id: found.id,
    name: found.name,
    mimeType: found.mimeType,
    ...(found.version ? { version: found.version } : {}),
    ...(found.modifiedTime ? { modifiedTime: found.modifiedTime } : {}),
  };
  const exported = textExports[found.mimeType];
  if (!exported && found.mimeType.startsWith('application/vnd.google-apps.'))
    throw new GoogleFileError('unsupported-representation');
  const url = new URL(`${drive}/${encodeURIComponent(fileId)}${exported ? '/export' : ''}`);
  if (exported) url.searchParams.set('mimeType', exported);
  else url.search = 'alt=media';
  return {
    metadata,
    bytes: await request(url, credential, true),
    contentType: exported ?? found.mimeType,
    representation: exported ? 'export' : 'download',
  };
}
