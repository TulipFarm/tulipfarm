import { z } from 'zod';
export const workflowPageSearch = z.object({
  // Legacy `?workflow=` links still open; the page moves them to `/workflows/:id`.
  workflow: z.uuid().optional().catch(undefined),
  view: z.enum(['runs', 'settings']).optional().catch(undefined),
  run: z.uuid().optional().catch(undefined),
});
export type WorkflowLink = z.infer<typeof workflowPageSearch>;
export const workflowLinkKey = (link: WorkflowLink) =>
  JSON.stringify([link.workflow ?? null, link.view ?? null, link.run ?? null]);
