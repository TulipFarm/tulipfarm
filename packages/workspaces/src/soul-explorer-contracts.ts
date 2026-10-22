import { z } from 'zod';

export const soulPreviewBytes = 1024 * 1024;
export const soulSnapshotBytes = 32 * 1024 * 1024;
export const soulSnapshotFiles = 10000;
export const soulRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const soulPathSchema = z
  .string()
  .max(512)
  .regex(/^[\p{L}\p{M}\p{N}._/-]+$/u)
  .refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git'));
export const soulTreeQuerySchema = z.object({
  directory: soulPathSchema.optional(),
  search: z.string().max(120).optional(),
  after: soulPathSchema.optional(),
  revision: soulRevisionSchema.optional(),
});
export const soulFileQuerySchema = z.object({ path: soulPathSchema, revision: soulRevisionSchema });
export const soulEntrySchema = z.object({
  path: soulPathSchema,
  kind: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative(),
});
export const soulTreeSchema = z.object({
  revision: soulRevisionSchema,
  entries: z.array(soulEntrySchema),
  nextCursor: soulPathSchema.nullable(),
});
export const soulFileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), revision: soulRevisionSchema, path: soulPathSchema, content: z.string() }),
  z.object({
    kind: z.literal('unavailable'),
    revision: soulRevisionSchema,
    path: soulPathSchema,
    reason: z.enum(['too-large', 'binary']),
  }),
]);
export const soulRepositorySchema = z.object({
  revision: soulRevisionSchema,
  entries: z.array(soulEntrySchema),
  files: z.array(soulFileSchema).max(soulSnapshotFiles),
});
export type SoulEntry = z.infer<typeof soulEntrySchema>;
export type SoulTree = z.infer<typeof soulTreeSchema>;
export type SoulFile = z.infer<typeof soulFileSchema>;
export type SoulRepository = z.infer<typeof soulRepositorySchema>;
export class SoulExplorerError extends Error {
  readonly code:
    | 'soul-not-found'
    | 'soul-not-ready'
    | 'soul-revision-changed'
    | 'soul-unavailable'
    | 'soul-snapshot-too-large';
  readonly status: 404 | 409 | 503;
  constructor(code: SoulExplorerError['code'], status: SoulExplorerError['status']) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
