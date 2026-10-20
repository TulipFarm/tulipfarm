import { z } from 'zod';

export const googleCorpusLimits = Object.freeze({
  mailboxWindowDays: 366,
  pageSize: 100,
  responseBytes: 32 * 1024 * 1024,
  errorBytes: 64 * 1024,
  requestTimeoutMs: 4000,
  ancestorDepth: 64,
  mimeParts: 1000,
  mimeDepth: 32,
});
export const googleCorpusIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const googleCorpusPageTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
export const googleCorpusKindSchema = z.enum(['drive-folder', 'shared-drive', 'drive-all', 'gmail']);
export const googleCorpusSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('drive-folder'), folderId: googleCorpusIdSchema }),
  z.strictObject({ kind: z.literal('shared-drive'), driveId: googleCorpusIdSchema }),
  // Every Drive file the connected account can read; used only by automatic owner-only Knowledge.
  z.strictObject({ kind: z.literal('drive-all') }),
  z
    .strictObject({
      kind: z.literal('gmail'),
      labelId: googleCorpusIdSchema.nullable(),
      after: z.iso.date(),
      before: z.iso.date(),
      window: z.literal('rolling-90d').optional(),
      excludeSpamTrash: z.literal(true).optional(),
    })
    .refine(value => {
      const days = (Date.parse(value.before) - Date.parse(value.after)) / 86_400_000;
      return days > 0 && days <= googleCorpusLimits.mailboxWindowDays;
    }, 'Mailbox selections require a positive window of at most 366 days (UTC, after inclusive, before exclusive)'),
]);
export type GoogleCorpusSelection = z.infer<typeof googleCorpusSelectionSchema>;
export type GoogleCorpusKind = z.infer<typeof googleCorpusKindSchema>;
export const googleCorpusBindingSchema = z.strictObject({
  integrationId: z.uuid(),
  accountId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  requiredScopes: z.array(z.string().min(1).max(256)).min(1).max(8),
});
export type GoogleCorpusBinding = z.infer<typeof googleCorpusBindingSchema>;
export const googleCorpusCursorSchema = z.strictObject({
  pageToken: googleCorpusPageTokenSchema.nullable(),
  folderId: googleCorpusIdSchema.optional(),
});
export type GoogleCorpusCursor = z.infer<typeof googleCorpusCursorSchema>;
export const googleCorpusErrorCodeSchema = z.enum([
  'invalid-selection',
  'invalid-cursor',
  'stale-integration',
  'reconnect-required',
  'insufficient-scope',
  'unauthenticated',
  'forbidden',
  'not-found',
  'rate-limited',
  'transient',
  'invalid-response',
  'response-too-large',
  'incomplete-search',
  'restricted',
  'resource-key-required',
  'unsupported',
  'attachments-unsupported',
  'mime-unsupported',
  'outside-selection',
  'source-changed',
  'ancestry-limit',
  'credential-unavailable',
]);
export type GoogleCorpusErrorCode = z.infer<typeof googleCorpusErrorCodeSchema>;
export class GoogleCorpusError extends Error {
  readonly code: GoogleCorpusErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: GoogleCorpusErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'GoogleCorpusError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type GoogleCorpusObservation = {
  nativeId: string;
  title: string;
  canonicalURL: string;
  sourceRevision: string;
  accessedAt: string;
  kind: 'file' | 'folder' | 'message';
  mediaType: string;
  parentIds: string[];
  coverage:
    | 'supported'
    | 'folder'
    | 'unsupported'
    | 'restricted'
    | 'resource-key-required'
    | 'attachments-unsupported'
    | 'mime-unsupported';
};
export type GoogleCorpusPage = { observations: GoogleCorpusObservation[]; nextCursor: GoogleCorpusCursor | null };
export type GoogleCorpusDiscovery = {
  binding: GoogleCorpusBinding;
  items: { nativeId: string; title: string; kind: GoogleCorpusKind }[];
  nextCursor: string | null;
};
export type GoogleCorpusInspection = { binding: GoogleCorpusBinding; selection: GoogleCorpusSelection; title: string };
export type GoogleCorpusRead = GoogleCorpusObservation & {
  readonly bytes: Uint8Array;
  filename: string;
  normalizedContent: string | null;
  metadataBefore: GoogleCorpusObservation;
  metadataAfter: GoogleCorpusObservation;
};
