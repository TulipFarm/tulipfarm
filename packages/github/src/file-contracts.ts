import { z } from 'zod';

export function decodeFileContent(value: { content: string; encoding: 'utf-8' | 'base64' }): string {
  if (value.encoding === 'utf-8') return value.content;
  const bytes = Uint8Array.from(atob(value.content), char => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export const filePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    path =>
      path.split('/').length <= 8 &&
      path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git') &&
      !path.includes('\\') &&
      [...path].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    'Invalid file path',
  );
export const fileContentFields = { content: z.string().max(11000), encoding: z.enum(['utf-8', 'base64']) };
export function boundedFileContent(value: z.infer<z.ZodObject<typeof fileContentFields>>) {
  try {
    const text = decodeFileContent(value);
    const bytes = new TextEncoder().encode(text);
    return (
      bytes.length <= 8192 &&
      new TextDecoder('utf-8', { fatal: true }).decode(bytes) === text &&
      [...text].every(char => {
        const code = char.charCodeAt(0);
        return (
          (code >= 32 && code !== 127 && !(char.length === 1 && code >= 0xd800 && code <= 0xdfff)) ||
          code === 9 ||
          code === 10 ||
          code === 13
        );
      }) &&
      (value.encoding !== 'base64' || btoa(String.fromCharCode(...bytes)) === value.content)
    );
  } catch {
    return false;
  }
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const fileChangeSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({ kind: z.literal('create'), path: filePathSchema, ...fileContentFields })
    .refine(boundedFileContent, 'Expected bounded UTF-8 text'),
  z
    .strictObject({ kind: z.literal('update'), path: filePathSchema, blobSha: sha, ...fileContentFields })
    .refine(boundedFileContent, 'Expected bounded UTF-8 text'),
  z.strictObject({ kind: z.literal('delete'), path: filePathSchema, blobSha: sha }),
]);
