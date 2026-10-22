import { z } from 'zod';
import { resultSchema, serializedBytes, snippetPayloadSchema } from './protocol.ts';

export const skillRuntimeProfile = 'skill-runtime-v1';
export const maxSkillJobBytes = 15 * 1024 * 1024;
export const skillRuntimePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(path => {
    const parts = path.split('/');
    return (
      path === path.normalize('NFC') &&
      !/[\\:]/.test(path) &&
      [...path].every(character => character.charCodeAt(0) > 31 && character !== '\u007f') &&
      parts.length <= 8 &&
      parts.every(
        part =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !['.git', 'node_modules'].includes(part.toLowerCase()),
      )
    );
  });
const encodedFile = z.strictObject({
  path: skillRuntimePathSchema,
  content: z
    .string()
    .max(14 * 1024 * 1024)
    .refine(value => value.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(value.replace(/={1,2}$/, '')), 'Invalid base64'),
});
export const skillJobSchema = z
  .strictObject({
    kind: z.literal('skill'),
    version: z.literal(1),
    workspaceId: z.uuid(),
    invocationId: z.uuid(),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    language: z.enum(['bash', 'python', 'node']),
    entrypoint: skillRuntimePathSchema,
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine(value => !value.includes('\0')),
      )
      .max(32),
    input: snippetPayloadSchema,
    files: z
      .array(encodedFile.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) }))
      .min(1)
      .max(256),
  })
  .refine(job => serializedBytes(job) <= maxSkillJobBytes, 'Skill job exceeds its byte limit');
export const skillResultSchema = z
  .union([
    resultSchema.options[0],
    resultSchema.options[2],
    z.strictObject({
      kind: z.literal('completed'),
      exitCode: z.number().int().min(0).max(255),
      stdout: z.string().max(131072),
      stderr: z.string().max(131072),
      files: z.array(encodedFile).max(64),
    }),
  ])
  .superRefine((result, ctx) => {
    if (result.kind !== 'completed') return;
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of result.files) {
      bytes += (file.content.length / 4) * 3 - (file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0);
      if (paths.has(file.path.toLowerCase())) ctx.addIssue({ code: 'custom', message: 'Duplicate output path' });
      paths.add(file.path.toLowerCase());
    }
    if (bytes > 10485760 || new TextEncoder().encode(result.stdout + result.stderr).length > 131072)
      ctx.addIssue({ code: 'custom', message: 'Output limit exceeded' });
  });
export type SkillJob = z.infer<typeof skillJobSchema>;
export type SkillResult = z.infer<typeof skillResultSchema>;
export type SkillClient = { submit(job: SkillJob): Promise<SkillResult>; available?: () => Promise<boolean> };
