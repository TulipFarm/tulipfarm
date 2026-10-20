import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import {
  fileTypeSchema,
  librarySectionSchema,
  librarySortSchema,
  libraryOwnerFilterSchema,
  type FileType,
} from './library-search-contracts.ts';
export {
  fileTypeSchema,
  librarySectionSchema,
  librarySortSchema,
  libraryOwnerFilterSchema,
  type FileType,
  type LibrarySection,
  type LibrarySort,
} from './library-search-contracts.ts';

export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    value =>
      [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      !/[/\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Unsafe filename',
  )
  .transform(value => value.trim())
  .pipe(z.string().min(1));
export const fileRoleSchema = z.enum(['viewer', 'editor', 'manager']);
export const fileSubjectSchema = z.strictObject({ kind: z.enum(['individual', 'team']), id: uuidSchema });
export const newFolderSchema = z.strictObject({ name: fileNameSchema, parentId: uuidSchema.nullable() });
export const newFileSchema = newFolderSchema.extend({
  mediaType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
});
export const itemSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['file', 'folder']),
  creator_membership_id: uuidSchema,
  parent_id: uuidSchema.nullable(),
  name: z.string(),
  trashed_at: z.date().nullable(),
  created_at: z.date(),
  object_key: uuidSchema.nullable(),
  media_type: z.string().nullable(),
  size: z.number().int().nullable(),
  sha256: z.string().nullable(),
  ready: z.boolean(),
  deleting_at: z.date().nullable().default(null),
  deletion_failed_at: z.date().nullable().default(null),
  modified_at: z.date().nullable().default(null),
  object_owner: z.enum(['files', 'attachment']).default('files'),
});
export type FileItem = z.infer<typeof itemSchema>;
export type FileRole = z.infer<typeof fileRoleSchema>;
export type FileSubject = z.infer<typeof fileSubjectSchema>;
export const roleLevel: Record<FileRole, number> = { viewer: 1, editor: 2, manager: 3 };

export const fileSummarySchema = z.object({
  id: uuidSchema,
  kind: z.enum(['file', 'folder']),
  name: z.string(),
  parentId: uuidSchema.nullable(),
  creatorMembershipId: uuidSchema,
  mediaType: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  trashed: z.boolean(),
  role: fileRoleSchema,
  deletion: z.enum(['deleting', 'failed']).nullable().default(null),
});
export type FileSummary = z.infer<typeof fileSummarySchema>;
export const libraryLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }),
  z.object({ kind: z.literal('folder'), id: uuidSchema }),
]);
export type LibraryLocation = z.infer<typeof libraryLocationSchema>;
/** The id of the last item on the previous page. The server reads its sort key under the reader's access, so the token discloses nothing. */
export const libraryCursorTokenSchema = uuidSchema;
type FileTypeRule = {
  type: Exclude<FileType, 'folder' | 'other'>;
  mediaTypes: readonly string[];
  mediaPrefixes: readonly string[];
  extensions: readonly string[];
};
/** The first matching rule decides a file's type, so `text/csv` is a spreadsheet before the `text/` prefix makes it a document. */
export const fileTypeRules: readonly FileTypeRule[] = [
  { type: 'pdf', mediaTypes: ['application/pdf'], mediaPrefixes: [], extensions: ['pdf'] },
  {
    type: 'image',
    mediaTypes: [],
    mediaPrefixes: ['image/'],
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'heic', 'heif', 'tif', 'tiff'],
  },
  {
    type: 'spreadsheet',
    mediaTypes: [
      'text/csv',
      'text/tab-separated-values',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet',
    ],
    mediaPrefixes: [],
    extensions: ['csv', 'tsv', 'xls', 'xlsx', 'ods'],
  },
  {
    type: 'presentation',
    mediaTypes: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
    ],
    mediaPrefixes: [],
    extensions: ['ppt', 'pptx', 'odp', 'key'],
  },
  {
    type: 'document',
    mediaTypes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
      'application/rtf',
    ],
    mediaPrefixes: ['text/'],
    extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown', 'pages'],
  },
];
/** `modifiedFrom` is inclusive and `modifiedBefore` exclusive. Either bound excludes rows whose modified time is unknown. */
export const libraryFiltersSchema = z.strictObject({
  type: fileTypeSchema.optional(),
  owner: libraryOwnerFilterSchema.optional(),
  modifiedFrom: z.iso.datetime({ offset: true }).optional(),
  modifiedBefore: z.iso.datetime({ offset: true }).optional(),
});
export type LibraryFilters = z.infer<typeof libraryFiltersSchema>;
export const libraryQuerySchema = z.strictObject({
  section: librarySectionSchema,
  location: libraryLocationSchema,
  query: z.string().max(255),
  after: libraryCursorTokenSchema.optional(),
  sort: librarySortSchema.default({ key: 'name', direction: 'asc' }),
  filters: libraryFiltersSchema.default({}),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
export const filePersonSchema = z.object({ membershipId: uuidSchema, name: z.string() });
export type FilePerson = z.infer<typeof filePersonSchema>;
/** `stranded`: owned by the reader but unreachable because another owner moved a folder above it to Trash. Only Trash lists these. */
/**
 * `modifiedAt` is null for rows created before modified times were recorded.
 * `parentName` names the containing folder when the reader can open it; it is null at a root or above an unreadable folder.
 */
export const libraryItemSchema = fileSummarySchema.extend({
  stranded: z.boolean(),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  parentName: z.string().nullable(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;
/** `owners` names the owner of every listed item and every owner in the section, folder, and search before filters apply, for the owner filter. */
export const libraryPageSchema = z.object({
  items: z.array(libraryItemSchema),
  next: libraryCursorTokenSchema.nullable(),
  breadcrumbs: z.array(fileSummarySchema),
  owners: z.array(filePersonSchema),
});
export type LibraryPage = z.infer<typeof libraryPageSchema>;
export const fileSuggestionsQuerySchema = z.strictObject({
  query: z.string().max(255),
  after: uuidSchema.optional(),
});
export type FileSuggestionsQuery = z.infer<typeof fileSuggestionsQuerySchema>;
export const fileSuggestionsPageSchema = z.object({
  items: z.array(fileSummarySchema),
  next: uuidSchema.nullable(),
});
export type FileSuggestionsPage = z.infer<typeof fileSuggestionsPageSchema>;
export const fileDetailsSchema = z.object({
  item: fileSummarySchema,
  owner: filePersonSchema,
  path: z.array(fileSummarySchema),
  pathRestricted: z.boolean(),
});
export type FileDetails = z.infer<typeof fileDetailsSchema>;
export const fileDirectorySchema = z.object({
  members: z.array(filePersonSchema.extend({ email: z.string() })),
  teams: z.array(z.object({ id: uuidSchema, name: z.string() })),
});
export type FileDirectory = z.infer<typeof fileDirectorySchema>;

export const readableFileReferenceSchema = z.object({ kind: z.literal('readable'), id: uuidSchema, name: z.string() });
export type ReadableFileReference = z.infer<typeof readableFileReferenceSchema>;
export const fileReferenceSchema = z.union([readableFileReferenceSchema, z.object({ kind: z.literal('restricted') })]);
export type FileReference = z.infer<typeof fileReferenceSchema>;
export const fileGrantSchema = z.object({ subject: fileSubjectSchema, role: fileRoleSchema });
export type FileGrant = z.infer<typeof fileGrantSchema>;
const fileOwnershipSchema = z.object({ membershipId: uuidSchema, active: z.boolean() });
export type FileOwnership = z.infer<typeof fileOwnershipSchema>;
const fileSharingContributionSchema = z.union([
  z.object({ source: fileReferenceSchema, kind: z.literal('ownership'), owner: fileOwnershipSchema }),
  z.object({ source: fileReferenceSchema, kind: z.literal('grant'), grant: fileGrantSchema }),
]);
export type FileSharingContribution = z.infer<typeof fileSharingContributionSchema>;
const fileAudienceSchema = z.array(z.object({ membershipId: uuidSchema, role: fileRoleSchema }));
export type FileAudienceMember = z.infer<typeof fileAudienceSchema>[number];
export const fileSharingSnapshotSchema = z.object({
  item: readableFileReferenceSchema,
  creator: fileOwnershipSchema,
  effectiveRole: z.literal('manager'),
  directGrants: z.array(fileGrantSchema),
  inherited: z.array(fileSharingContributionSchema),
  effectiveAudience: fileAudienceSchema,
});
export type FileSharingSnapshot = z.infer<typeof fileSharingSnapshotSchema>;
const moveAudienceSchema = z.object({
  availability: z.enum(['available', 'unavailable']),
  audience: fileAudienceSchema,
});
export type MoveAudience = z.infer<typeof moveAudienceSchema>;
export const moveFingerprintSchema = z.string().regex(/^files-move-v1:[a-f0-9]{64}$/);
export const movePreviewSchema = z.object({
  source: readableFileReferenceSchema,
  destination: z.union([
    z.object({ kind: z.literal('root') }),
    z.object({ kind: z.literal('folder'), item: readableFileReferenceSchema, effectiveRole: fileRoleSchema }),
  ]),
  subtree: z.array(z.object({ item: fileReferenceSchema, before: moveAudienceSchema, after: moveAudienceSchema })),
  fingerprint: moveFingerprintSchema,
});
export type MovePreview = z.infer<typeof movePreviewSchema>;

export const fileStorageUsageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
});
export type FileStorageUsage = z.infer<typeof fileStorageUsageSchema>;
export const deletionBlockerSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  kind: z.enum(['file', 'folder']),
  owner: filePersonSchema,
});
export const deletionPreviewSchema = z.object({
  item: fileSummarySchema,
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  blockers: z.array(deletionBlockerSchema),
  blockerCount: z.number().int().nonnegative(),
});
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;
export const deletionOutcomeSchema = z.object({ id: uuidSchema, state: z.enum(['deleted', 'deleting', 'failed']) });
export type DeletionOutcome = z.infer<typeof deletionOutcomeSchema>;
/** A Google file read into an independent copy. The command is recognized on replay without reading Google again. */
export const fileCopySourceSchema = z.strictObject({
  provider: z.literal('google-drive'),
  accountId: z.string().min(1).max(512),
  fileId: z.string().min(1).max(512),
  format: z.string().min(1).max(64),
});
export type FileCopySource = z.infer<typeof fileCopySourceSchema>;

export class FileError extends Error {
  readonly code:
    | 'conflict'
    | 'invalid-move'
    | 'integrity'
    | 'size'
    | 'quota'
    | 'busy'
    | 'graph-limit'
    | 'invalid-cursor'
    | 'not-owner'
    | 'owned-by-others'
    | 'not-trashed'
    | 'restore-destination';
  constructor(code: FileError['code']) {
    super(`File ${code}`);
    this.code = code;
  }
}
