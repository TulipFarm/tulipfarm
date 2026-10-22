import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { cronTriggerSchema, intervalTriggerSchema } from '@tulipfarm/workflows/contracts';
import { definitionRevisionSchema } from './contracts.ts';
import { taskLimitsSchema, taskReceiptSchema } from './task-contracts.ts';

export const inspectionActivationSchema = z.strictObject({
  id: uuidSchema,
  revision: definitionRevisionSchema,
  tableId: uuidSchema,
});

/** A scheduled task starts a private task owned by the sponsor, so it runs at most hourly and only the sponsor reads its history. */
export const taskScheduleMinimumMinutes = 60;
export const scheduleTriggerSchema = z.discriminatedUnion('kind', [intervalTriggerSchema, cronTriggerSchema]);
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

export const scheduleActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspect'), tableId: uuidSchema }),
  z.strictObject({ kind: z.literal('task'), text: z.string().trim().min(1).max(8000), limits: taskLimitsSchema }),
]);
export type ScheduleAction = z.infer<typeof scheduleActionSchema>;

export const scheduleInputSchema = z.strictObject({
  id: uuidSchema,
  activationId: uuidSchema,
  action: scheduleActionSchema,
  trigger: scheduleTriggerSchema,
  sponsorMembershipId: uuidSchema,
  historyAudience: z.array(uuidSchema).max(100),
});

const toolCallStatusSchema = z.enum(['pending', 'completed', 'waiting', 'blocked', 'failed']);
export const scheduleLastRunSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inspection'), status: toolCallStatusSchema }),
  z.strictObject({ kind: z.literal('task'), taskId: uuidSchema, status: taskReceiptSchema.shape.status }),
  z.strictObject({ kind: z.literal('skipped'), reason: z.string().min(1).max(100) }),
]);
export const schedulePauseReasonSchema = z.enum(['sponsor-access-lost', 'scheduled-call-denied']);
export type SchedulePauseReason = z.infer<typeof schedulePauseReasonSchema>;

export const scheduleSchema = scheduleInputSchema.extend({
  revision: definitionRevisionSchema,
  nextRunAt: z.string(),
  revoked: z.boolean(),
  enabled: z.boolean(),
  lastRun: scheduleLastRunSchema.nullable(),
  sponsorMembershipId: uuidSchema.nullable(),
  paused: z.boolean(),
  pauseReason: schedulePauseReasonSchema.nullable(),
});
export const agentCalendarSchema = z.object({
  schedules: z.array(
    z.object({
      id: uuidSchema,
      agentId: uuidSchema,
      name: z.string(),
      times: z.array(z.iso.datetime()),
      more: z.boolean(),
    }),
  ),
  more: z.boolean(),
});
