import { useCallback, useMemo } from 'react';
import { z } from 'zod';
import {
  googleAppScopes,
  googleFileByteLimit,
  googleFileMetadataSchema,
  googleFilePageSchema,
  googleSheetRangeSchema,
  type GoogleApp,
  type GoogleExportFormat,
  type GoogleFileMetadata,
  type GoogleStatus,
} from '@tulipfarm/google-workspace/public-contracts';
import { fileSummarySchema } from '@tulipfarm/files/contracts';
import { apiOrigin } from '@/lib/auth';
import { googleApi, GoogleRequestError } from '@/lib/google-workspace';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { featureKey, featureReadOptions, type FeatureReadOptions } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import type { ReadState } from '@/features/tables/request-state';
import { connector } from '@/features/integrations/connect';
import { integrations } from '@/features/integrations/catalog';
import { integrationKeys, useGoogleIntegration } from '@/features/integrations/queries';
import type { Brand } from '@tulipfarm/sprout/brand-icon';
import { fileKind, type FileKind } from '@/lib/file-viewer';

export { googleFileByteLimit, type GoogleFileMetadata };
export type { GoogleFilesSearch } from './google-search';

export type GoogleBinding = { integrationId: string; accountId: string; generation: number };
export type DriveAccess =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'not-configured' }
  | { kind: 'disconnected' }
  | { kind: 'reconnect'; email: string }
  | { kind: 'grant'; email: string }
  | { kind: 'ready'; email: string; binding: GoogleBinding; scopes: readonly string[] };

export const googleAppScopesGranted = (scopes: readonly string[], app: GoogleApp) =>
  googleAppScopes[app].every(scope => scopes.includes(scope));

export function driveAccess(state: ReadState<{ configured: boolean; status: GoogleStatus }>): DriveAccess {
  if (state.kind === 'loading') return { kind: 'loading' };
  if (state.kind === 'unavailable') return { kind: 'unavailable' };
  if (state.kind === 'error') return { kind: 'error' };
  const { configured, status } = state.data;
  if (status.status === 'disconnected') return configured ? { kind: 'disconnected' } : { kind: 'not-configured' };
  if (status.status === 'reconnect-required') return { kind: 'reconnect', email: status.email };
  if (!googleAppScopesGranted(status.scopes, 'drive')) return { kind: 'grant', email: status.email };
  return {
    kind: 'ready',
    email: status.email,
    scopes: status.scopes,
    binding: { integrationId: status.integrationId, accountId: status.accountId, generation: status.generation },
  };
}

/** The integration status read owns account identity; its authority helper conceals every key below `content('google')` when the binding changes. */
export function useDriveAccess(workspaceId: string, enabled = true) {
  const integration = useGoogleIntegration(workspaceId, enabled);
  const access = driveAccess(integration.state);
  const connect = useCallback(
    async (app: Extract<GoogleApp, 'drive' | 'sheets'>) => {
      const integration = integrations.find(item => item.provider === 'google' && item.googleApp === app);
      const start = integration && connector(integration, workspaceId);
      if (!start) throw new Error('Google integration is unavailable');
      await start();
    },
    [workspaceId],
  );
  return { access, refresh: integration.refresh, connect };
}

/** Reads that end in one of these codes clear any cached Google content. Other failures are transient and keep it. */
const blocks = {
  'integration-required': 'reconnect',
  'reconnect-required': 'reconnect',
  'stale-integration': 'reconnect',
  'insufficient-scope': 'grant',
  'source-not-found': 'not-found',
  'source-access-denied': 'denied',
  'export-rejected': 'export-rejected',
  'unsupported-representation': 'unsupported',
  'response-too-large': 'too-large',
} as const satisfies Record<string, string>;
export type GoogleBlock = (typeof blocks)[keyof typeof blocks];
export type GoogleOutcome<T> = { kind: 'ok'; value: T; readAt: number } | { kind: 'blocked'; block: GoogleBlock };

export function googleBlock(error: unknown): GoogleBlock | null {
  return error instanceof GoogleRequestError && error.status === 409 && Object.hasOwn(blocks, error.code)
    ? blocks[error.code as keyof typeof blocks]
    : null;
}
export async function outcome<T>(load: () => Promise<T>): Promise<GoogleOutcome<T>> {
  try {
    return { kind: 'ok', value: await load(), readAt: Date.now() };
  } catch (error) {
    const block = googleBlock(error);
    if (block) return { kind: 'blocked', block };
    throw error;
  }
}

export const googleFileKeys = {
  all: (binding: GoogleBinding) => [...integrationKeys.content('google'), 'files', binding] as const,
  list: (binding: GoogleBinding, query: ListQuery) => [...googleFileKeys.all(binding), 'list', query] as const,
  trail: (binding: GoogleBinding, folderId: string) => [...googleFileKeys.all(binding), 'trail', folderId] as const,
  item: (binding: GoogleBinding, fileId: string) => [...googleFileKeys.all(binding), 'item', fileId] as const,
  range: (binding: GoogleBinding, fileId: string, sheet: string, startRow: number) =>
    [...googleFileKeys.item(binding, fileId), 'range', sheet, startRow] as const,
};
export type ListQuery = {
  parentId?: string;
  sharedWithMe?: true;
  name?: string;
  pageToken?: string;
  pageSize?: number;
};

const sheetTabsSchema = z.object({
  sheets: z
    .array(
      z.object({
        properties: z.object({
          title: z.string(),
          hidden: z.boolean().optional(),
          sheetType: z.string().optional(),
          gridProperties: z
            .object({
              rowCount: z.number().int().nonnegative().optional(),
              columnCount: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      }),
    )
    .max(200)
    .default([]),
});
export type SheetTab = { title: string; rows: number; columns: number };
const sheetRangeResponseSchema = z.object({ kind: z.literal('sheet-range'), data: googleSheetRangeSchema });
export type SheetRange = z.infer<typeof googleSheetRangeSchema>;

export function googleFilesApi(workspaceId: string, binding: GoogleBinding, scopes: readonly string[]) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/google-workspace/operations/files`;
  const post = async (path: 'list' | 'metadata' | 'content', body: object, signal: AbortSignal) => {
    const response = await jsonResponse(`${base}/${path}`, {
      method: 'POST',
      body: { ...body, expectedIntegration: binding },
      signal,
      cache: 'no-store',
    });
    if (!response.ok)
      throw new GoogleRequestError(response.status, responseError(await readJson(response, true), 'unavailable'));
    return response;
  };
  return {
    list: async (query: ListQuery, signal: AbortSignal) =>
      googleFilePageSchema.parse(await readJson(await post('list', query, signal))),
    metadata: async (fileId: string, signal: AbortSignal) =>
      googleFileMetadataSchema.parse(await readJson(await post('metadata', { fileId }, signal))),
    binary: async (fileId: string, kind: 'pdf' | 'download', signal: AbortSignal) =>
      (await post('content', { fileId, kind }, signal)).arrayBuffer(),
    /** Saves an independent Files copy. `commandId` becomes the new file's id, so a retry with it never creates a second copy. */
    async copy(
      commandId: string,
      input: { fileId: string; name: string; parentId: string | null; format: 'original' | GoogleExportFormat },
    ) {
      const response = await jsonResponse(
        `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(commandId)}/google-copy`,
        {
          method: 'PUT',
          cache: 'no-store',
          signal: AbortSignal.timeout(90_000),
          body: {
            name: input.name,
            parentId: input.parentId,
            format: input.format,
            source: { fileId: input.fileId, expectedIntegration: binding },
          },
        },
      );
      if (!response.ok)
        throw new GoogleRequestError(
          response.status,
          responseError(await readJson(response, true), 'file-operation-failed'),
        );
      return fileSummarySchema.parse(await readJson(response));
    },
    range: async (
      fileId: string,
      range: { sheetName: string; startRow: number; rowCount: number; columnCount: number },
      signal: AbortSignal,
    ) =>
      sheetRangeResponseSchema.parse(
        await readJson(await post('content', { fileId, kind: 'sheet-range', startColumn: 1, ...range }, signal)),
      ).data,
    async tabs(fileId: string, signal: AbortSignal): Promise<SheetTab[]> {
      const result = await googleApi.read(
        workspaceId,
        {
          operation: { kind: 'sheets.spreadsheets.get', spreadsheetId: fileId },
          expectedIntegration: { ...binding, scopes: [...scopes] },
        },
        signal,
      );
      return sheetTabsSchema.parse(result.data).sheets.flatMap(({ properties: tab }) =>
        tab.hidden || (tab.sheetType && tab.sheetType !== 'GRID')
          ? []
          : [
              {
                title: tab.title,
                rows: tab.gridProperties?.rowCount ?? 0,
                columns: tab.gridProperties?.columnCount ?? 0,
              },
            ],
      );
    },
  };
}
export type GoogleFilesApi = ReturnType<typeof googleFilesApi>;
export function useGoogleFilesApi(workspaceId: string, binding: GoogleBinding, scopes: readonly string[]) {
  return useMemo(
    () => googleFilesApi(workspaceId, binding, scopes),
    [workspaceId, binding.integrationId, binding.accountId, binding.generation, scopes.join(' ')],
  );
}

/** Refetches every read below a prefix in this tab only. A refresh is not a confirmed change, so it never broadcasts. */
export function useRefetch() {
  const { runtime, scope } = useFeatureContext();
  return useCallback(
    (key: readonly unknown[]) => runtime.client.refetchQueries({ queryKey: featureKey(scope, key), type: 'active' }),
    [runtime, scope],
  );
}

/** A fresh read through the shared cache, for actions such as download that must re-authorize before delivering bytes. */
export function useGoogleFetch() {
  const { runtime, scope, current } = useFeatureContext();
  return useCallback(
    <T>(input: FeatureReadOptions<T>) =>
      runtime.client.fetchQuery({ ...featureReadOptions(runtime, scope, input, current), retry: false }),
    [runtime, scope, current],
  );
}

type GoogleType = { label: string; view: 'folder' | 'pdf' | 'sheet' | 'details' | 'blob'; brand?: Brand };
const native: Record<string, GoogleType> = {
  'application/vnd.google-apps.folder': { label: 'Folder', view: 'folder' },
  'application/vnd.google-apps.document': { label: 'Google Doc', view: 'pdf', brand: 'google-docs' },
  'application/vnd.google-apps.presentation': { label: 'Google Slides', view: 'pdf', brand: 'google-slides' },
  'application/vnd.google-apps.spreadsheet': { label: 'Google Sheet', view: 'sheet', brand: 'google-sheets' },
  'application/vnd.google-apps.form': { label: 'Google Form', view: 'details', brand: 'google-forms' },
  'application/vnd.google-apps.shortcut': { label: 'Shortcut', view: 'details', brand: 'google-drive' },
};
const blobLabels: Record<FileKind, string> = {
  image: 'Image',
  pdf: 'PDF',
  json: 'JSON',
  text: 'Text',
  markdown: 'Markdown',
  sheet: 'Spreadsheet',
  document: 'Document',
  slides: 'Presentation',
  google: 'File',
  unsupported: 'File',
};
export function googleType(file: Pick<GoogleFileMetadata, 'name' | 'mimeType'>): GoogleType {
  return (
    native[file.mimeType] ??
    (file.mimeType.startsWith('application/vnd.google-apps.')
      ? { label: 'Google file', view: 'details', brand: 'google-drive' }
      : { label: blobLabels[fileKind(file.name, file.mimeType)], view: 'blob' })
  );
}

/** Provider links become hrefs. Only plain https links on Google-owned hosts qualify. */
export function googleWebLink(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname;
  return url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    (host === 'google.com' || host.endsWith('.google.com'))
    ? url.href
    : null;
}

export function googleOwner(file: GoogleFileMetadata) {
  const owner = file.owners?.[0];
  if (!owner) return file.shared ? 'Shared with you' : '';
  return owner.me ? 'You' : owner.displayName || owner.emailAddress || 'Another owner';
}

export function sheetColumn(index: number): string {
  let name = '';
  while (index > 0) {
    index--;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}

export const readTime = (at: number) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
