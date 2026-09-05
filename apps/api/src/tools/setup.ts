import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { FileToolContext } from "@tulipfarm/files";
import { FILE_TOOLS } from "@tulipfarm/files";
import type {
  KnowledgeDenialSink,
  KnowledgeService,
  PageReadAuthorizer,
} from "@tulipfarm/knowledge";
import { KNOWLEDGE_TOOLS } from "@tulipfarm/knowledge";
import type { KvService } from "@tulipfarm/kv";
import { KV_TOOLS } from "@tulipfarm/kv";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import { MEMORY_DOCUMENT_TOOLS } from "@tulipfarm/memory";
import type { RequestContext, ToolDef } from "@tulipfarm/tool-host";
import { type ParkableApiToolDefinition, toToolDef } from "@tulipfarm/tool-host";
import { ToolRegistry } from "../broker/tool-adapter";
import { FRONTEND_TOOLS } from "../platform/frontend-tools";
import { PLATFORM_TOOLS, type PlatformToolContext } from "../platform/tools";
import { readCustomInstructions } from "../preferences/custom-instructions";
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
  /** The user's Memory Document. Absent leaves `get_memory`/`update_memory` unregistered. */
  memoryDocuments?: MemoryDocumentRepo;
  kv?: KvService;
  /** The File library. Absent leaves `file_list`/`file_read` unregistered. */
  files?: FileToolContext["service"];
  knowledge?: KnowledgeService;
  /** Authorizes the exact-lookup Knowledge Tools; without it they refuse rather than serve. */
  knowledgePageGate?: PageReadAuthorizer;
  /** Records refused Knowledge writes, so path-probing leaves a trail. */
  knowledgeDenialSink?: KnowledgeDenialSink;
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
  /** Google Workspace chat ToolDefs from `tools/google/tools.ts`. */
  google?: readonly ToolDef[];
  /** Governed public web and structured API ToolDefs. */
  network?: readonly ToolDef[];
}): ToolRegistry {
  const registry = new ToolRegistry({ defaultDeny: true });

  /** Register a family while binding per-request context; declarations travel with each Tool. */
  function registerFamily<Ctx>(
    definitions: readonly ParkableApiToolDefinition<Ctx>[],
    contextFor: (ctx: RequestContext) => Ctx
  ): void {
    for (const definition of definitions) {
      registry.register(toToolDef(definition, contextFor));
    }
  }

  if (services.memoryDocuments) {
    const documents = services.memoryDocuments;
    // Standing instructions live in user-scoped KV, which `get_memory` reads alongside the
    // document. Without KV wired the field is simply absent, never a failed read.
    const kvForInstructions = services.kv;
    registerFamily(MEMORY_DOCUMENT_TOOLS, ({ userId, agentId, runId }) => ({
      businessId: DEPLOYMENT_BUSINESS_ID,
      userId,
      documents,
      agentId,
      runId,
      ...(kvForInstructions === undefined
        ? {}
        : { customInstructions: () => readCustomInstructions(kvForInstructions, userId) }),
    }));
  }

  if (services.kv) {
    const svc = services.kv;
    registerFamily(KV_TOOLS, ({ userId, agentId }) => ({ userId, agentId, service: svc }));
  }

  if (services.files) {
    const svc = services.files;
    // `principalId` is `userId` and nothing else: an Agent's reach into the library is exactly its
    // caller's, so the Agent's own identity must not widen it. A File the person cannot open stays
    // closed. `agentId` is carried beside it and read only when the Agent *writes*, to share what
    // it wrote with the Roles that Agent holds — the same audience the Worker host applies, so a
    // File does not get a different reader set depending on which host ran the Tool.
    registerFamily(FILE_TOOLS, ({ userId, agentId, runId }) => ({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: userId,
      ...(agentId === undefined ? {} : { agentId }),
      // Authority still comes from `userId` alone; the Run is recorded on what gets made, never
      // consulted for what may be read.
      ...(runId === undefined ? {} : { runId }),
      service: svc,
    }));
  }

  if (services.knowledge) {
    const svc = services.knowledge;
    const pageGate = services.knowledgePageGate;
    const denials = services.knowledgeDenialSink;
    registerFamily(
      KNOWLEDGE_TOOLS,
      ({ userId, agentId, guardrailRevision, runId, conversationId }) => ({
        userId,
        service: svc,
        pageGate,
        denials,
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
    registerFamily(AGENT_TOOLS, (requestContext) => ({
      ...ctx,
      requestContext,
      agentId: requestContext.agentId,
    }));
  }

  if (services.skillTools) {
    const ctx = services.skillTools;
    registerFamily(SKILL_TOOLS, (requestContext) => ({ ...ctx, requestContext }));
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
    // Read lazily: the registry is still being filled while this closure is created, and
    // `routine_forge` needs the finished set to name a hosted Tool a Routine cannot reach.
    const runtimeToolNames = () => new Set(registry.getAll().map((tool) => tool.name));
    registerFamily(PLATFORM_TOOLS, (reqCtx) =>
      reqCtx.routineContext
        ? {
            ...ctx,
            runtimeToolNames,
            routineContext: reqCtx.routineContext,
            requestContext: reqCtx,
          }
        : { ...ctx, runtimeToolNames, requestContext: reqCtx }
    );
  }

  // Surface/frontend Tools already read RequestContext and need no service closure.
  for (const tool of [...SURFACE_TOOLS, ...FRONTEND_TOOLS]) {
    registry.register(tool);
  }

  for (const tool of [
    ...(services.github ?? []),
    ...(services.slack ?? []),
    ...(services.google ?? []),
    ...(services.network ?? []),
  ]) {
    registry.register(tool);
  }

  return registry;
}
