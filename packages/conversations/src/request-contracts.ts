import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access';
import { textPartSchema } from './contracts.ts';

const text = textPartSchema.shape.text;
const choiceId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const answerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text }),
  z.strictObject({
    kind: z.literal('choices'),
    choiceIds: z
      .array(choiceId)
      .min(1)
      .max(32)
      .refine(ids => new Set(ids).size === ids.length),
  }),
]);
export const answerDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z
    .strictObject({
      kind: z.literal('choices'),
      choices: z
        .array(z.strictObject({ id: choiceId, label: text.max(256) }))
        .min(1)
        .max(32),
      multiple: z.boolean(),
      allowText: z.boolean().optional(),
    })
    .refine(value => new Set(value.choices.map(choice => choice.id)).size === value.choices.length),
]);
export const presentChoiceSchema = z.strictObject({
  tool: z.literal('present.choice'),
  prompt: text,
  choices: z
    .array(z.strictObject({ id: choiceId, label: text.max(256) }))
    .min(2)
    .max(32)
    .refine(choices => new Set(choices.map(choice => choice.id)).size === choices.length),
});
export const requestInputSchema = z.strictObject({
  producerId: uuidSchema,
  prompt: text,
  answerSchema: answerDefinitionSchema,
});
export const answerRequestSchema = z.strictObject({
  commandId: uuidSchema,
  expectedRevision: z.number().int().positive(),
  answer: answerSchema,
});
export const cancelRequestSchema = answerRequestSchema.pick({ commandId: true, expectedRevision: true });
export const requestOutcomeSchema = z.object({
  requestId: uuidSchema,
  revision: z.number().int().positive(),
  status: z.enum(['answered', 'cancelled', 'expired']),
  responseId: uuidSchema.nullable(),
});
export const requestViewSchema = z.object({
  id: uuidSchema,
  turnId: uuidSchema,
  revision: z.number().int().positive(),
  prompt: text,
  answerSchema: answerDefinitionSchema,
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  expiresAt: z.string(),
  response: z.object({ id: uuidSchema, answer: answerSchema, createdAt: z.string() }).nullable(),
});
