import { type ToolSet, jsonSchema, tool } from "ai";
import { KNOWLEDGE_TOOLS, type KnowledgeToolContext } from "./tools";

/**
 * Adapts the platform knowledge tools (KN-V1-006) to the Vercel AI SDK tool loop,
 * mirroring `buildMemoryToolSet`. Each tool's `execute` closes over the per-request
 * {@link KnowledgeToolContext}; handlers return a `ToolResult` the model can react to
 * and never throw.
 */
export function buildKnowledgeToolSet(ctx: KnowledgeToolContext): ToolSet {
  return Object.fromEntries(
    KNOWLEDGE_TOOLS.map((t) => [
      t.name,
      tool({
        description: t.description,
        parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: (args: unknown) => t.handler(args, ctx),
      }),
    ])
  );
}
