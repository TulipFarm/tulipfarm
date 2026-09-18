import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  accountDefinitionForIntegration,
  type McpAccountAccess,
  type McpCaller,
  type McpChatAccountContext,
  McpIntegrationError,
  McpIntegrationService,
  mcpServerRevision,
  mcpToolContract,
} from "@tulipfarm/integrations";
import { ArtifactService, TypedOutputValidator } from "@tulipfarm/run-kernel";
import {
  ajv,
  canonicalHash,
  MCP_SETUP_TOOL_DECLARATIONS,
  type McpCapabilityReview,
  McpCapabilityReviewSchema,
  type McpConfigure,
  McpConfigureSchema,
  type McpExecutionBinding,
} from "@tulipfarm/schema";
import { normalizeToolIntent, PgEffectStore } from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  InMemoryToolCatalog,
  LiveToolGate,
  ok,
  RegistryToolDispatcher,
  type RequestContext,
  ToolApprovalService,
  ToolPreparationDeniedError,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { TurnWaitPort } from "@tulipfarm/turn-executor";
import type { L3McpFixture } from "../case.ts";
import type { EvalSoul } from "../eval-soul.ts";
import type { EvalDatabase } from "./database.ts";
import { evalMcpAccounts } from "./mcp-accounts.ts";
import { evalMcpSession } from "./mcp-provider.ts";
import type { SoulWriterTool } from "./soul-write.ts";

const isConfigure = ajv.compile<McpConfigure>(McpConfigureSchema);
const isReview = ajv.compile<McpCapabilityReview>(McpCapabilityReviewSchema);

function isPromptArguments(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export interface EvalMcpState {
  providerToolCalls: number;
  readonly accounts: Awaited<ReturnType<typeof evalMcpAccounts>>;
  readonly approvals: ToolApprovalService;
  readonly effects: PgEffectStore;
}

export async function createEvalMcpState(
  database: EvalDatabase,
  soul: EvalSoul,
  conversationId: string,
  fixture?: L3McpFixture
): Promise<EvalMcpState> {
  await database.query(
    "INSERT INTO users (id, status, role) VALUES ('eval', 'active', 'admin') ON CONFLICT DO NOTHING"
  );
  return {
    providerToolCalls: 0,
    accounts: await evalMcpAccounts(database, soul, conversationId, fixture),
    approvals: new ToolApprovalService({
      transactions: database.transactions,
      now: () => new Date(),
    }),
    effects: new PgEffectStore(database.transactions),
  };
}

export interface EvalMcpTools {
  readonly port: ToolDispatchPort;
  readonly names: readonly string[];
  readonly waits: TurnWaitPort;
  approvePending(runId: string): Promise<boolean>;
}

export async function evalMcpTools(options: {
  readonly soul: EvalSoul;
  readonly soulWrites: SoulWriterTool;
  readonly state: EvalMcpState;
  readonly runId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly fixture?: L3McpFixture;
}): Promise<EvalMcpTools> {
  const definitions = await options.soulWrites.mcpDefinitions();
  const caller: McpCaller = {
    principal: { kind: "user", id: "eval" },
    conversationId: options.conversationId,
    runId: options.runId,
  };
  const context = (serverId: string, pinned?: McpExecutionBinding): McpChatAccountContext => {
    const definition = definitions.get(serverId);
    if (definition === undefined) throw new Error(`No active MCP definition for ${serverId}.`);
    const { definitionDigest } = accountDefinitionForIntegration(definition);
    return {
      kind: "chat",
      businessId: "eval",
      integrationKey: serverId,
      definitionDigest,
      conversationId: options.conversationId,
      principalId: "eval",
      visibility: options.fixture?.visibility ?? "private",
      ...(pinned?.accountId === undefined || pinned.accountId === null
        ? {}
        : {
            pinned: {
              accountId: pinned.accountId,
              accountRevision: Number(pinned.accountRevision),
              definitionDigest,
            },
          }),
    };
  };
  const revalidate = async (binding: McpExecutionBinding) => {
    await options.state.accounts.authority.resolve(context(binding.serverId, binding));
  };
  const accounts: McpAccountAccess = {
    bind: async (input) => {
      const account = await options.state.accounts.authority.resolve(
        context(input.server.id, input.pinned)
      );
      return {
        serverId: input.server.id,
        serverRevision: input.serverRevision,
        accountId: account.id,
        accountRevision: String(account.revision),
        subjectId: caller.principal.id,
        authorizationId: canonicalHash({
          conversationId: options.conversationId,
          principalId: caller.principal.id,
          visibility: options.fixture?.visibility ?? "private",
        }),
      };
    },
    revalidate,
    use: async (binding, server, callback) =>
      callback(
        evalMcpSession(
          binding,
          server,
          () => revalidate(binding),
          () => {
            options.state.providerToolCalls += 1;
          }
        )
      ),
  };
  const service = new McpIntegrationService(definitions, accounts, {
    record: async () => {},
  });
  const actor = { principalId: "user:eval", name: "Eval", email: "eval@tulipfarm.local" };
  const catalog = new InMemoryToolCatalog();
  for (const declaration of MCP_SETUP_TOOL_DECLARATIONS) {
    const validate = ajv.compile(declaration.inputSchema);
    const definition = defineApiTool<RequestContext>({
      ...declaration,
      tier: "system",
      authorization: {
        action: declaration.mutating ? "integration.connect" : "integration.read",
        resources: ["integration"],
        dataClasses: ["soul_definition"],
      },
      requiresApproval: declaration.mutating,
      handler: async (input, request) => {
        if (!validate(input)) {
          return err("validation_error", "The Integration arguments are invalid.");
        }
        if (declaration.name === "integration_list") return ok({ servers: service.list() });
        if (
          typeof input !== "object" ||
          input === null ||
          !("slug" in input) ||
          typeof input.slug !== "string"
        ) {
          throw new Error("MCP setup needs a slug.");
        }
        if (declaration.name === "integration_get") return ok({ server: service.get(input.slug) });
        if (declaration.name === "integration_configure") {
          if (!("configuration" in input) || !isConfigure(input.configuration)) {
            throw new Error("MCP setup needs a valid configuration.");
          }
          return ok({ server: await service.configure(input.slug, input.configuration, actor) });
        }
        if (declaration.name === "integration_discover") {
          return ok({
            capabilities: await service.discover(input.slug, caller, request.abortSignal),
          });
        }
        if (declaration.name === "integration_review") {
          if (!("capabilities" in input) || !isReview(input.capabilities)) {
            throw new Error("MCP review needs valid capabilities.");
          }
          return ok({
            server: await service.review(input.slug, input.capabilities, caller, actor),
          });
        }
        if (declaration.name === "integration_resource_read") {
          if (!("uri" in input) || typeof input.uri !== "string") {
            throw new Error("MCP resource read needs a URI.");
          }
          return ok(await service.readResource(input.slug, caller, input.uri, request.abortSignal));
        }
        if (declaration.name === "integration_prompt_render") {
          if (!("name" in input) || typeof input.name !== "string") {
            throw new Error("MCP prompt rendering needs a prompt name.");
          }
          const args = "arguments" in input ? (input.arguments ?? {}) : {};
          if (!isPromptArguments(args)) throw new Error("MCP prompt arguments must be strings.");
          return ok(
            await service.renderPrompt(input.slug, caller, input.name, args, request.abortSignal)
          );
        }
        throw new Error("No production MCP setup handler for the declared Tool.");
      },
    });
    catalog.register(toToolDef(definition, (request) => request));
  }
  const reviewed = new Map<string, { serverId: string; capability: string }>();
  for (const server of service.list()) {
    for (const tool of server.reviewed.tools) {
      const contract = mcpToolContract(server.server.id, mcpServerRevision(server), tool);
      const definition = defineApiTool<RequestContext>({
        name: contract.spec.toolId,
        description: contract.spec.description ?? tool.name,
        inputSchema: tool.inputSchema,
        tier: "integration",
        version: contract.spec.toolVersion,
        mutating: tool.mutating,
        requiresApproval: tool.requiresApproval,
        idempotency: tool.mutating ? "reconcile" : "none",
        retry: { maxAttempts: 1, safeToRetry: false },
        authorization: {
          action: contract.spec.action,
          resources: ["integration"],
          targets: () => [{ type: "integration", id: server.server.id }],
          dataClasses: contract.spec.dataClasses,
        },
        handler: async (args, request) => {
          const binding = request.toolIntent?.mcp;
          if (binding === undefined) throw new Error("MCP Tool has no prepared account binding.");
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            throw new Error("MCP arguments must be an object.");
          }
          return ok(
            await service.callTool(
              binding,
              caller,
              tool.name,
              args as Record<string, unknown>,
              request.abortSignal
            )
          );
        },
      });
      reviewed.set(definition.name, { serverId: server.server.id, capability: tool.name });
      catalog.register(toToolDef(definition, (request) => request));
    }
  }
  const dispatcher = new RegistryToolDispatcher({
    registry: catalog,
    soulLoader: options.soul.loader,
    artifacts: new ArtifactService(
      {
        find: async () => null,
        put: async () => {
          throw new Error("MCP fixture does not publish request Artifacts.");
        },
        appendLineage: async () => {
          throw new Error("MCP fixture does not publish lineage.");
        },
      },
      new TypedOutputValidator([])
    ),
    approvals: options.state.approvals,
    effects: options.state.effects,
    gate: new LiveToolGate(),
    authorityLayers: {
      resolvePrincipalLayer: async () => ({
        name: "eval-participant",
        grants: [
          { effect: "allow", action: "integration.connect", resourceType: "integration" },
          { effect: "allow", action: "integration.read", resourceType: "integration" },
          { effect: "allow", action: "integration.execute", resourceType: "integration" },
        ],
      }),
    },
    preparation: {
      prepare: async (input) => {
        const tool = reviewed.get(input.tool.name);
        if (tool === undefined) return undefined;
        const definition = input.tool.definition;
        if (definition === undefined) throw new Error("MCP Tool has no contract.");
        let binding: McpExecutionBinding;
        try {
          binding = await service.bind(
            tool.serverId,
            caller,
            { kind: "tool", name: tool.capability },
            input.pinnedIntent?.mcp
          );
        } catch (error) {
          if (!(error instanceof McpIntegrationError)) throw error;
          throw new ToolPreparationDeniedError(error.message);
        }
        const identity = canonicalHash([input.runId, input.toolCallId, input.tool.name]);
        return {
          definition,
          intent: normalizeToolIntent({
            intentId: identity,
            businessId: input.businessId,
            runId: input.runId,
            stateId: `chat:${input.toolCallId}`,
            runStateId: input.stateId,
            toolId: input.tool.name,
            toolVersion: definition.version,
            action: definition.authorization.action,
            targetRefs: [{ type: "integration", id: tool.serverId }],
            arguments: input.arguments,
            principalKind: input.subject.kind,
            principalId: input.subject.id,
            mcp: binding,
            idempotencyKey: identity,
          }),
        };
      },
    },
  });
  return {
    names: catalog.getAll().map((tool) => tool.name),
    port: {
      dispatch: async (call) => ({
        ...(await dispatcher.dispatch(
          {
            businessId: "eval",
            runId: options.runId,
            turn: { id: options.turnId, conversationId: options.conversationId, attempt: 1 },
            subject: caller.principal,
            source: "chat",
            bundleDigest: "sha256:eval",
            agent: { name: options.agentId },
          },
          call
        )),
        callId: call.callId,
      }),
    },
    waits: {
      register: (input) =>
        options.state.approvals.registerWait({
          ...input,
          subject: { kind: "user", id: "eval" },
        }),
    },
    approvePending: async (runId) => {
      const pending = await options.state.approvals.pendingForRun(runId);
      if (
        pending === null ||
        pending === undefined ||
        !catalog.getAll().some((tool) => tool.name === pending.toolName)
      )
        return false;
      if (options.fixture?.revokeGrantBeforeApproval !== undefined) {
        await options.state.accounts.accounts.revokeGrant(
          "eval",
          options.fixture.revokeGrantBeforeApproval,
          "user",
          "eval"
        );
      }
      return (
        (await options.state.approvals.signal({
          businessId: "eval",
          approvalId: pending.approvalId,
          decision: "approved",
          principal: "user:eval",
        })) === "resumed"
      );
    },
  };
}
