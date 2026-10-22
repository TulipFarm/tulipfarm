import { z } from 'zod';
import { agentDefinitionSchema } from '@tulipfarm/agents/contracts';

export const webAgentDefinitionSchema = agentDefinitionSchema.extend({
  mcp: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        serverIdentity: z.string().min(1),
        tools: z.array(z.strictObject({ name: z.string().min(1), revision: z.string().min(1) })),
        integrationId: z.string().min(1).optional(),
      }),
    )
    .max(20)
    .optional(),
});
