import { ToolRegistry } from "../broker/tool-adapter";
import type { KnowledgeService } from "../knowledge/service";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import type { KvService } from "../kv/service";
import { KV_TOOLS } from "../kv/tools";
import type { WorkingMemoryService } from "../memory/service";
import { MEMORY_TOOLS } from "../memory/tools";
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

/**
 * Builds the startup ToolRegistry by adapting module-specific tool definitions to the
 * canonical ToolDef shape. Services are closed over so only the per-request RequestContext
 * (userId, agentId) is needed at call time.
 */
export function buildToolRegistry(services: {
  workingMemory?: WorkingMemoryService;
  kv?: KvService;
  knowledge?: KnowledgeService;
  resources?: ResourceServices;
  resourceTypes?: ResourceTypeToolContext;
  agentTools?: AgentToolContext;
  skillTools?: SkillToolContext;
  surfaceComponents?: SurfaceComponentToolContext;
  platform?: PlatformToolContext;
}): ToolRegistry {
  const registry = new ToolRegistry({ defaultDeny: true });

  if (services.workingMemory) {
    const svc = services.workingMemory;
    for (const t of MEMORY_TOOLS) {
      registry.register({
        name: t.name,
        tier: "platform",
        mutating: t.mutating,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, { userId, agentId }) => t.handler(args, { userId, service: svc, agentId }),
      });
    }
  }

  if (services.kv) {
    const svc = services.kv;
    for (const t of KV_TOOLS) {
      registry.register({
        name: t.name,
        tier: "platform",
        mutating: t.mutating,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, { userId, agentId }) => t.handler(args, { userId, agentId, service: svc }),
      });
    }
  }

  if (services.knowledge) {
    const svc = services.knowledge;
    for (const t of KNOWLEDGE_TOOLS) {
      registry.register({
        name: t.name,
        tier: "platform",
        mutating: t.mutating,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, { userId, agentId }) => t.handler(args, { userId, service: svc, agentId }),
      });
    }
  }

  if (services.resources) {
    const res = services.resources;
    for (const t of RESOURCE_TOOLS) {
      registry.register({
        name: t.name,
        tier: "system",
        mutating: t.mutating,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, { userId, agentId }) => t.handler(args, { ...res, userId, agentId }),
      });
    }
  }

  if (services.resourceTypes) {
    const ctx = services.resourceTypes;
    for (const t of RESOURCE_TYPE_TOOLS) {
      registry.register({
        name: t.name,
        tier: "system",
        mutating: t.mutating,
        requiresApproval: false, // soul write — never gated (AGT-V1-001)
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, _ctx) => t.handler(args, ctx),
      });
    }
  }

  if (services.agentTools) {
    const ctx = services.agentTools;
    for (const t of AGENT_TOOLS) {
      registry.register({
        name: t.name,
        tier: "system",
        mutating: t.mutating,
        requiresApproval: false, // soul write — never gated (AGT-V1-001)
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, _ctx) => t.handler(args, ctx),
      });
    }
  }

  if (services.skillTools) {
    const ctx = services.skillTools;
    for (const t of SKILL_TOOLS) {
      registry.register({
        name: t.name,
        tier: "system",
        mutating: t.mutating,
        requiresApproval: false, // soul write — never gated (AGT-V1-001)
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, _ctx) => t.handler(args, ctx),
      });
    }
  }

  if (services.surfaceComponents) {
    const ctx = services.surfaceComponents;
    for (const t of SURFACE_COMPONENT_TOOLS) {
      registry.register({
        name: t.name,
        tier: "system",
        mutating: t.mutating,
        requiresApproval: false,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, _ctx) => t.handler(args, ctx),
      });
    }
  }

  if (services.platform !== undefined) {
    const ctx = services.platform;
    for (const t of PLATFORM_TOOLS) {
      registry.register({
        name: t.name,
        tier: "platform",
        mutating: t.mutating,
        description: t.description,
        inputSchema: t.inputSchema,
        // routineContext is per-call (routine-spawned headless turns), not a service —
        // merge it from the RequestContext so call_skill/complete_state see their run.
        execute: (args, reqCtx) =>
          t.handler(
            args,
            reqCtx.routineContext
              ? { ...ctx, routineContext: reqCtx.routineContext, requestContext: reqCtx }
              : { ...ctx, requestContext: reqCtx }
          ),
      });
    }
  }

  for (const tool of SURFACE_TOOLS) {
    registry.register(tool);
  }

  // Frontend tools are already ToolDefs — they read the per-request RequestContext directly
  // (client context) and return client-action descriptors. No services to close over.
  for (const t of FRONTEND_TOOLS) {
    registry.register(t);
  }

  return registry;
}
