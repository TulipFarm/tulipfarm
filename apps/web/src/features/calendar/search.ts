// The calendar route validates its search with this module, so keep date libraries out of it.
import { z } from 'zod';

export const calendarViews = ['day', 'week', 'month', 'agenda'] as const;
export type CalendarView = (typeof calendarViews)[number];
export const zoneSchema = z.string().refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export const calendarSearchSchema = z.object({
  view: z.enum(calendarViews).optional().catch(undefined),
  date: z.iso.date().optional().catch(undefined),
  zone: zoneSchema.optional().catch(undefined),
});
