import { z } from 'zod';

export const releaseAssetName = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,178}[A-Za-z0-9_-])?(?![\s\S])/,
    'Asset filename must be 1-180 ASCII letters, digits, dots, hyphens, or underscores, start with a letter or digit, and not end with a dot. GitHub may rename other filenames.',
  )
  .describe(
    'Exact asset filename. ASCII letters, digits, dots, hyphens, underscores only; start with a letter or digit; no trailing dot; 180 characters maximum.',
  );
export const releaseAssetFields = {
  name: releaseAssetName,
  label: z.string().max(256),
};
export const releaseUploadFields = {
  ...releaseAssetFields,
  contentType: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  size: z.number().int().min(1).max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().max(10924),
};
export function boundedReleaseUpload(value: { content: string; size: number }) {
  try {
    const bytes = atob(value.content);
    return bytes.length === value.size && btoa(bytes) === value.content;
  } catch {
    return false;
  }
}
