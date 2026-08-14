/** API binding for shared `defineTool`, pinned to `ToolCallResult` with authority metadata. */

import { type DefineToolInput, defineTool, type ToolDefinition } from "@tulipfarm/tool-broker";
import type { RequestContext, ToolCallResult, ToolDef } from "./types";

export type ApiToolDefinition<Ctx> = ToolDefinition<Ctx, ToolCallResult>;

/** Declares an API Tool; `@tulipfarm/tool-broker` owns field meanings. */
export function defineApiTool<Ctx>(
  input: DefineToolInput<Ctx, ToolCallResult>
): ApiToolDefinition<Ctx> {
  return defineTool(input);
}

/** Adapts declared Tools by deriving handler context from each request. */
export function toToolDef<Ctx>(
  definition: ApiToolDefinition<Ctx>,
  contextFor: (ctx: RequestContext) => Ctx
): ToolDef {
  const inputSchemaFor = definition.inputSchemaFor;
  return {
    name: definition.name,
    tier: definition.tier,
    mutating: definition.mutating,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(inputSchemaFor === undefined
      ? {}
      : { inputSchemaFor: (ctx) => inputSchemaFor(contextFor(ctx)) }),
    ...(definition.requiresApproval === undefined
      ? {}
      : { requiresApproval: definition.requiresApproval }),
    definition: definition as ApiToolDefinition<unknown>,
    execute: (args, ctx) => definition.handler(args, contextFor(ctx)),
  };
}
