import { createHash } from "node:crypto";
import {
  type McpCaller,
  type McpExecutionBinding,
  McpIntegrationError,
  type McpIntegrationService,
  mcpServerRevision,
  mcpToolContract,
  mcpToolName,
} from "@tulipfarm/integrations";
import { McpError } from "@tulipfarm/mcp";
import type { MutationGuard } from "@tulipfarm/observability";
import { ajv, canonicalHash } from "@tulipfarm/schema";
import type { CommitActor } from "@tulipfarm/soul";
import {
  AdapterDispatchError,
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  type ToolAdapterRequest,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import {
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallPreparationPort,
  type ToolDef,
  ToolPreparationDeniedError,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../../broker/tool-adapter";

type Preparation = Parameters<ToolCallPreparationPort["prepare"]>[0];
type McpIntent = ToolIntent & { readonly mcp: McpExecutionBinding };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(...parts: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface McpToolSyncDeps {
  readonly registry: ToolRegistry;
  readonly service: McpIntegrationService<CommitActor>;
  readonly businessId: string;
  readonly effects: EffectStore;
  readonly mutationGuard: MutationGuard;
  readonly callerForRun: (input: {
    readonly runId: string;
    readonly principal: { readonly kind: string; readonly id: string };
  }) => Promise<McpCaller>;
}

export class McpToolSync implements ToolCallPreparationPort {
  private registered = new Map<
    string,
    { serverId: string; name: string; revision: string; tool: ToolDef }
  >();

  constructor(private readonly deps: McpToolSyncDeps) {}

  sync(): number {
    const next = new Map<
      string,
      { serverId: string; name: string; revision: string; tool: ToolDef }
    >();
    for (const definition of this.deps.service.list()) {
      if (!definition.enabled) continue;
      const serverId = definition.server.id;
      const revision = mcpServerRevision(definition);
      for (const reviewed of definition.reviewed.tools) {
        const name = mcpToolName(serverId, reviewed.name);
        const contract = mcpToolContract(serverId, revision, reviewed);
        const declared = defineApiTool<RequestContext>({
          name,
          tier: "integration",
          description: contract.spec.description ?? name,
          inputSchema: reviewed.inputSchema,
          outputSchema: contract.spec.outputSchema,
          mutating: reviewed.mutating,
          sideEffecting: reviewed.mutating,
          requiresApproval: reviewed.requiresApproval || reviewed.mutating,
          requiresAmbient: ["provider-credentials", "soul"],
          provider: serverId,
          credentialMode: "service",
          version: contract.spec.toolVersion,
          riskClass: contract.spec.riskClass,
          idempotency: contract.spec.idempotency.strategy,
          retry: { maxAttempts: 1, safeToRetry: false },
          timeout: contract.spec.timeout,
          authorization: {
            action: contract.spec.action,
            resources: ["integration"],
            targets: () => [{ type: "integration", id: serverId }],
            dataClasses: contract.spec.dataClasses,
          },
          handler: async (args, context) => {
            const binding = context.toolIntent?.mcp;
            if (!binding || !context.toolIntent || !context.runId || !context.toolCallId) {
              return err("write_denied", "MCP calls require a host-prepared account binding.");
            }
            if (binding.serverId !== serverId || binding.serverRevision !== revision) {
              return err("write_denied", "The approved MCP server revision changed.");
            }
            if (
              context.toolIntent.toolId !== name ||
              context.toolIntent.toolVersion !== contract.spec.toolVersion ||
              context.toolIntent.runId !== context.runId ||
              canonicalHash(context.toolIntent.arguments) !== canonicalHash(args)
            ) {
              return err(
                "write_denied",
                "The prepared MCP call does not match its approved arguments."
              );
            }
            const caller = await this.deps.callerForRun({
              runId: context.runId,
              principal: context.subject ?? { kind: "user", id: context.userId },
            });
            try {
              await this.deps.service.bind(
                serverId,
                caller,
                { kind: "tool", name: reviewed.name },
                binding
              );
            } catch (error) {
              if (error instanceof McpIntegrationError)
                return err("write_denied", `${error.code}: ${error.message}`);
              throw error;
            }
            const intent = context.toolIntent;
            const effect = await this.deps.effects.reserve({
              effectId: uuid("mcp-effect", context.runId, context.toolCallId, name),
              businessId: this.deps.businessId,
              runId: context.runId,
              stateId: intent.stateId,
              logicalEffectOrdinal: 0,
              idempotencyKey: intent.idempotencyKey,
              intentDigest: intentDigest(intent),
              intent,
              guardrailRevision: context.guardrailRevision ?? "none",
              createdAt: new Date().toISOString(),
            });
            if (effect.outcome === "duplicate" && effect.effect.state === "confirmed") {
              return effect.effect.outputStored
                ? ok(effect.effect.output)
                : err("internal_error", "The confirmed MCP effect has no stored output.");
            }
            const dispatcher = new EffectDispatcher({
              store: this.deps.effects,
              catalog: ToolCatalog.load([contract]),
              mutationGuard: this.deps.mutationGuard,
              mutationIdentity: {
                integrationId: serverId,
                ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
                ...(caller.routineId === undefined ? {} : { routineId: caller.routineId }),
              },
              adapters: new Map([
                [
                  serverId,
                  {
                    kind: "mcp" as const,
                    dispatch: async (request: ToolAdapterRequest) => {
                      if (!record(args)) {
                        throw new AdapterDispatchError(
                          "before_dispatch",
                          "invalid_arguments",
                          false
                        );
                      }
                      try {
                        const output = await this.deps.service.callTool(
                          binding,
                          caller,
                          reviewed.name,
                          args,
                          request.abortSignal
                        );
                        if (output.isError) {
                          throw new AdapterDispatchError(
                            "after_dispatch",
                            "mcp_tool_failed",
                            false
                          );
                        }
                        return output;
                      } catch (error) {
                        if (error instanceof AdapterDispatchError) throw error;
                        throw new AdapterDispatchError(
                          error instanceof McpError && error.effect === "none"
                            ? "before_dispatch"
                            : "after_dispatch",
                          error instanceof McpIntegrationError || error instanceof McpError
                            ? error.code
                            : "mcp_request_failed",
                          false
                        );
                      }
                    },
                  },
                ],
              ]),
            });
            try {
              return ok(
                await dispatcher.dispatch(
                  this.deps.businessId,
                  effect.effect.effectId,
                  context.abortSignal
                )
              );
            } catch (error) {
              if (!(error instanceof ToolDispatchError)) throw error;
              if (error.code === "ambiguous" || error.code === "dispatch_in_progress") {
                return err(
                  "indeterminate",
                  "The MCP action may have happened. Do not retry it automatically."
                );
              }
              return err(
                error.code === "kill_switch_denied" ? "write_denied" : "internal_error",
                error.detail ?? error.code
              );
            }
          },
        });
        next.set(name, {
          serverId,
          name: reviewed.name,
          revision,
          tool: toToolDef(declared, (context) => context),
        });
      }
    }
    for (const [name, entry] of next) {
      if (
        !this.registered.has(name) &&
        this.deps.registry.getAll().some((tool) => tool.name === name)
      ) {
        throw new Error(`MCP Tool name collision: ${name}`);
      }
      ajv.compile(entry.tool.inputSchema);
    }
    for (const name of this.registered.keys()) this.deps.registry.unregister(name);
    for (const entry of next.values()) {
      this.deps.registry.register(entry.tool);
    }
    this.registered = next;
    return next.size;
  }

  countFor(serverId: string): number {
    return [...this.registered.values()].filter((entry) => entry.serverId === serverId).length;
  }

  async prepare(input: Preparation) {
    const entry = this.registered.get(input.tool.name);
    if (!entry) return undefined;
    const definition = entry.tool.definition;
    if (!definition) throw new ToolPreparationDeniedError("MCP Tool declaration is missing.");
    const caller = await this.deps.callerForRun({ runId: input.runId, principal: input.subject });
    let binding: McpExecutionBinding;
    try {
      binding = await this.deps.service.bind(
        entry.serverId,
        caller,
        { kind: "tool", name: entry.name },
        input.pinnedIntent?.mcp
      );
    } catch (error) {
      if (!(error instanceof McpIntegrationError)) throw error;
      throw new ToolPreparationDeniedError(
        `${error.code}: ${error.message}`,
        `/integrations/${entry.serverId}`
      );
    }
    if (binding.serverRevision !== entry.revision) {
      throw new ToolPreparationDeniedError("MCP server changed. Refresh available Tools.");
    }
    const intent: McpIntent = {
      intentId: uuid("mcp-intent", input.runId, input.toolCallId, input.tool.name),
      businessId: input.businessId,
      runId: input.runId,
      stateId: `mcp:${input.toolCallId}`,
      runStateId: input.stateId,
      toolId: input.tool.name,
      toolVersion: definition.version,
      action: definition.authorization.action,
      targetRefs: definition.targetsFor(input.arguments),
      arguments: input.arguments,
      principalKind: input.subject.kind,
      principalId: input.subject.id,
      ...(input.agent.principalId === undefined
        ? {}
        : { agentPrincipalId: input.agent.principalId }),
      ...(input.activeSkillName === undefined ? {} : { activeSkillName: input.activeSkillName }),
      mcp: binding,
      idempotencyKey: uuid("mcp-idempotency", input.runId, input.toolCallId, input.tool.name),
    };
    if (input.pinnedIntent && canonicalHash(input.pinnedIntent) !== canonicalHash(intent)) {
      throw new ToolPreparationDeniedError(
        "The approved MCP account, capability or arguments changed."
      );
    }
    return { intent, definition };
  }
}
