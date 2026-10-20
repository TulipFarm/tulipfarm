import { z } from 'zod';

const id = z.uuid().transform(value => value.toLowerCase());
export const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function hasStorageIncompatibleString(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function storageCompatibilityIssue(value: unknown): boolean {
  if (typeof value === 'string') return hasStorageIncompatibleString(value);
  if (Array.isArray(value)) return value.some(storageCompatibilityIssue);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, item]) => hasStorageIncompatibleString(key) || storageCompatibilityIssue(item),
    );
  return false;
}
export const sourceSchema = z
  .string()
  .min(1)
  .refine(value => !hasStorageIncompatibleString(value), 'Source contains storage-incompatible text')
  .refine(value => serializedBytes(value) <= 32768, 'Serialized source exceeds 32 KiB');
export const snippetPayloadSchema = z
  .json()
  .refine(value => !storageCompatibilityIssue(value), 'Payload contains storage-incompatible text')
  .refine(value => serializedBytes(value) <= 32768, 'Payload exceeds 32 KiB');
export const maxJobBytes = 2 * 32768 + 1024;
export const executionSchema = z.strictObject({
  language: z.enum(['javascript', 'python']),
  source: sourceSchema,
  input: snippetPayloadSchema,
});
export const jobSchema = z
  .strictObject({
    workspaceId: id,
    runId: id,
    revision: id,
    stepId: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    language: z.enum(['javascript', 'python']),
    source: sourceSchema,
    input: snippetPayloadSchema,
  })
  .refine(value => serializedBytes(value) <= maxJobBytes);
export type SnippetJob = z.infer<typeof jobSchema>;
export const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('completed'), output: snippetPayloadSchema }),
  z.strictObject({
    kind: z.literal('failed'),
    error: z.enum([
      'invalid-input',
      'unavailable',
      'deadline',
      'output-limit',
      'execution-failed',
      'invalid-output',
      'interrupted',
      'cleanup-failed',
      'broker-rejected',
    ]),
  }),
]);
export type SnippetResult = z.infer<typeof resultSchema>;
export type SnippetClient = { submit(job: SnippetJob): Promise<SnippetResult> };
