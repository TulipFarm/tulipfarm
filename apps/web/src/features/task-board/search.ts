import { z } from 'zod';

export const taskShows = ['all', 'mine', 'agents'] as const;
export type TaskShow = (typeof taskShows)[number];

/** The Tasks page address: the open task, who to show, and the title search. */
export const taskBoardSearchSchema = z.object({
  task: z.uuid().optional().catch(undefined),
  show: z.enum(taskShows).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
});
export type TaskBoardSearch = z.infer<typeof taskBoardSearchSchema>;
