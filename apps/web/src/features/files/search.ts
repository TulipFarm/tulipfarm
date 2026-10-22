import { z } from 'zod';
import {
  fileTypeSchema,
  libraryOwnerFilterSchema,
  librarySectionSchema,
  librarySortSchema,
} from '@tulipfarm/files/library-search-contracts';

export const filesViewSchema = z.enum([...librarySectionSchema.options, 'google']);
export type FilesView = z.infer<typeof filesViewSchema>;
export const modifiedPresets = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days',
  year: 'This year',
  custom: 'Custom range',
} as const;
export const filesSearchSchema = z.object({
  section: filesViewSchema.optional().catch(undefined),
  folder: z.uuid().optional().catch(undefined),
  q: z.string().max(255).optional().catch(undefined),
  /** `all` searches every source by name. It applies only while `q` is set. */
  scope: z.literal('all').optional().catch(undefined),
  sort: librarySortSchema.shape.key.optional().catch(undefined),
  order: librarySortSchema.shape.direction.optional().catch(undefined),
  type: fileTypeSchema.optional().catch(undefined),
  owner: libraryOwnerFilterSchema.optional().catch(undefined),
  modified: z
    .enum(Object.keys(modifiedPresets) as [keyof typeof modifiedPresets])
    .optional()
    .catch(undefined),
  /** Inclusive local dates of a custom modified range. */
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  after: z.string().max(4096).optional().catch(undefined),
});
export type FilesSearch = z.infer<typeof filesSearchSchema>;
/** The viewer keeps the list's place but never a page cursor, so a shared viewer link names nothing beyond the file. */
export const viewerSearchSchema = filesSearchSchema.omit({ after: true });
export type ViewerSearch = z.infer<typeof viewerSearchSchema>;
