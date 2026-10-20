import { z } from 'zod';
import { tableQueryRequestSchema, tableQuerySchema } from './query.ts';

/** Browser-safe contract for natural-language table search. Translation never executes the row or summary query. */
export const translationLimits = { promptCharacters: 2000, choices: 6, messageCharacters: 500 } as const;

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
export const translationTimezoneSchema = z.string().min(1).max(64).refine(validTimezone, 'Expected an IANA time zone');

export const tableQueryTranslationRequestSchema = z.strictObject({
  requestId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  prompt: z.string().trim().min(1).max(translationLimits.promptCharacters),
  timezone: translationTimezoneSchema,
  current: tableQueryRequestSchema.optional(),
});
export type TableQueryTranslationRequest = z.infer<typeof tableQueryTranslationRequestSchema>;

const message = z.string().min(1).max(translationLimits.messageCharacters);
export const translationChoiceSchema = z.object({
  label: z.string().min(1).max(300),
  prompt: z.string().min(1).max(translationLimits.promptCharacters),
});

export const translatedQuerySchema = z.object({
  requestId: z.uuid(),
  status: z.literal('query'),
  query: tableQuerySchema,
  rsql: z.string(),
  references: z.record(z.uuid(), z.string()),
  interpretation: z.string(),
});
export const translationClarificationSchema = z.object({
  requestId: z.uuid(),
  status: z.literal('clarification'),
  message,
  choices: z.array(translationChoiceSchema).max(translationLimits.choices),
});
export const translationUnsupportedSchema = z.object({
  requestId: z.uuid(),
  status: z.literal('unsupported'),
  message,
});
/** A finished translation. Only `query` may be submitted, and the browser still executes it through `POST /query`. */
export const tableQueryTranslationResultSchema = z.discriminatedUnion('status', [
  translatedQuerySchema,
  translationClarificationSchema,
  translationUnsupportedSchema,
]);
export type TableQueryTranslationResult = z.infer<typeof tableQueryTranslationResultSchema>;

/** Receipt recovery adds states with no result: still running, failed, or provider outcome unknown. */
export const translationProgressSchema = z.object({
  requestId: z.uuid(),
  status: z.enum(['pending', 'failed', 'uncertain']),
  message: message.optional(),
});
export const tableQueryTranslationStatusSchema = z.discriminatedUnion('status', [
  translatedQuerySchema,
  translationClarificationSchema,
  translationUnsupportedSchema,
  translationProgressSchema.extend({ status: z.literal('pending') }),
  translationProgressSchema.extend({ status: z.literal('failed') }),
  translationProgressSchema.extend({ status: z.literal('uncertain') }),
]);
export type TableQueryTranslationStatus = z.infer<typeof tableQueryTranslationStatusSchema>;

export const translationErrorCodes = [
  'invalid-request',
  'insufficient-credits',
  'table-unavailable',
  'stale-revision',
  'request-mismatch',
  'rate-limited',
  'translation-unavailable',
] as const;
export type TranslationErrorCode = (typeof translationErrorCodes)[number];
export const translationErrorSchema = z.object({ error: z.enum(translationErrorCodes) });
export const translationErrorStatus: Record<TranslationErrorCode, 400 | 402 | 404 | 409 | 429 | 503> = {
  'invalid-request': 400,
  'insufficient-credits': 402,
  'table-unavailable': 404,
  'stale-revision': 409,
  'request-mismatch': 409,
  'rate-limited': 429,
  'translation-unavailable': 503,
};
