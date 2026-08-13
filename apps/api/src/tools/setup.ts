import { ToolRegistry } from "../broker/tool-adapter";
import type { KnowledgeService } from "../knowledge/service";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import type { KvService } from "../kv/service";
import { KV_TOOLS } from "../kv/tools";
import type { MemoryLifecycleService } from "../memory/lifecycle-service";
import type { MemoryRecallService } from "../memory/recall-service";
import type { MemoryService } from "../memory/service";
import {
  MEMORY_TOOLS,
  recallMemoryTool,
  rememberCorrectionTool,
  type ToolContext,
} from "../memory/tools";
import { FRONTEND_TOOLS } from "../platform/frontend-tools";
import { PLATFORM_TOOLS, type PlatformToolContext } from "../platform/tools";
import { RESOURCE_TOOLS, type ResourceServices } from "../resources/tools.js";
import { AGENT_TOOLS, type AgentToolContext } from "../soul/agents/tools.js";
import { RESOURCE_TYPE_TOOLS, type ResourceTypeToolContext } from "../soul/resource-types/tools.js";
import { SKILL_TOOLS, type SkillToolContext } from "../soul/skills/tools.js";
import {
  SURFACE_COMPONENT_TOOLS,
  type SurfaceComponentToolContext,
} from "../soul/surface-components/tools.js";
import { SURFACE_TOOLS } from "../surfaces/tools";
import { type ApiToolDefinition, toToolDef } from "./define";
import type { RequestContext, ToolDef } from "./types";

/**
 * Builds the startup ToolRegistry by adapting module-specific tool definitions to the
 * canonical ToolDef shape. Services are closed over so only the per-request RequestContext
 * (userId, agentId) is needed at call time.
 */
export function buildToolRegistry(services: {
  memory?: MemoryService;
  /** Durable relevance recall. Absent leaves `recall_memory` reporting itself unavailable. */
  memoryRecall?: MemoryRecallService;
  /** Procedural corrections and forget/erase. Absent leaves `remember_correction` unregistered. */
  memoryLifecycle?: MemoryLifecycleService;
  kv?: KvService;
  knowledge?: KnowledgeService;
  resources?: ResourceServices;
  resourceTypes?: ResourceTypeToolContext;
  agentTools?: AgentToolContext;
  skillTools?: SkillToolContext;
  surfaceComponents?: SurfaceComponentToolContext;
  platform?: PlatformToolContext;
  /** GitHub chat tool family — pre-built ToolDefs (see `tools/github/tools.ts`'s `buildGitHubTools`).
   * Registered unconditionally when GitHub composition is available; per-turn visibility is gated
   * separately on live install status (`chat/turn-helpers.ts`), not on registration. */
  github?: readonly ToolDef[];
  /** Slack chat tool family — pre-built ToolDefs (see `tools/slack/tools.ts`'s `buildSlackTools`). */
  slack?: readonly ToolDef[];
}): ToolRegistry {
  const registry = new ToolRegistry({ defaultDeny: true });

  /**
   * Registers a family, binding the per-request context its handlers were written against.
   *
   * Every family previously repeated this loop with its own hand-written `ToolDef` literal, which
   * is how tier, `requiresApproval` and the authorization declaration could drift apart from the
   * Tool they described. The declaration now travels with the Tool, so registration has nothing
   * left to restate.
   */
  function registerFamily<Ctx>(
    definitions: readonly ApiToolDefinition<Ctx>[],
    contextFor: (ctx: RequestContext) => Ctx
  ): void {
    for (const definition of definitions) {
      registry.register(toToolDef(definition, contextFor));
    }
  }

  if (services.memory) {
    const svc = services.memory;
    const recall = services.memoryRecall;
    const lifecycle = services.memoryLifecycle;
    // A tool that cannot run should not be offered: without the service it needs wired, the tool is
    // left unregistered rather than registered to report itself unavailable.
    const unavailable = new Set<ApiToolDefinition<ToolContext>>();
    if (recall === undefined) unavailable.add(recallMemoryTool);
    if (lifecycle === undefined) unavailable.add(rememberCorrectionTool);
    registerFamily(
      MEMORY_TOOLS.filter((t) => !unavailable.has(t)),
      ({ userId, agentId }) => ({
        userId,
        service: svc,
        agentId,
        ...(recall === undefined ? {} : { recall }),
        ...(lifecycle === undefined ? {} : { lifecycle }),
      })
    );
  }

  if (services.kv) {
    const svc = services.kv;
    registerFamily(KV_TOOLS, ({ userId, agentId }) => ({ userId, agentId, service: svc }));
  }

  if (services.knowledge) {
    const svc = services.knowledge;
    registerFamily(
      KNOWLEDGE_TOOLS,
      ({ userId, agentId, guardrailRevision, runId, conversationId }) => ({
        userId,
        service: svc,
        agentId,
        guardrailRevision,
        runId,
        conversationId,
      })
    );
  }

  if (services.resources) {
    const res = services.resources;
    registerFamily(RESOURCE_TOOLS, ({ userId, agentId }) => ({ ...res, userId, agentId }));
  }

  if (services.resourceTypes) {
    const ctx = services.resourceTypes;
    registerFamily(RESOURCE_TYPE_TOOLS, () => ctx);
  }

  if (services.agentTools) {
    const ctx = services.agentTools;
    registerFamily(AGENT_TOOLS, () => ctx);
  }

  if (services.skillTools) {
    const ctx = services.skillTools;
    registerFamily(SKILL_TOOLS, () => ctx);
  }

  if (services.surfaceComponents) {
    const ctx = services.surfaceComponents;
    registerFamily(SURFACE_COMPONENT_TOOLS, () => ctx);
  }

  if (services.platform !== undefined) {
    const ctx = services.platform;
    // routineContext is per-call (routine-spawned headless turns), not a service — merge it from
    // the RequestContext so call_skill/complete_state see the run they belong to.
    registerFamily(PLATFORM_TOOLS, (reqCtx) =>
      reqCtx.routineContext
        ? { ...ctx, routineContext: reqCtx.routineContext, requestContext: reqCtx }
        : { ...ctx, requestContext: reqCtx }
    );
  }

  // Surface and frontend Tools read the per-request RequestContext directly (client context) and
  // return client-action descriptors, so they are already `ToolDef`s with no services to close over.
  for (const tool of [...SURFACE_TOOLS, ...FRONTEND_TOOLS]) {
    registry.register(tool);
  }

  for (const tool of [...(services.github ?? []), ...(services.slack ?? [])]) {
    registry.register(tool);
  }

  return registry;
}
