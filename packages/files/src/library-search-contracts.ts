import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';

export const librarySectionSchema = z.enum(['mine', 'shared', 'trash']);
export type LibrarySection = z.infer<typeof librarySectionSchema>;
/** File type filter values. Folders are a kind; every other value is decided by `fileTypeRules` from media type and extension. */
export const fileTypeSchema = z.enum(['folder', 'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'other']);
export type FileType = z.infer<typeof fileTypeSchema>;
export const librarySortSchema = z.strictObject({
  key: z.enum(['name', 'modified']),
  direction: z.enum(['asc', 'desc']),
});
export type LibrarySort = z.infer<typeof librarySortSchema>;
/** `me` and `others` compare with the reader; a membership id names one owner. */
export const libraryOwnerFilterSchema = z.union([z.enum(['me', 'others']), uuidSchema]);
