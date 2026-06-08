import type { KnowledgeService } from "../knowledge/service";
import { KNOWLEDGE_TOOLS } from "../knowledge/tools";
import type { WorkingMemoryService } from "../memory/service";
import { MEMORY_TOOLS } from "../memory/tools";
import { ToolRegistry } from "./registry";

/**
 * Builds the startup ToolRegistry by adapting module-specific tool definitions to the
 * canonical ToolDef shape. Services are closed over so only the per-request RequestContext
 * (userId, agentId) is needed at call time.
 */
export function buildToolRegistry(services: {
  workingMemory?: WorkingMemoryService;
  knowledge?: KnowledgeService;
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

  return registry;
}
