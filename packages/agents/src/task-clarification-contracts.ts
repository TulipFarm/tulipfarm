import { z } from 'zod';

const fieldIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);

export const clarificationOptionSchema = z.strictObject({
  value: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160),
});

const baseFieldShape = {
  id: fieldIdSchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400).optional(),
  required: z.boolean().default(true),
};

export const taskClarificationFieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...baseFieldShape,
    kind: z.literal('github_account'),
  }),
  z.strictObject({
    ...baseFieldShape,
    kind: z.literal('github_repository'),
    placeholder: z.string().trim().max(120).optional(),
  }),
  z.strictObject({
    ...baseFieldShape,
    kind: z.literal('select'),
    options: z.array(clarificationOptionSchema).min(1).max(50),
  }),
  z.strictObject({
    ...baseFieldShape,
    kind: z.literal('text'),
    placeholder: z.string().trim().max(160).optional(),
    multiline: z.boolean().default(false),
  }),
]);

export type TaskClarificationField = z.infer<typeof taskClarificationFieldSchema>;

export const taskClarificationDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).default('Details needed to continue'),
  summary: z.string().trim().min(1).max(1000),
  fields: z
    .array(taskClarificationFieldSchema)
    .min(1)
    .max(10)
    .refine(fields => new Set(fields.map(f => f.id)).size === fields.length, 'Duplicate clarification field id'),
});

export type TaskClarificationDraft = z.infer<typeof taskClarificationDraftSchema>;

export const githubAccountChoiceSchema = z.strictObject({
  value: z.string().min(1),
  kind: z.enum(['personal', 'team']),
  id: z.uuid(),
  generation: z.number().int().positive(),
  label: z.string().min(1),
});

export type GitHubAccountChoice = z.infer<typeof githubAccountChoiceSchema>;

export const taskClarificationViewSchema = z.strictObject({
  id: z.uuid(),
  tableId: z.uuid(),
  rowId: z.uuid(),
  agentTaskId: z.uuid().nullable(),
  agentId: z.uuid(),
  title: z.string(),
  summary: z.string(),
  fields: z.array(taskClarificationFieldSchema),
  githubAccounts: z.array(githubAccountChoiceSchema),
  status: z.enum(['open', 'answered', 'cancelled']),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  answeredVia: z.enum(['web', 'slack']).nullable(),
  answers: z.record(z.string(), z.string()).nullable(),
});

export type TaskClarificationView = z.infer<typeof taskClarificationViewSchema>;

export const taskClarificationAnswerInputSchema = z.strictObject({
  answers: z.record(fieldIdSchema, z.string().max(4000)),
});

export type TaskClarificationAnswerInput = z.infer<typeof taskClarificationAnswerInputSchema>;
