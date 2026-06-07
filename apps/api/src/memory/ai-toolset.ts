import { type ToolSet, jsonSchema, tool } from "ai";
import { MEMORY_TOOLS, type ToolContext } from "./tools";

/**
 * Adapts the platform memory tools to the Vercel AI SDK tool loop. Each tool's `execute` closes
 * over the per-request {@link ToolContext} (userId + service), so writes are scoped to the
 * authenticated user. The returned `ToolCallResult` becomes the tool-result content the model sees,
 * so validation/oversize rejections come back as results the model can react to — never throws.
 */
export function buildMemoryToolSet(ctx: ToolContext): ToolSet {
  return Object.fromEntries(
    MEMORY_TOOLS.map((t) => [
      t.name,
      tool({
        description: t.description,
        parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: (args: unknown) => t.handler(args, ctx),
      }),
    ])
  );
}
