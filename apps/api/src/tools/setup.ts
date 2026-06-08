import type { KnowledgeService } from "../knowledge/service";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import type { WorkingMemoryService } from "../memory/service";
import { MEMORY_TOOLS } from "../memory/tools";
import { RESOURCE_TOOLS, type ResourceServices } from "../resources/tools.js";
import { RESOURCE_TYPE_TOOLS, type ResourceTypeToolContext } from "../soul/resource-types/tools.js";
import { ToolRegistry } from "./registry";

/**
 * Builds the startup ToolRegistry by adapting module-specific tool definitions to the
 * canonical ToolDef shape. Services are closed over so only the per-request RequestContext
 * (userId, agentId) is needed at call time.
 */
export function buildToolRegistry(services: {
  workingMemory?: WorkingMemoryService;
  knowledge?: KnowledgeService;
  resources?: ResourceServices;
  resourceTypes?: ResourceTypeToolContext;
}): ToolRegistry {
  const registry = new ToolRegistry();

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
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (args, _ctx) => t.handler(args, ctx),
      });
    }
  }

  return registry;
}
