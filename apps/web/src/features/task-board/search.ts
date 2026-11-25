import { z } from 'zod';

export const taskShows = ['all', 'mine', 'agents'] as const;
export type TaskShow = (typeof taskShows)[number];

/** The Tasks page address: who to show, the search, and `task`, an old row link that opens the task's page. */
export const taskBoardSearchSchema = z.object({
  task: z.uuid().optional().catch(undefined),
  show: z.enum(taskShows).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
});
export type TaskBoardSearch = z.infer<typeof taskBoardSearchSchema>;

/** A task page keeps the board's filters for the way back. */
export const taskPageSearchSchema = taskBoardSearchSchema.omit({ task: true });
export type TaskPageSearch = z.infer<typeof taskPageSearchSchema>;
