import { z } from 'zod';

export const googleFileIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/);
const fileId = googleFileIdSchema;
export const googleFileBindingSchema = z.strictObject({
  integrationId: z.uuid(),
  accountId: z.string().min(1).max(512),
  generation: z.number().int().positive(),
});
export const googleFileReferenceSchema = z.strictObject({ fileId, expectedIntegration: googleFileBindingSchema });
export type GoogleFileReference = z.infer<typeof googleFileReferenceSchema>;
export const googleFileListRequestSchema = z.strictObject({
  expectedIntegration: googleFileBindingSchema,
  parentId: fileId.optional(),
  sharedWithMe: z.boolean().default(false),
  name: z.string().max(500).optional(),
  pageToken: z.string().min(1).max(2048).optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
  orderBy: z.enum(['folder,name_natural', 'folder,modifiedTime desc']).default('folder,name_natural'),
});
export const googleFileMetadataSchema = z.object({
  id: fileId,
  name: z.string().max(4096),
  mimeType: z
    .string()
    .max(127)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  parents: z.array(fileId).optional(),
  size: z.string().regex(/^\d+$/).optional(),
  modifiedTime: z.iso.datetime().optional(),
  version: z.string().regex(/^\d+$/).optional(),
  trashed: z.boolean().optional(),
  shared: z.boolean().optional(),
  owners: z
    .array(
      z.object({ displayName: z.string().optional(), emailAddress: z.string().optional(), me: z.boolean().optional() }),
    )
    .optional(),
  capabilities: z.object({ canDownload: z.boolean().optional(), canCopy: z.boolean().optional() }).optional(),
  webViewLink: z.string().max(2048).optional(),
});
export type GoogleFileMetadata = z.infer<typeof googleFileMetadataSchema>;
export const googleFilePageSchema = z.object({
  files: z.array(googleFileMetadataSchema).max(100),
  nextPageToken: z.string().max(2048).optional(),
  incompleteSearch: z.boolean().default(false),
  skipped: z.number().int().min(0).max(100).default(0),
});
export type GoogleFilePage = z.infer<typeof googleFilePageSchema>;
const doc = 'application/vnd.google-apps.document',
  sheet = 'application/vnd.google-apps.spreadsheet',
  slides = 'application/vnd.google-apps.presentation';
/** Drive export targets by native type. CSV exports only a spreadsheet's first sheet. */
export const googleExportFormats = {
  pdf: { mimeType: 'application/pdf', extension: 'pdf', sources: [doc, sheet, slides] },
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    sources: [doc],
  },
  xlsx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
    sources: [sheet],
  },
  pptx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
    sources: [slides],
  },
  csv: { mimeType: 'text/csv', extension: 'csv', sources: [sheet] },
} as const satisfies Record<string, { mimeType: string; extension: string; sources: readonly string[] }>;
export const googleExportFormatSchema = z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'csv']);
export type GoogleExportFormat = z.infer<typeof googleExportFormatSchema>;
export const googleFileContentRequestSchema = z.discriminatedUnion('kind', [
  googleFileReferenceSchema.extend({ kind: z.literal('download') }),
  googleFileReferenceSchema.extend({ kind: z.literal('pdf') }),
  googleFileReferenceSchema.extend({ kind: z.literal('export'), format: googleExportFormatSchema }),
  googleFileReferenceSchema.extend({
    kind: z.literal('sheet-range'),
    sheetName: z.string().min(1).max(100),
    startRow: z.number().int().min(1).max(10_000_000),
    rowCount: z.number().int().min(1).max(1000),
    startColumn: z.number().int().min(1).max(18278),
    columnCount: z.number().int().min(1).max(100),
  }),
]);
export type GoogleFileContentRequest = z.infer<typeof googleFileContentRequestSchema>;
export const googleSheetRangeSchema = z.object({
  range: z.string(),
  majorDimension: z.literal('ROWS').default('ROWS'),
  values: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean()])).max(100))
    .max(1000)
    .default([]),
});
export type GoogleFileContent =
  | { kind: 'binary'; bytes: Uint8Array; mimeType: string; byteLength: number; version?: string | undefined }
  | { kind: 'sheet-range'; data: z.infer<typeof googleSheetRangeSchema> };
/** Current content of one Drive file as bytes a text reader can use, with the revision Google reported for it. */
export type GoogleFileText = {
  metadata: Pick<GoogleFileMetadata, 'id' | 'name' | 'mimeType' | 'version' | 'modifiedTime'>;
  bytes: Uint8Array;
  contentType: string;
  /** `export` is a Google-produced text form (Docs and Slides as plain text, Sheets as CSV of the first sheet); `download` is the stored file. */
  representation: 'export' | 'download';
};
export const googleFileByteLimit = 10 * 1024 * 1024;
/**
 * `detail` names Google's specific refusal when it changes what a reader should be told:
 * the owner turned off downloading, or the native type has no export. HTTP responses send only `code`.
 */
export class GoogleFileError extends Error {
  readonly code:
    | 'source-not-found'
    | 'source-access-denied'
    | 'export-rejected'
    | 'unsupported-representation'
    | 'transfer-busy'
    | 'transfer-timeout';
  readonly detail: 'download-restricted' | 'not-exportable' | null;
  constructor(code: GoogleFileError['code'], detail: GoogleFileError['detail'] = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
