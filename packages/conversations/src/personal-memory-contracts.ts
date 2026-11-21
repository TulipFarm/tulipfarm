import { z } from 'zod';
export * from '@tulipfarm/memory-core/personal-memory-contracts';

export const memoryGroups = ['you', 'topics', 'areas', 'people'] as const;
export type MemoryGroup = (typeof memoryGroups)[number];

/** How the member wants Bud to respond. Earlier memory lived only here. */
export const preferencesPath = '/profile.md';
/** Who the member is and what they do. */
export const profilePath = '/you/about.md';
/** The You files: always present on the memory page, with fixed names, and always given to Bud in full. */
export const youFiles = [
  { path: preferencesPath, name: 'Preferences', description: 'How you want Bud to respond' },
  { path: profilePath, name: 'Profile', description: 'Who you are and what you do' },
] as const;

/** Keep's limits for one file. */
export const memoryFileMaximumBytes = 8192;
export const memoryDescriptionMaximumBytes = 160;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const grouped = /^\/(topics|areas|people)\/([^/]+)\.md$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** The group a memory path belongs to, or undefined when TulipFarm does not keep memory there. */
export function memoryGroup(path: string): MemoryGroup | undefined {
  if (youFiles.some(file => file.path === path)) return 'you';
  const match = grouped.exec(path);
  if (!match || match[2]!.length > 80 || !slug.test(match[2]!)) return undefined;
  return match[1] as MemoryGroup;
}

/** A readable name for a file that has none: its slug in sentence case. */
export function defaultMemoryName(path: string) {
  const fixed = youFiles.find(file => file.path === path);
  if (fixed) return fixed.name;
  const name = (path.split('/').at(-1) ?? path).replace(/\.md$/, '').replace(/-/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const memoryPathSchema = z
  .string()
  .max(200)
  .refine(path => memoryGroup(path) !== undefined, 'Use /profile.md, /you/about.md, or /topics|areas|people/<slug>.md');
const fileText = z
  .string()
  .refine(
    value =>
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Invalid text',
  )
  .refine(value => bytes(value) <= memoryFileMaximumBytes, 'A memory file holds at most 8 KiB');
export const memoryFileNameSchema = z.string().trim().min(1).max(120);
export const memoryFileDescriptionSchema = z
  .string()
  .trim()
  .refine(value => bytes(value) <= memoryDescriptionMaximumBytes, 'A description holds at most 160 bytes');
const revisionId = z.string().min(1).max(200);

export const memoryFileSchema = z.strictObject({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  group: z.enum(memoryGroups),
  /** Null for a You file that has not been written yet. */
  revisionId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  size: z.number().int().nonnegative(),
});
export type MemoryFile = z.infer<typeof memoryFileSchema>;
export const memoryFileContentSchema = memoryFileSchema.extend({ content: z.string() });
export type MemoryFileContent = z.infer<typeof memoryFileContentSchema>;
/** Every file with its text; files are small and capped, so the memory page loads in one request. */
export const memoryFilesSchema = z.strictObject({ files: z.array(memoryFileContentSchema) });
export const memoryFilePathSchema = z.strictObject({ path: memoryPathSchema });

export const saveMemoryFileSchema = z.strictObject({
  path: memoryPathSchema,
  content: fileText,
  /** Null creates the file; otherwise the revision the change was made against. */
  expectedRevisionId: revisionId.nullable(),
  name: memoryFileNameSchema.optional(),
  description: memoryFileDescriptionSchema.optional(),
});
export type SaveMemoryFile = z.infer<typeof saveMemoryFileSchema>;
export const deleteMemoryFileSchema = z.strictObject({ path: memoryPathSchema, expectedRevisionId: revisionId });

export const memoryInstructionSchema = z.strictObject({
  requestId: z.uuid(),
  instruction: z.string().trim().min(1).max(2000),
});
export const memoryFileChangeSchema = z.strictObject({
  path: z.string(),
  name: z.string(),
  operation: z.enum(['created', 'updated', 'deleted']),
});
export type MemoryFileChange = z.infer<typeof memoryFileChangeSchema>;
export const memoryInstructionResultSchema = z.strictObject({
  changed: z.array(memoryFileChangeSchema),
  files: z.array(memoryFileSchema),
});
export type MemoryInstructionResult = z.infer<typeof memoryInstructionResultSchema>;
