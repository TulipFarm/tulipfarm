import {
  googleAppScopesGranted,
  googleBlock,
  googleFileByteLimit,
  googleType,
  type GoogleFileMetadata,
  type GoogleFilesApi,
  type SheetTab,
} from '@/features/files/google-api';

type Unreadable = 'native' | 'export-rejected' | 'too-large' | 'download-denied' | 'unsupported';
export type GoogleView =
  | { kind: 'binary'; bytes: ArrayBuffer; mediaType: string; filename: string }
  | { kind: 'sheet'; tabs: SheetTab[] }
  | { kind: 'folder' }
  | { kind: 'grant-sheets' }
  | { kind: 'details'; reason: Unreadable };

export async function loadView(
  api: GoogleFilesApi,
  scopes: readonly string[],
  fileId: string,
  signal: AbortSignal,
): Promise<{ file: GoogleFileMetadata; view: GoogleView }> {
  const file = await api.metadata(fileId, signal);
  const type = googleType(file).view;
  const view = async (): Promise<GoogleView> => {
    if (type === 'folder') return { kind: 'folder' };
    if (type === 'details') return { kind: 'details', reason: 'native' };
    if (type === 'sheet') {
      if (!googleAppScopesGranted(scopes, 'sheets')) return { kind: 'grant-sheets' };
      try {
        return { kind: 'sheet', tabs: await api.tabs(file.id, signal) };
      } catch (error) {
        if (googleBlock(error) === 'grant') return { kind: 'grant-sheets' };
        throw error;
      }
    }
    if (file.capabilities?.canDownload === false) return { kind: 'details', reason: 'download-denied' };
    if (type === 'blob' && Number(file.size ?? 0) > googleFileByteLimit)
      return { kind: 'details', reason: 'too-large' };
    try {
      const bytes = await api.binary(file.id, type === 'pdf' ? 'pdf' : 'download', signal);
      return type === 'pdf'
        ? {
            kind: 'binary',
            bytes,
            mediaType: 'application/pdf',
            filename: /\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`,
          }
        : { kind: 'binary', bytes, mediaType: file.mimeType, filename: file.name };
    } catch (error) {
      const block = googleBlock(error);
      if (block === 'export-rejected' || block === 'too-large' || block === 'unsupported')
        return { kind: 'details', reason: block };
      if (block === 'denied') return { kind: 'details', reason: 'download-denied' };
      throw error;
    }
  };
  return { file, view: await view() };
}

export const unreadable: Record<Unreadable, [string, string]> = {
  native: [
    'Open this file in Google',
    'TulipFarm can’t display this type of Google file. Open it in Google to view or change it.',
  ],
  'export-rejected': [
    'Google couldn’t export this file',
    'Google rejected the PDF export. Open it in Google, or check the file again.',
  ],
  'too-large': [
    'This file is too large to view here',
    'Files over 10 MB can’t be read into TulipFarm. Open it in Google to view or download it.',
  ],
  'download-denied': [
    'Downloading is turned off for this file',
    'Its owner turned off downloading, so TulipFarm can’t read its content. Open it in Google to view it.',
  ],
  unsupported: [
    'Google can’t provide a readable copy',
    'Google doesn’t offer a downloadable version of this file type. Open it in Google instead.',
  ],
};
