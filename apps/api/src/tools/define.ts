/**
 * The API app's binding to the shared Tool framework (`@tulipfarm/tool-broker`'s `defineTool`).
 *
 * `packages/tool-broker` cannot import this app, so `defineTool` is generic over its result type.
 * This module pins that generic to `ToolCallResult` once, so every tool module writes
 * `defineApiTool({...})` instead of repeating the type arguments, and adapts the result into the
 * `ToolDef` the registry and the AI SDK already speak.
 *
 * The adaptation is deliberately thin. A tool's handler keeps its own context type and its module
 * keeps closing over its own services; all that is added is the authorization declaration travelling
 * alongside, where the gate can reach it. That is what makes the migration of the whole tool surface
 * behaviour-preserving.
 */

import { type DefineToolInput, defineTool, type ToolDefinition } from "@tulipfarm/tool-broker";
import type { RequestContext, ToolCallResult, ToolDef } from "./types";

export type ApiToolDefinition<Ctx> = ToolDefinition<Ctx, ToolCallResult>;

/** Declares a Tool in this app. See `@tulipfarm/tool-broker`'s `defineTool` for the field meanings. */
export function defineApiTool<Ctx>(
  input: DefineToolInput<Ctx, ToolCallResult>
): ApiToolDefinition<Ctx> {
  return defineTool(input);
}

/**
 * Adapts a declared Tool into the registry shape, binding the per-request context it needs.
 *
 * `contextFor` is where a module's closed-over services meet the per-request identity. Keeping it a
 * function rather than a fixed object is what lets a module thread `RequestContext` fields (the
 * caller, the Run, the routine it was spawned by) into a handler that was written against its own
 * context type, without every module having to agree on one shape.
 */
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
