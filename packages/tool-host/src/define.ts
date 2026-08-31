/** API binding for shared `defineTool`, pinned to `ToolCallResult` with authority metadata. */

import { type DefineToolInput, defineTool, type ToolDefinition } from "@tulipfarm/tool-broker";
import type { ParkableToolCallResult, RequestContext, ToolCallResult, ToolDef } from "./types";

export type ApiToolDefinition<Ctx> = ToolDefinition<Ctx, ToolCallResult>;

/** A Tool that may suspend its Turn on durable work instead of answering. */
export type ParkableApiToolDefinition<Ctx> = ToolDefinition<Ctx, ParkableToolCallResult>;

/** Declares an API Tool; `@tulipfarm/tool-broker` owns field meanings. */
export function defineApiTool<Ctx>(
  input: DefineToolInput<Ctx, ToolCallResult>
): ApiToolDefinition<Ctx> {
  return defineTool(input);
}

/**
 * Declares an API Tool allowed to park.
 *
 * Separate from `defineApiTool` so parking stays opt-in: a Tool that cannot park keeps the
 * two-member result and narrows as it always did, and the ones that can are greppable.
 */
export function defineParkableApiTool<Ctx>(
  input: DefineToolInput<Ctx, ParkableToolCallResult>
): ParkableApiToolDefinition<Ctx> {
  return defineTool(input);
}

/** Adapts declared Tools by deriving handler context from each request. */
export function toToolDef<Ctx, Result extends ParkableToolCallResult = ToolCallResult>(
  definition: ToolDefinition<Ctx, Result>,
  contextFor: (ctx: RequestContext) => Ctx
): ToolDef<Result> {
  const inputSchemaFor = definition.inputSchemaFor;
  return {
    name: definition.name,
    tier: definition.tier,
    mutating: definition.mutating,
    ...(definition.sideEffecting === undefined ? {} : { sideEffecting: definition.sideEffecting }),
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
