import { type ToolSet, jsonSchema, tool } from "ai";
import { type RequestContext, type ToolCallResult, type ToolDef, err } from "./types";

export const TOOL_TIMEOUT_MS = 30_000;

function withToolTimeout(p: Promise<ToolCallResult>): Promise<ToolCallResult> {
  return Promise.race([
    p,
    new Promise<ToolCallResult>((resolve) =>
      setTimeout(() => resolve(err("internal_error", "tool execution timed out")), TOOL_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Central in-process tool registry (TOOL-V1). All registered tools are exposed to the LLM
 * (ALLOW_ALL / AC-V1-004). Call buildToolSet() per request to get a Vercel AI SDK ToolSet with
 * 30-second per-call timeouts enforced.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  getAll(): ToolDef[] {
    return [...this.tools.values()];
  }

  buildToolSet(ctx: RequestContext): ToolSet {
    return Object.fromEntries(
      this.getAll().map((t) => [
        t.name,
        tool({
          description: t.description,
          parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: (args: unknown) => withToolTimeout(t.execute(args, ctx)),
        }),
      ])
    );
  }
}
