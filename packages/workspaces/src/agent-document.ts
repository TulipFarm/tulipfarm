import { z } from 'zod';

export const mcpPermissionSlotsSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      serverIdentity: z.string().regex(/^[a-f0-9]{64}$/),
      tools: z
        .array(z.strictObject({ name: z.string().min(1).max(256), revision: z.string().regex(/^[a-f0-9]{64}$/) }))
        .min(1)
        .max(100),
      integrationId: z.uuid().optional(),
    }),
  )
  .max(20)
  .refine(slots => new Set(slots.map(slot => slot.id)).size === slots.length, 'Duplicate MCP permission slot');

export const agentDefinitionSchema = z.strictObject({
  formatVersion: z.literal(1),
  id: z.uuid().toLowerCase(),
  name: z.string().trim().min(1).max(200),
  instructions: z.string().min(1).max(100_000),
  tools: z
    .array(
      z.enum([
        'skills.execute',
        'skills.files.read',
        'schema.inspect',
        'schema.status',
        'rows.list',
        'rows.summarize',
        'rows.resolveReference',
        'rows.reverse',
        'rows.create',
        'rows.update',
        'rows.delete',
        'agents.task.start',
        'agents.task.read',
        'github.issue.read',
        'github.personal.account',
        'github.personal.read',
        'github.personal.download',
        'github.personal.propose',
        'github.investigation.account',
        'github.investigation.repositories',
        'github.investigation.read',
        'tables.list',
        'rows.get',
        'skills.list',
        'skills.read',
        'web.fetch',
        'web.search',
        'google.read',
        'google.propose',
        'google.status',
        'google.execute',
        'slack.message.send',
        'slack.thread.reply',
        'slack.reaction.add',
        'mcp.call',
        'mcp.search',
        'mcp.describe',
        'knowledge.search',
        'knowledge.read',
        'knowledge.retrieve',
      ]),
    )
    .max(20)
    .optional(),
  modelFamilyId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,99}$/)
    .optional(),
  responseRule: z.enum(['tag', 'every-message']).optional(),
  skills: z
    .array(z.strictObject({ id: z.string().min(1).max(120), revision: z.string().min(1).max(128) }))
    .max(16)
    .optional(),
  mcp: mcpPermissionSlotsSchema.optional(),
});

export function serializeAgentDocument(input: z.input<typeof agentDefinitionSchema>): string {
  return `${JSON.stringify(agentDefinitionSchema.parse(input), null, 2)}\n`;
}
