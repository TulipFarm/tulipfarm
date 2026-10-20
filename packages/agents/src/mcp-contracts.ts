import { z } from 'zod';
import { sourceDependenciesSchema } from '@tulipfarm/access/source-dependencies';

export const mcpHandleSchema = z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/);
export const mcpCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('mcp.call'), handle: mcpHandleSchema, arguments: z.record(z.string(), z.json()) }),
  z.strictObject({
    tool: z.literal('mcp.search'),
    query: z.string().max(256),
    offset: z.int().min(0).max(2000).default(0),
  }),
  z.strictObject({ tool: z.literal('mcp.describe'), handle: mcpHandleSchema }),
]);
export type McpCall = z.infer<typeof mcpCallSchema>;
export const mcpCatalogEntrySchema = z.strictObject({
  handle: mcpHandleSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(32768),
  inputSchema: z.record(z.string(), z.json()),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;
export const mcpModelCatalogSchema = z.strictObject({
  discovery: z.boolean(),
  tools: z.array(mcpCatalogEntrySchema).max(16),
});
export type McpModelCatalog = z.infer<typeof mcpModelCatalogSchema>;
export const mcpExecutionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('waiting'),
    provider: z.literal('workspace-mcp'),
    actionId: z.uuid(),
    status: z.enum(['awaiting-approval', 'ready', 'dispatched', 'outcome-unknown']),
  }),
  z.strictObject({
    kind: z.literal('receipt'),
    provider: z.literal('workspace-mcp'),
    actionId: z.uuid(),
    status: z.enum(['succeeded', 'rejected', 'cancelled', 'expired', 'outcome-unknown']),
    result: z.json().nullable(),
    sources: sourceDependenciesSchema,
    observation: z.enum(['completed', 'not-performed']).optional(),
  }),
  z.strictObject({
    kind: z.literal('catalog'),
    provider: z.literal('workspace-mcp'),
    tools: z.array(mcpCatalogEntrySchema).max(16),
  }),
  z.strictObject({
    kind: z.literal('search'),
    provider: z.literal('workspace-mcp'),
    tools: z.array(mcpCatalogEntrySchema.omit({ inputSchema: true })).max(10),
    nextOffset: z.int().nullable(),
  }),
]);
export type McpExecutionResult = z.infer<typeof mcpExecutionResultSchema>;
export function isMcpTool(tool: string): tool is McpCall['tool'] {
  return tool === 'mcp.call' || tool === 'mcp.search' || tool === 'mcp.describe';
}
export function isMcpCall<T extends { tool: string }>(call: T): call is T & McpCall {
  return isMcpTool(call.tool);
}
