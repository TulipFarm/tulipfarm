import {
  type McpCaller,
  McpIntegrationError,
  type McpIntegrationService,
  mcpServerRevision,
  mcpToolContract,
  mcpToolName,
} from "@tulipfarm/integrations";
import { McpError } from "@tulipfarm/mcp";
import { KillSwitchDeniedError, type MutationGuard } from "@tulipfarm/observability";
import { routineStateDefinitionRef } from "@tulipfarm/run-kernel";
import {
  ajv,
  canonicalHash,
  type McpExecutionBinding,
  type McpIntegrationDefinition,
  routine,
  type ToolContractDefinition,
  ToolContractDefinitionSchema,
} from "@tulipfarm/schema";
import { parseMcpSoulDefinition, type RuntimeBundle } from "@tulipfarm/soul";
import {
  deriveContractTargets,
  type EffectRecord,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  publishToolContract,
  type RoutineMcpAuthorization,
  ToolIntentError,
  ToolTargetDerivationError,
} from "@tulipfarm/tool-broker";
import { assertMcpRoutineUnchanged } from "../integrations/mcp-context";
import type {
  RoutineMcpBundleReader,
  RoutineMcpClaimEvidence,
  RoutineMcpLiveAuthorizer,
  RoutineMcpRunAuthority,
} from "./routine-mcp-authority";
import type { RoutineMcpDispatchFence } from "./routine-mcp-dispatch-fence";
import type { RunAuthority } from "./turn-host";

const routineSchema = ajv.compile<routine.RoutineDefinition>(routine.RoutineDefinitionSchema);
const contractSchema = ajv.compile<ToolContractDefinition>(ToolContractDefinitionSchema);

type Failure = { readonly kind: "failed" | "unavailable"; readonly reason: string };
export type RoutineMcpPreparationResult =
  | Failure
  | {
      readonly kind: "ready";
      readonly adapter: { readonly kind: "mcp"; readonly ref: string };
      readonly mcp: McpExecutionBinding;
      readonly destination?: string;
    };
export type RoutineMcpDispatchResult =
  | { readonly kind: "succeeded"; readonly output: unknown }
  | {
      readonly kind: "failed";
      readonly error: {
        readonly phase: "before_dispatch" | "after_dispatch";
        readonly code: string;
        readonly retryable: false;
      };
    };

export interface InternalRoutineMcpToolHostOptions {
  readonly businessId: string;
  readonly runs: RoutineMcpRunAuthority;
  readonly bundles: RoutineMcpBundleReader;
  readonly activeBundle: () => Promise<RuntimeBundle | undefined>;
  readonly service: Pick<McpIntegrationService<unknown>, "bind" | "callTool">;
  readonly effects: Pick<EffectStore, "get" | "listAttempts" | "listByRun">;
  readonly authorize: RoutineMcpLiveAuthorizer;
  readonly mutationGuard: MutationGuard;
  readonly dispatchFence: RoutineMcpDispatchFence;
}

interface Context {
  readonly kind: "ready";
  readonly authority: RunAuthority;
  readonly contract: ToolContractDefinition;
  readonly definition: McpIntegrationDefinition;
  readonly toolName: string;
  readonly caller: McpCaller;
  readonly destination?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InternalRoutineMcpToolHost {
  constructor(private readonly options: InternalRoutineMcpToolHostOptions) {}

  async prepare(
    runId: string,
    input: {
      readonly stateKey: string;
      readonly arguments: unknown;
      readonly claim: RoutineMcpClaimEvidence;
      readonly binding?: McpExecutionBinding;
    }
  ): Promise<RoutineMcpPreparationResult> {
    const context = await this.context(runId, input.stateKey, input.claim);
    if (context.kind !== "ready") return context;
    return this.prepareContext(context, input.arguments, input.binding);
  }

  async reauthorize(
    runId: string,
    input: {
      readonly stateKey: string;
      readonly claim: RoutineMcpClaimEvidence;
      readonly binding: McpExecutionBinding;
    }
  ): Promise<RoutineMcpAuthorization> {
    const context = await this.context(runId, input.stateKey, input.claim);
    if (context.kind !== "ready") return context;
    const effects = (await this.options.effects.listByRun(this.options.businessId, runId)).filter(
      (effect) =>
        effect.stateId === input.stateKey &&
        effect.state === "confirmed" &&
        effect.intent.mcp !== undefined &&
        canonicalHash(effect.intent.mcp) === canonicalHash(input.binding)
    );
    if (effects.length !== 1 || !this.matches(effects[0], context)) {
      return { kind: "failed", reason: "effect_binding_mismatch" };
    }
    const prepared = await this.prepareContext(context, effects[0].intent.arguments, input.binding);
    return prepared.kind === "ready" ? { kind: "allowed" } : prepared;
  }

  async dispatch(
    runId: string,
    effectId: string,
    input: { readonly attempt: number; readonly claim: RoutineMcpClaimEvidence }
  ): Promise<RoutineMcpDispatchResult> {
    const effect = await this.options.effects.get(this.options.businessId, effectId);
    if (effect === undefined || effect.runId !== runId) {
      return this.failed("before_dispatch", "effect_not_found");
    }
    const attempts = await this.options.effects.listAttempts(this.options.businessId, effectId);
    const attempt = attempts.at(-1);
    if (
      effect.state !== "dispatched" ||
      attempt?.state !== "dispatched" ||
      attempt.attempt !== input.attempt ||
      input.attempt !== 1
    ) {
      return this.failed("before_dispatch", "effect_attempt_mismatch");
    }
    const context = await this.context(runId, effect.stateId, input.claim);
    if (context.kind !== "ready") return this.failed("before_dispatch", context.reason);
    if (!this.matches(effect, context) || !record(effect.intent.arguments)) {
      return this.failed("before_dispatch", "effect_binding_mismatch");
    }
    const prepared = await this.prepareContext(context, effect.intent.arguments, effect.intent.mcp);
    if (prepared.kind !== "ready") return this.failed("before_dispatch", prepared.reason);
    try {
      await this.options.mutationGuard.assertAllowed({
        businessId: this.options.businessId,
        mutation: context.contract.spec.mutating,
        runId,
        stateId: effect.stateId,
        effectId,
        toolId: context.contract.spec.toolId,
        integrationId: context.definition.server.id,
        routineId: context.authority.routineId,
        agentId: context.authority.agent?.principalId,
        destination: context.destination,
        dataClasses: context.contract.spec.dataClasses ?? [],
      });
    } catch (error) {
      if (!(error instanceof KillSwitchDeniedError)) throw error;
      return this.failed("before_dispatch", "kill_switch_denied");
    }
    const current = await this.context(runId, effect.stateId, input.claim);
    if (current.kind !== "ready") return this.failed("before_dispatch", current.reason);
    if (
      !(await this.options.dispatchFence.claim({
        businessId: this.options.businessId,
        effectId,
        attempt: input.attempt,
        intentDigest: effect.intentDigest,
      }))
    ) {
      return this.failed("after_dispatch", "effect_already_dispatched");
    }
    try {
      const output = await this.options.service.callTool(
        prepared.mcp,
        context.caller,
        context.toolName,
        effect.intent.arguments,
        AbortSignal.timeout(120_000)
      );
      if (output.isError) return this.failed("after_dispatch", "mcp_tool_failed");
      const remaining = await this.context(runId, effect.stateId, input.claim);
      if (remaining.kind !== "ready") return this.failed("after_dispatch", remaining.reason);
      return { kind: "succeeded", output };
    } catch (error) {
      if (error instanceof McpError) {
        return this.failed(
          error.effect === "none" ? "before_dispatch" : "after_dispatch",
          error.code
        );
      }
      if (error instanceof McpIntegrationError) return this.failed("after_dispatch", error.code);
      return this.failed("after_dispatch", "mcp_request_failed");
    }
  }

  private async prepareContext(
    context: Context,
    args: unknown,
    pinned?: McpExecutionBinding
  ): Promise<RoutineMcpPreparationResult> {
    if (!record(args) || !ajv.compile(context.contract.spec.inputSchema)(args)) {
      return { kind: "failed", reason: "invalid_arguments" };
    }
    let targets: ReturnType<typeof deriveContractTargets>;
    try {
      targets = deriveContractTargets(publishToolContract(context.contract), args);
    } catch (error) {
      if (!(error instanceof ToolTargetDerivationError)) throw error;
      return { kind: "failed", reason: error.code };
    }
    if (
      !(await this.options.authorize.authorize({
        authority: context.authority,
        contract: context.contract,
        arguments: args,
        targetRefs: targets,
        destination: context.destination,
      }))
    ) {
      return { kind: "failed", reason: "authorization_revoked" };
    }
    try {
      const binding = await this.options.service.bind(
        context.definition.server.id,
        context.caller,
        { kind: "tool", name: context.toolName },
        pinned
      );
      if (binding.serverRevision !== mcpServerRevision(context.definition)) {
        return { kind: "failed", reason: "capability_changed" };
      }
      return {
        kind: "ready",
        adapter: { kind: "mcp", ref: context.definition.server.id },
        mcp: binding,
        ...(context.destination === undefined ? {} : { destination: context.destination }),
      };
    } catch (error) {
      if (!(error instanceof McpIntegrationError)) throw error;
      return { kind: "failed", reason: error.code };
    }
  }

  private async context(
    runId: string,
    stateKey: string,
    claim: RoutineMcpClaimEvidence
  ): Promise<Context | Failure> {
    const claimed = await this.options.runs.claim({
      businessId: this.options.businessId,
      runId,
      stateKey,
      claim,
    });
    if (
      claimed === undefined ||
      claimed.authority.businessId !== this.options.businessId ||
      claimed.authority.runId !== runId ||
      claimed.state.key !== stateKey ||
      claimed.state.status !== "running" ||
      claimed.bundle.digest !== claimed.authority.bundleDigest
    ) {
      return { kind: "failed", reason: "run_claim_lost" };
    }
    const { authority } = claimed;
    if (authority.source !== "routine" || authority.routineId === undefined) {
      return { kind: "failed", reason: "not_a_routine" };
    }
    const bundle = await this.options.bundles.load(this.options.businessId, authority.bundleDigest);
    if (
      bundle === undefined ||
      bundle.businessId !== this.options.businessId ||
      bundle.digest !== authority.bundleDigest
    ) {
      return { kind: "unavailable", reason: "pinned_bundle_unavailable" };
    }
    const document = bundle.getById(authority.routineId)?.document;
    if (!routineSchema(document)) return { kind: "failed", reason: "routine_definition_invalid" };
    try {
      assertMcpRoutineUnchanged(bundle, await this.options.activeBundle(), authority.routineId);
    } catch (error) {
      if (!(error instanceof McpIntegrationError)) throw error;
      return { kind: "failed", reason: "routine_configuration_changed" };
    }
    const states = document.spec.states.filter(
      (state): state is Extract<routine.RoutineState, { type: "tool" }> =>
        state.type === "tool" &&
        claimed.state.definitionRef === routineStateDefinitionRef(claimed.bundle, state.name)
    );
    if (states.length !== 1) return { kind: "failed", reason: "routine_state_mismatch" };
    const state = states[0];
    const contracts = bundle.definitions
      .filter((item) => item.kind === "ToolContract")
      .map((item) => item.document)
      .filter((item): item is ToolContractDefinition => contractSchema(item))
      .filter(
        (item) =>
          item.spec.toolId === state.toolRef.name && item.spec.toolVersion === state.toolRef.version
      );
    if (contracts.length !== 1) return { kind: "failed", reason: "unknown_contract" };
    const contract = contracts[0];
    if (contract.spec.adapter.kind !== "mcp" || contract.spec.action !== state.action) {
      return { kind: "failed", reason: "adapter_binding_mismatch" };
    }
    const serverId = contract.spec.adapter.ref;
    const asset = bundle.asset(`Integration:${serverId}`, "mcp.yaml");
    if (asset === undefined) return { kind: "unavailable", reason: "pinned_server_unavailable" };
    const definition = parseMcpSoulDefinition(asset.content, serverId);
    const tool = definition.reviewed.tools.find(
      (item) => mcpToolName(serverId, item.name) === contract.spec.toolId
    );
    if (
      !definition.enabled ||
      tool === undefined ||
      canonicalHash(mcpToolContract(serverId, mcpServerRevision(definition), tool)) !==
        canonicalHash(contract)
    ) {
      return { kind: "failed", reason: "capability_changed" };
    }
    return {
      kind: "ready",
      authority,
      contract,
      definition,
      toolName: tool.name,
      caller: { principal: authority.subject, runId, routineId: authority.routineId },
      ...(definition.server.transport.type === "streamable-http"
        ? { destination: new URL(definition.server.transport.url).origin }
        : {}),
    };
  }

  private matches(effect: EffectRecord, context: Context): boolean {
    try {
      return this.matchesIntent(effect, context);
    } catch (error) {
      if (error instanceof ToolIntentError || error instanceof ToolTargetDerivationError)
        return false;
      throw error;
    }
  }

  private matchesIntent(effect: EffectRecord, context: Context): boolean {
    const intent = normalizeToolIntent(effect.intent);
    if (
      intentDigest(intent) !== effect.intentDigest ||
      intent.intentId !== effect.effectId ||
      intent.businessId !== this.options.businessId ||
      intent.runId !== context.authority.runId ||
      intent.stateId !== effect.stateId ||
      intent.idempotencyKey !== effect.idempotencyKey ||
      intent.toolId !== context.contract.spec.toolId ||
      intent.toolVersion !== context.contract.spec.toolVersion ||
      intent.action !== context.contract.spec.action ||
      intent.principalKind !== context.authority.subject.kind ||
      intent.principalId !== context.authority.subject.id ||
      intent.agentPrincipalId !== context.authority.agent?.principalId ||
      intent.destination !== context.destination ||
      intent.mcp === undefined
    ) {
      return false;
    }
    return (
      canonicalHash(intent.targetRefs) ===
      canonicalHash(deriveContractTargets(publishToolContract(context.contract), intent.arguments))
    );
  }

  private failed(
    phase: "before_dispatch" | "after_dispatch",
    code: string
  ): RoutineMcpDispatchResult {
    return { kind: "failed", error: { phase, code, retryable: false } };
  }
}
