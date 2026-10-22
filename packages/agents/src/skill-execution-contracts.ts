import { z } from 'zod';
import { skillJobSchema } from '@tulipfarm/workflow-snippets/skill-protocol';
import { sourceDependenciesSchema } from '@tulipfarm/access/source-dependencies';
import { skillDigestSchema, skillPathSchema } from './skill-package-contracts.ts';

export const skillExecutionCallSchema = z.strictObject({
  tool: z.literal('skills.execute'),
  skillId: z.uuid(),
  revision: skillDigestSchema,
  invocationId: z.uuid().optional(),
  language: skillJobSchema.shape.language,
  entrypoint: skillPathSchema,
  args: skillJobSchema.shape.args.default([]),
  input: skillJobSchema.shape.input,
  folderId: z.uuid().optional(),
});
export const skillExecutionResultSchema = z.strictObject({
  invocationId: z.uuid(),
  status: z.enum(['pending', 'completed', 'failed']),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(131072),
  stderr: z.string().max(131072),
  files: z.array(z.strictObject({ id: z.uuid(), name: z.string() })).max(64),
  error: z.string().nullable(),
  sources: sourceDependenciesSchema,
  instruction: z.string(),
});
export type SkillExecutionCall = z.infer<typeof skillExecutionCallSchema>;
export const skillFileCallSchema = z.strictObject({
  tool: z.literal('skills.files.read'),
  skillId: z.uuid(),
  revision: skillDigestSchema,
  path: skillPathSchema,
  offset: z.number().int().min(0).max(10485760).default(0),
});
export const skillFileResultSchema = z.strictObject({
  skillId: z.uuid(),
  revision: skillDigestSchema,
  path: skillPathSchema,
  kind: z.enum(['text', 'binary']),
  text: z.string().max(16000).optional(),
  size: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nullable().optional(),
  instruction: z.string().optional(),
});
