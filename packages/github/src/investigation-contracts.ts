import { z } from 'zod';
import { githubReadSchema } from './read-contracts.ts';

export const investigationChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('personal'),
    id: z.uuid(),
    generation: z.number().int().positive(),
    name: z.string(),
  }),
  z.strictObject({ kind: z.literal('team'), id: z.uuid(), generation: z.number().int().positive(), name: z.string() }),
]);
export const investigationSelectionSchema = z.strictObject({
  investigation: z.boolean(),
  version: z.number().int().nonnegative(),
  selected: investigationChoiceSchema.nullable(),
});
export const investigationChoicesSchema = investigationSelectionSchema.extend({
  choices: z.array(investigationChoiceSchema).max(200),
});
export const selectInvestigationSchema = z
  .strictObject({
    investigation: z.boolean().default(true),
    choice: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('personal'), id: z.uuid(), generation: z.number().int().positive() }),
        z.strictObject({ kind: z.literal('team'), id: z.uuid(), generation: z.number().int().positive() }),
      ])
      .nullable(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .refine(value => value.investigation || value.choice === null, 'End an investigation with no selected source');
export const investigationRepositoriesSchema = z.strictObject({
  query: z.string().trim().min(1).max(256).optional(),
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(30).default(10),
});
export const investigationReadSchema = githubReadSchema;
export const investigationCallOptions = [
  z.strictObject({ tool: z.literal('github.investigation.account') }),
  z.strictObject({ tool: z.literal('github.investigation.repositories'), ...investigationRepositoriesSchema.shape }),
  z.strictObject({
    tool: z.literal('github.investigation.read'),
    operation: investigationReadSchema,
    sourceId: z.uuid().optional(),
  }),
] as const;
