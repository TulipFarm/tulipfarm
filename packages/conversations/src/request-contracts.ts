import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access';
import { textPartSchema } from './contracts.ts';

const text = textPartSchema.shape.text;
const choiceId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const choiceOption = z.strictObject({ id: choiceId, label: text.max(256), recommended: z.boolean().optional() });
const oneRecommended = (choices: { recommended?: boolean | undefined }[]) =>
  choices.filter(choice => choice.recommended).length <= 1;
/** What the agent learns from a secrets form: references, never values. Only the secrets service writes it. */
export const secretsAnswerSchema = z.strictObject({
  kind: z.literal('secrets'),
  status: z.enum(['provided', 'declined']),
  references: z
    .array(
      z.strictObject({
        referenceId: uuidSchema,
        fieldId: z.string().max(32),
        name: z.string().max(80),
        kind: z.string().max(32),
        placement: z.record(z.string(), z.unknown()),
        destinations: z.array(z.strictObject({ kind: z.enum(['host', 'endpoint']), value: z.string().max(4096) })),
      }),
    )
    .max(5),
  reason: z.string().max(500).nullable(),
});
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
  secretsAnswerSchema,
]);
export const answerDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z.strictObject({ kind: z.literal('secrets'), secretRequestId: uuidSchema }),
  z
    .strictObject({
      kind: z.literal('choices'),
      choices: z.array(choiceOption).min(1).max(1000),
      multiple: z.boolean(),
      allowText: z.boolean().optional(),
      searchable: z.boolean().optional(),
    })
    .refine(value => new Set(value.choices.map(choice => choice.id)).size === value.choices.length)
    .refine(value => oneRecommended(value.choices)),
]);
export const presentChoiceSchema = z
  .strictObject({
    tool: z.literal('present.choice'),
    prompt: text,
    choices: z.array(choiceOption).min(2).max(32).optional(),
    searchable: z.boolean().optional(),
    // The server lists the teams that can own a new table; the model never writes these options.
    from: z.literal('owner-teams').optional(),
  })
  .refine(value => (value.from ? !value.choices : Boolean(value.choices)))
  .refine(value => !value.choices || new Set(value.choices.map(choice => choice.id)).size === value.choices.length)
  .refine(value => !value.choices || oneRecommended(value.choices));
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
