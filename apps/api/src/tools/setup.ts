import type { KnowledgeService } from "@tulipfarm/knowledge";
import { KNOWLEDGE_TOOLS } from "@tulipfarm/knowledge";
import type { KvService } from "@tulipfarm/kv";
import { KV_TOOLS } from "@tulipfarm/kv";
import type { MemoryLifecycleService, MemoryRecallService, MemoryService } from "@tulipfarm/memory";
import {
  MEMORY_TOOLS,
  recallMemoryTool,
  rememberCorrectionTool,
  type ToolContext,
} from "@tulipfarm/memory";
import type { RequestContext, ToolDef } from "@tulipfarm/tool-host";
import { type ApiToolDefinition, toToolDef } from "@tulipfarm/tool-host";
import { ToolRegistry } from "../broker/tool-adapter";
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
import { TASK_TOOLS, type TaskToolContext } from "../tasks/tools";

/** Build the startup ToolRegistry; handlers close over services and receive RequestContext. */
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
  /** `task_create`/`task_close`; absent leaves both unregistered. */
  tasks?: TaskToolContext;
  /** GitHub ToolDefs; registered when composed, with live install visibility gated per turn. */
  github?: readonly ToolDef[];
  /** Slack chat ToolDefs from `tools/slack/tools.ts`. */
  slack?: readonly ToolDef[];
}): ToolRegistry {
  const registry = new ToolRegistry({ defaultDeny: true });

  /** Register a family while binding per-request context; declarations travel with each Tool. */
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
    // Do not offer a Tool whose required service is absent.
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

  if (services.tasks) {
    const ctx = services.tasks;
    registerFamily(TASK_TOOLS, ({ agentId, runId }) => ({ ...ctx, agentId, runId }));
  }

  if (services.platform !== undefined) {
    const ctx = services.platform;
    // `routineContext` is per-call; merge it so routine Tools see their Run.
    registerFamily(PLATFORM_TOOLS, (reqCtx) =>
      reqCtx.routineContext
        ? { ...ctx, routineContext: reqCtx.routineContext, requestContext: reqCtx }
        : { ...ctx, requestContext: reqCtx }
    );
  }

  // Surface/frontend Tools already read RequestContext and need no service closure.
  for (const tool of [...SURFACE_TOOLS, ...FRONTEND_TOOLS]) {
    registry.register(tool);
  }

  for (const tool of [...(services.github ?? []), ...(services.slack ?? [])]) {
    registry.register(tool);
  }

  return registry;
}
