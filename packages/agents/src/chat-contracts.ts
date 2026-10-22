import { z } from 'zod';
import { toolPresentationSchema, activityStatusSchema } from '@tulipfarm/conversations/tool-activity';
import { modelUsageSchema } from '@tulipfarm/config/model-usage';
import { definitionRevisionSchema, scopeSchema, toolCallSchema, toolResultSchema } from './contracts.ts';

const modelIdentitySchema = z.object({
  familyId: z.string(),
  modelId: z.string(),
  route: z.object({
    id: z.string(),
    provider: z.enum(['anthropic', 'openai', 'xai', 'google', 'azure', 'openai-compatible']),
  }),
});
export const retryModelSchema = z.strictObject({
  requestId: z.uuid().transform(value => value.toLowerCase()),
  expectedGeneration: z.number().int().nonnegative().max(2147483646),
});
export const retryModelReceiptSchema = z.object({
  requestId: z.uuid(),
  runId: z.uuid(),
  generation: z.number().int().nonnegative(),
});
export const modelAttemptReceiptSchema = z.object({
  id: z.uuid(),
  ordinal: z.number().int(),
  role: z.enum(['primary', 'fallback']),
  status: z.enum(['running', 'succeeded', 'failed', 'abandoned']),
  resolution: modelIdentitySchema,
  usage: modelUsageSchema,
  cost: z.unknown(),
  outcome: z
    .object({
      kind: z.enum(['success', 'failure', 'late']),
      reason: z.string().optional(),
      actualModel: z.string().nullable().optional(),
      requestId: z.string().nullable().optional(),
      status: z.number().nullable().optional(),
    })
    .nullable(),
});
export const modelExecutionReceiptSchema = z.object({
  generation: z.number().int(),
  status: z.enum(['pending', 'running', 'failed', 'committed']),
  failure: z.string().nullable(),
  deadline: z.iso.datetime(),
  winner: z.uuid().nullable(),
  bundleId: z.string(),
  activationRevision: z.number().int(),
  preferred: modelIdentitySchema,
  attempts: z.array(modelAttemptReceiptSchema),
});

export const chatInputSchema = z.strictObject({
  id: z.uuid(),
  activationId: z.uuid(),
  scope: scopeSchema,
  prompt: z.string().trim().min(1).max(8000),
});
export const chatReceiptSchema = z.object({
  id: z.uuid(),
  revision: definitionRevisionSchema,
  status: z.enum(['pending', 'selecting', 'tool', 'answered', 'failed']),
});
export const chatStatusSchema = chatReceiptSchema.extend({
  text: z.string().nullable(),
  call: z.union([toolCallSchema, z.null()]),
  presentation: toolPresentationSchema.optional(),
  activityStatus: activityStatusSchema.optional(),
  execution: z
    .object({ status: z.enum(['pending', 'completed', 'waiting', 'blocked', 'failed']), result: toolResultSchema })
    .nullable(),
  model: modelExecutionReceiptSchema.nullable().optional(),
});
