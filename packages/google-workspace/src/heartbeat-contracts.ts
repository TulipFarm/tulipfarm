import { z } from 'zod';

export const heartbeatSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  cadenceMinutes: z.number().int().min(1).max(1440).default(15),
  query: z.string().max(1024).default(''),
  labelId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .nullable()
    .default(null),
  instructions: z.string().max(8000).default('Summarize this email and identify any action I should consider.'),
});
export const heartbeatCommandSchema = heartbeatSettingsSchema.extend({
  commandId: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export const heartbeatRetrySchema = z.strictObject({
  commandId: z.uuid(),
  itemId: z.uuid(),
  revision: z.number().int().positive(),
});
export const heartbeatRetryResultSchema = z.strictObject({ accepted: z.literal(true) });
export const heartbeatViewSchema = heartbeatSettingsSchema.extend({
  revision: z.number().int().nonnegative(),
  integrationId: z.uuid().nullable(),
  accountId: z.string().nullable(),
  generation: z.number().int().positive().nullable(),
  state: z.enum(['disabled', 'ready', 'reconnect-required']),
  gapNotice: z.literal('history-expired-deleted-mail-unavailable').nullable(),
  lastError: z.string().nullable(),
});
export const heartbeatPageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.uuid().optional(),
});
export const heartbeatResultSchema = z.strictObject({
  id: z.uuid(),
  messageId: z.string(),
  revision: z.number().int().positive(),
  instructions: z.string(),
  status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'cancelled']),
  answer: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const heartbeatResultsSchema = z.strictObject({
  results: z.array(heartbeatResultSchema),
  nextCursor: z.uuid().nullable(),
});
export type HeartbeatSettings = z.infer<typeof heartbeatSettingsSchema>;
export const heartbeatWorkSchema = z.strictObject({ workspaceId: z.uuid(), heartbeatId: z.uuid() });
export type HeartbeatWork = z.infer<typeof heartbeatWorkSchema>;
export class HeartbeatError extends Error {
  readonly code: 'heartbeat-conflict' | 'heartbeat-stale' | 'heartbeat-unavailable' | 'history-expired';
  constructor(code: HeartbeatError['code']) {
    super(code);
    this.code = code;
  }
}
