import { z } from 'zod';

export const calendarRangeSchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine(value => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    return span > 0 && span <= 62 * 86400000;
  }, 'Choose a calendar range of at most 62 days');

export const calendarOccurrenceSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  runId: z.uuid().optional(),
  status: z.string(),
});
export const workflowCalendarSchema = z.object({
  workflows: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      following: z.boolean(),
      personal: z.boolean(),
      enabled: z.boolean(),
      occurrences: z.array(calendarOccurrenceSchema),
      more: z.boolean(),
    }),
  ),
  actions: z.array(z.object({ workflowId: z.uuid(), runId: z.uuid(), stepId: z.string(), title: z.string() })),
  more: z.boolean(),
});
export const calendarFollowSchema = z.strictObject({ following: z.boolean() });
