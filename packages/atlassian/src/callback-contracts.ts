import { z } from 'zod';

export const accountProtocolSchema = z.enum(['atlassian-mcp', 'atlassian-rest', 'trello']);
export type AccountProtocol = z.infer<typeof accountProtocolSchema>;
export const accountCallbackResultSchema = z.object({
  outcome: z.enum(['connected', 'denied', 'error', 'sign-in-required']),
  workspaceId: z.uuid().optional(),
  protocol: accountProtocolSchema.optional(),
});
