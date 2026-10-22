import { z } from 'zod';
export const workflowProviderSearch = z.object({
  provider: z.enum(['sheets', 'slack', 'notion', 'gmail', 'forms', 'jira', 'hubspot']).optional().catch(undefined),
});

export const workflowPageSearch = workflowProviderSearch.extend({
  workflow: z.uuid().optional().catch(undefined),
  view: z.enum(['runs']).optional().catch(undefined),
  run: z.uuid().optional().catch(undefined),
});
export type WorkflowLink = Omit<z.infer<typeof workflowPageSearch>, 'provider'>;
export const workflowLinkKey = (link: WorkflowLink) =>
  JSON.stringify([link.workflow ?? null, link.view ?? null, link.run ?? null]);
