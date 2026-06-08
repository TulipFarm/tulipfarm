import { ajv } from "@tulipfarm/validation";
import { type ToolSet, jsonSchema, tool } from "ai";
import type { BatchCoordinator } from "./batch-executor";
import { truncateResult } from "./truncate";
import { type RequestContext, type ToolCallResult, type ToolDef, err } from "./types";

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

function firstArgError(errors: AjvErrors): string {
  const e = errors?.[0];
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

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
  private readonly validators = new Map<string, ReturnType<typeof ajv.compile>>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, ajv.compile(tool.inputSchema));
  }

  getAll(): ToolDef[] {
    return [...this.tools.values()];
  }

  buildToolSet(
    ctx: RequestContext,
    coordinator?: BatchCoordinator,
    fullResultCache?: Map<string, ToolCallResult>
  ): ToolSet {
    return Object.fromEntries(
      this.getAll().map((t) => [
        t.name,
        tool({
          description: t.description,
          parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (args: unknown, opts: { toolCallId: string }) => {
            const v = this.validators.get(t.name) ?? ajv.compile(t.inputSchema);
            if (!v(args)) return err("validation_error", firstArgError(v.errors));
            const full = await (coordinator
              ? coordinator.schedule(() => withToolTimeout(t.execute(args, ctx)), t.mutating)
              : withToolTimeout(t.execute(args, ctx)));
            fullResultCache?.set(opts.toolCallId, full);
            return truncateResult(full);
          },
        }),
      ])
    );
  }
}
