export type FileSource = { kind: 'local'; file: File } | { kind: 'remote'; url: string };
export type ViewableFile = { name: string; mediaType: string; source: FileSource };
export type FileKind =
  | 'image'
  | 'pdf'
  | 'json'
  | 'text'
  | 'markdown'
  | 'sheet'
  | 'document'
  | 'slides'
  | 'google'
  | 'unsupported';

export const fileAccept =
  '.docx,.xlsx,.xls,.csv,.tsv,.pptx,.ppt,.pdf,.json,.txt,.md,.markdown,.gdoc,.gsheet,.gslides,image/*';
export const maxLocalFileBytes = 50 * 1024 * 1024;

export function fileKind(name: string, mediaType: string): FileKind {
  const extension = name.toLowerCase().split('.').at(-1);
  if (
    mediaType.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'heic', 'heif', 'tif', 'tiff'].includes(
      extension ?? '',
    )
  )
    return 'image';
  if (mediaType.startsWith('application/vnd.google-apps.') || ['gdoc', 'gsheet', 'gslides'].includes(extension ?? ''))
    return 'google';
  if (extension === 'pdf' || mediaType === 'application/pdf') return 'pdf';
  if (extension === 'json' || mediaType === 'application/json') return 'json';
  if (['md', 'markdown'].includes(extension ?? '') || mediaType === 'text/markdown') return 'markdown';
  if (
    ['xls', 'xlsx', 'csv', 'tsv'].includes(extension ?? '') ||
    [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ].includes(mediaType)
  )
    return 'sheet';
  if (extension === 'docx' || mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'document';
  if (extension === 'pptx' || mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    return 'slides';
  if (mediaType.startsWith('text/') || extension === 'txt') return 'text';
  return 'unsupported';
}

export function googleDocument(url: string): { url: string; embedUrl: string; mediaType: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'docs.google.com' ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    return null;
  const match = /^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  const [, family, id] = match;
  const canonical = `https://docs.google.com/${family}/d/${id}`;
  // Google names its document embedding endpoint /preview.
  // eslint-disable-next-line tulipfarm/product-copy
  const endpoint = family === 'presentation' ? 'embed' : 'preview';
  return {
    url: `${canonical}/edit`,
    embedUrl: `${canonical}/${endpoint}${family === 'spreadsheets' ? '?widget=true&headers=false' : ''}`,
    mediaType: `application/vnd.google-apps.${family === 'spreadsheets' ? 'spreadsheet' : family}`,
  };
}

export function googleShortcut(text: string): string {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('url' in value) || typeof value.url !== 'string')
    throw new Error('This Google shortcut does not contain a document link.');
  const document = googleDocument(value.url);
  if (!document) throw new Error('This shortcut does not contain a supported Google Docs, Sheets, or Slides link.');
  return document.url;
}

export function formatFileSize(bytes: number) {
  if (bytes === 0) return '0 bytes';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`;
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const rasterTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/heic',
  'image/heif',
  'image/tiff',
]);

/** Stored and provider media types are untrusted. A same-origin blob must never carry a type a browser runs as a document, including SVG in any letter case. */
export function renderableType(name: string, mediaType: string) {
  const kind = fileKind(name, mediaType);
  if (kind === 'pdf') return 'application/pdf';
  const type = mediaType.trim().toLowerCase();
  return kind === 'image' && rasterTypes.has(type) ? type : 'application/octet-stream';
}
