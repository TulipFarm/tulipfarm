import {
  type AuthorityLayer,
  compileGuardrailPolicy,
  compileRoutineAuthority,
  type GuardrailPolicy,
  GuardrailPolicyError,
} from "@tulipfarm/authz";
import type { MutationGuard } from "@tulipfarm/observability";
import {
  ajv,
  canonicalHash,
  type GuardrailDefinition,
  type McpExecutionBinding,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import { ToolBroker } from "./broker";
import { ToolCatalog, ToolCatalogError } from "./catalog";
import type { CredentialDispatcher } from "./credential-dispatch";
import {
  EffectDispatchDeferredError,
  EffectDispatcher,
  type EffectRecord,
  type EffectRetryParker,
  type EffectRetryParkInput,
  type EffectRetryWaitReader,
  type EffectStore,
  type ToolAdapter,
  ToolDispatchError,
} from "./effects";
import { intentDigest, normalizeToolIntent, type ToolIntent, type ToolTargetRef } from "./intent";
import { deriveContractTargets, ToolTargetDerivationError } from "./targets";

/** Routine Tool authority: pinned bundle only; authorize, reserve, then dispatch fail-closed. */

export type RoutineToolOutcome =
  /** Dispatched and confirmed, or replayed with the first immutable provider result. */
  | { readonly kind: "succeeded"; readonly output: unknown }
  /**
   * A definitive negative the authored `onError` path may claim, named by its reason code.
   *
   * Tool failures are always terminal for the `retry` policy: the effect ledger keys an effect by
   * its `(run, state)` occurrence, so a re-dispatch replays this same confirmed result rather than
   * re-running the provider. A genuinely transient fault never lands here — it surfaces as
   * `unavailable`/`effect_ambiguous` and parks for reconciliation, which is its own durable retry.
   */
  | { readonly kind: "failed"; readonly reason: string }
  /** Policy requires a human. The approval id is the durable wait's correlation point. */
  | { readonly kind: "awaiting_approval"; readonly reason: string; readonly approvalId: string }
  /** The provider requested a retry that is now owned by a durable Run timer. */
  | ({ readonly kind: "waiting" } & Pick<
      EffectRetryParkInput,
      "effectId" | "attempt" | "notBefore" | "reason" | "delayMs"
    > & { readonly waitId: string })
  /** Nothing decided the call. The State parks for reconciliation rather than guessing. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineToolDispatchPlan {
  readonly toolRef: { readonly name: string; readonly version: string };
  readonly action: string;
  readonly arguments: unknown;
  readonly destination?: string;
  readonly credentialRef?: string;
  readonly idempotencyKey: string;
  readonly effectId: string;
  readonly logicalEffectOrdinal: number;
}

export interface RoutineToolBundle {
  readonly digest: string;
  readonly definitions: readonly {
    readonly kind: string;
    readonly document: unknown;
  }[];
}

export interface RoutineToolRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key; the ledger's `state_id`. */
  readonly stateKey: string;
  /** Existing Run claim fence. The API verifies both values against live storage. */
  readonly claim: {
    readonly leaseOwner: string;
    readonly leaseGeneration: number;
  };
  readonly signal?: AbortSignal;
  readonly plan: RoutineToolDispatchPlan;
  /** The persisted Run subject whose authority proposed this effect. */
  readonly requesterPrincipalId: string;
  /** The Run's exact pinned bundle — the only source of contracts and policy. */
  readonly bundle: RoutineToolBundle;
  /** Extra layers cannot widen past the pinned ToolContracts' own authority. */
  readonly authorityLayers: readonly AuthorityLayer[];
}

export interface RoutineToolPort {
  execute(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
  /**
   * Validates and returns only a previously confirmed immutable effect.
   *
   * This path never prepares an adapter, reserves an effect, consumes an Approval, or dispatches.
   */
  replaySettled(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
}

export type RoutineMcpPreparation =
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly arguments: Record<string, unknown>;
      readonly adapterRef: string;
      readonly adapter: ToolAdapter;
      readonly hostCredentials: true;
      readonly mcp: McpExecutionBinding;
      readonly destination?: string;
    };

export type RoutineMcpAuthorization =
  | { readonly kind: "allowed" }
  | { readonly kind: "failed" | "unavailable"; readonly reason: string };

export interface RoutineMcpPreparationPort {
  prepare(request: RoutineToolRequest, pinnedIntent?: ToolIntent): Promise<RoutineMcpPreparation>;
  revalidate(
    request: RoutineToolRequest,
    binding: McpExecutionBinding
  ): Promise<RoutineMcpAuthorization>;
}

export interface RoutineToolApprovalPort {
  findIntent?(input: {
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }): Promise<ToolIntent | undefined>;
  decide(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly requesterPrincipalId: string;
    readonly demand: {
      readonly demandedBy:
        | "guardrail_rule"
        | "sandbox_contract"
        | "autonomy_policy"
        | "tool_contract";
      readonly guardrailRevision: string;
      readonly reason: string;
      readonly ruleId?: string;
    };
    readonly intent?: ToolIntent;
  }): Promise<
    | { readonly status: "approved"; readonly approvalId: string }
    | { readonly status: "denied"; readonly reason: string }
    | { readonly status: "pending"; readonly approvalId: string }
  >;
  consume(input: { readonly approvalId: string; readonly toolCallId: string }): Promise<boolean>;
}

export interface BrokerRoutineToolPortOptions {
  readonly effects: EffectStore;
  readonly approvals: RoutineToolApprovalPort;
  /** Keyed by `ToolContract.adapter.ref`, exactly as `EffectDispatcher` resolves them. */
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials?: CredentialDispatcher;
  /** Bundle-scoped adapters are built only from the Run's verified immutable package. */
  readonly adaptersFor?: (request: RoutineToolRequest) => ReadonlyMap<string, ToolAdapter>;
  readonly credentialsFor?: (request: RoutineToolRequest) => CredentialDispatcher | undefined;
  /** Account resolution stays API-side; only immutable bindings and a remote adapter cross back. */
  readonly mcp?: RoutineMcpPreparationPort;
  /** Provider retries must park on the Run's durable wait store. */
  readonly parkRetry?: EffectRetryParker;
  readonly retryWaitStatus?: EffectRetryWaitReader;
  /** Emergency stop over mutating effects; absent leaves Routine Tools ungoverned. */
  readonly mutationGuard?: MutationGuard;
  /** Preserves the caller's ownership-loss semantics without importing the Run kernel. */
  readonly assertActive: (signal: AbortSignal | undefined) => void;
  /** Host-specific platform Credential scoping; MCP accounts are resolved by the API host. */
  readonly credentialRefFor?: (request: RoutineToolRequest) => string | undefined;
  readonly now?: () => Date;
}

function definitionsOf<T>(bundle: RoutineToolBundle, kind: string): T[] {
  return bundle.definitions
    .filter((definition) => definition.kind === kind)
    .map((definition) => definition.document as unknown as T);
}

function intentOf(
  request: RoutineToolRequest,
  targetRefs: readonly ToolTargetRef[],
  prepared: Extract<RoutineMcpPreparation, { readonly kind: "ready" }> | undefined,
  credentialRefFor: ((request: RoutineToolRequest) => string | undefined) | undefined
): ToolIntent {
  const { plan } = request;
  const credentialRef =
    prepared === undefined ? (credentialRefFor?.(request) ?? plan.credentialRef) : undefined;
  const separator = request.requesterPrincipalId.indexOf(":");
  const principalKind =
    separator < 1 ? undefined : request.requesterPrincipalId.slice(0, separator);
  const principalId = separator < 1 ? undefined : request.requesterPrincipalId.slice(separator + 1);
  return {
    // Derived from Run and State occurrence, so replay proposes the same intent.
    intentId: plan.effectId,
    businessId: request.businessId,
    runId: request.runId,
    stateId: request.stateKey,
    toolId: plan.toolRef.name,
    toolVersion: plan.toolRef.version,
    action: plan.action,
    targetRefs,
    arguments: prepared?.arguments ?? plan.arguments,
    ...(principalKind === undefined || principalId === undefined
      ? {}
      : {
          principalKind,
          principalId,
          ...(principalKind === "agent" ? { agentPrincipalId: principalId } : {}),
        }),
    ...(prepared === undefined ? {} : { mcp: prepared.mcp }),
    ...((prepared?.destination ?? plan.destination) === undefined
      ? {}
      : { destination: prepared?.destination ?? plan.destination }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    idempotencyKey: plan.idempotencyKey,
  };
}

/**
 * The objects this call will touch, taken from the pinned ToolContract's own declaration.
 *
 * An unknown contract derives nothing on purpose: the broker owns that refusal and answers it as
 * `unknown_contract`, which is a better answer than a derivation failure for the same cause.
 */
function targetsOf(catalog: ToolCatalog, request: RoutineToolRequest): readonly ToolTargetRef[] {
  const contract = catalog.get(request.plan.toolRef.name, request.plan.toolRef.version);
  if (contract === undefined) return [];
  return deriveContractTargets(contract, request.plan.arguments);
}

/** Replay durable effects; only reconciliation may resolve `ambiguous`. */
function replayed(effect: EffectRecord): RoutineToolOutcome {
  switch (effect.state) {
    case "confirmed":
      return effect.outputStored
        ? { kind: "succeeded", output: effect.output }
        : { kind: "unavailable", reason: "confirmed_effect_output_unavailable" };
    case "denied":
      return { kind: "failed", reason: "effect_denied" };
    case "failed":
      return { kind: "failed", reason: "effect_failed" };
    default:
      return { kind: "unavailable", reason: `effect_${effect.state}` };
  }
}

function requestMatchesEffect(request: RoutineToolRequest, effect: EffectRecord): boolean {
  return (
    effect.businessId === request.businessId &&
    effect.runId === request.runId &&
    effect.stateId === request.stateKey &&
    effect.guardrailRevision === request.bundle.digest &&
    effect.idempotencyKey === request.plan.idempotencyKey &&
    effect.intent.toolId === request.plan.toolRef.name &&
    effect.intent.toolVersion === request.plan.toolRef.version &&
    effect.intent.action === request.plan.action &&
    canonicalHash(effect.intent.arguments) === canonicalHash(request.plan.arguments) &&
    `${effect.intent.principalKind}:${effect.intent.principalId}` === request.requesterPrincipalId
  );
}

export class BrokerRoutineToolPort implements RoutineToolPort {
  private readonly now: () => Date;
  /** Per-bundle, because a bundle is immutable: compiling it twice can only produce the same. */
  private readonly policies = new Map<string, GuardrailPolicy>();
  private readonly catalogs = new Map<string, ToolCatalog>();
  private readonly authorities = new Map<string, AuthorityLayer>();

  constructor(private readonly options: BrokerRoutineToolPortOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async replaySettled(request: RoutineToolRequest): Promise<RoutineToolOutcome> {
    this.options.assertActive(request.signal);
    const existing = await this.options.effects.get(request.businessId, request.plan.effectId);
    if (existing === undefined) return { kind: "unavailable", reason: "effect_not_found" };
    const replay = await this.existingOutcome(request, existing, true);
    return replay ?? { kind: "unavailable", reason: "effect_not_confirmed" };
  }

  async execute(request: RoutineToolRequest): Promise<RoutineToolOutcome> {
    this.options.assertActive(request.signal);
    const existing = await this.options.effects.get(request.businessId, request.plan.effectId);
    if (existing !== undefined) {
      const replay = await this.existingOutcome(request, existing, false);
      if (replay !== undefined) return replay;
    }
    let policy: GuardrailPolicy;
    let catalog: ToolCatalog;
    try {
      policy = this.policyFor(request.bundle);
      catalog = this.catalogFor(request.bundle);
    } catch (error) {
      // If the authored policy/contract cannot be expressed exactly, park instead of guessing.
      if (error instanceof GuardrailPolicyError) {
        return { kind: "unavailable", reason: `guardrail_${error.code}` };
      }
      if (error instanceof ToolCatalogError) {
        return { kind: "unavailable", reason: error.code };
      }
      throw error;
    }

    const contract = catalog.get(request.plan.toolRef.name, request.plan.toolRef.version);
    let prepared: Extract<RoutineMcpPreparation, { readonly kind: "ready" }> | undefined;
    if (contract?.adapter.kind === "mcp") {
      if (this.options.mcp === undefined) {
        return { kind: "unavailable", reason: "mcp_host_unavailable" };
      }
      if (request.plan.credentialRef !== undefined) {
        return { kind: "failed", reason: "mcp_account_binding_required" };
      }
      const resolution = await this.options.mcp.prepare(request, existing?.intent);
      this.options.assertActive(request.signal);
      if (resolution.kind === "failed" || resolution.kind === "unavailable") return resolution;
      if (resolution.kind === "ready") {
        if (
          resolution.adapterRef !== contract.adapter.ref ||
          resolution.adapter.kind !== contract.adapter.kind
        ) {
          return { kind: "unavailable", reason: "adapter_binding_mismatch" };
        }
        prepared = resolution;
      }
    }

    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = targetsOf(
        catalog,
        prepared === undefined
          ? request
          : { ...request, plan: { ...request.plan, arguments: prepared.arguments } }
      );
    } catch (error) {
      // A contract that declares a target the call cannot name must be refused, never widened to a
      // Tool-granular decision by handing the gate an empty target list.
      if (error instanceof ToolTargetDerivationError) {
        return { kind: "failed", reason: error.code };
      }
      throw error;
    }

    const intent = normalizeToolIntent(
      intentOf(request, targetRefs, prepared, this.options.credentialRefFor)
    );
    const outcome = new ToolBroker(catalog).authorize(intent, {
      authorityLayers: [...request.authorityLayers, this.authorityFor(request.bundle)],
      guardrailRules: policy.rules,
      dlpRules: policy.dlpRules,
      // The pinned bundle digest is the Guardrail revision; nothing live may replace it.
      guardrailRevision: request.bundle.digest,
      taint: "untrusted",
      autonomy: "execute_policy_authorized",
      now: this.now(),
    });
    if (outcome.outcome === "denied") return { kind: "failed", reason: outcome.reason };
    if (existing !== undefined) {
      if (
        outcome.outcome === "awaiting_approval" &&
        (existing.approvalId === undefined ||
          !(await this.approvalMatches(request, existing.intentDigest)))
      ) {
        return { kind: "unavailable", reason: "approval_evidence_mismatch" };
      }
      if (outcome.intentDigest !== existing.intentDigest) {
        return { kind: "unavailable", reason: "effect_binding_changed" };
      }
      if (existing.approvalId !== undefined) {
        const consumable = await this.consumeApproval(request, existing.approvalId);
        if (!consumable) return { kind: "failed", reason: "approval_not_consumable" };
      }
      return this.dispatchEffect(request, catalog, prepared);
    }

    let approvalId: string | undefined;
    if (outcome.outcome === "awaiting_approval") {
      const decision = await this.options.approvals.decide({
        businessId: request.businessId,
        runId: request.runId,
        toolCallId: request.plan.effectId,
        toolName: request.plan.toolRef.name,
        args: request.plan.arguments,
        requesterPrincipalId: request.requesterPrincipalId,
        demand: {
          demandedBy: outcome.demand?.requiredBy ?? "guardrail_rule",
          guardrailRevision: request.bundle.digest,
          reason: outcome.demand?.reason ?? "unattributed",
          ...(outcome.demand?.ruleId === undefined ? {} : { ruleId: outcome.demand.ruleId }),
        },
        intent,
      });
      this.options.assertActive(request.signal);
      if (decision.status === "pending") {
        return {
          kind: "awaiting_approval",
          reason: "approval_required",
          approvalId: decision.approvalId,
        };
      }
      if (decision.status === "denied") {
        return { kind: "failed", reason: decision.reason };
      }
      approvalId = decision.approvalId;
    }

    const reserved = await this.options.effects.reserve({
      effectId: request.plan.effectId,
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateKey,
      logicalEffectOrdinal: request.plan.logicalEffectOrdinal,
      idempotencyKey: request.plan.idempotencyKey,
      intentDigest: outcome.intentDigest,
      intent,
      guardrailRevision: request.bundle.digest,
      ...(approvalId === undefined ? {} : { approvalId }),
      createdAt: this.now().toISOString(),
    });
    this.options.assertActive(request.signal);
    if (reserved.outcome === "duplicate") {
      if (reserved.effect.intentDigest !== outcome.intentDigest) {
        return { kind: "unavailable", reason: "effect_binding_changed" };
      }
      if (reserved.effect.state !== "authorized" && reserved.effect.state !== "dispatched") {
        return (
          (await this.existingOutcome(request, reserved.effect, false)) ?? {
            kind: "unavailable",
            reason: "effect_not_confirmed",
          }
        );
      }
    }
    if (approvalId !== undefined) {
      if (!(await this.consumeApproval(request, approvalId))) {
        await this.options.effects.transition({
          businessId: reserved.effect.businessId,
          effectId: reserved.effect.effectId,
          expectedStates: ["authorized"],
          state: "denied",
          updatedAt: this.now().toISOString(),
        });
        return { kind: "failed", reason: "approval_not_consumable" };
      }
    }

    return this.dispatchEffect(request, catalog, prepared);
  }

  private async existingOutcome(
    request: RoutineToolRequest,
    existing: EffectRecord,
    settledOnly: boolean
  ): Promise<RoutineToolOutcome | undefined> {
    try {
      const storedIntent = normalizeToolIntent(existing.intent);
      if (intentDigest(storedIntent) !== existing.intentDigest) {
        await this.quarantine(existing);
        return { kind: "unavailable", reason: "effect_evidence_invalid" };
      }
    } catch {
      await this.quarantine(existing);
      return { kind: "unavailable", reason: "effect_evidence_invalid" };
    }
    if (!requestMatchesEffect(request, existing)) {
      return { kind: "unavailable", reason: "effect_binding_mismatch" };
    }
    if (existing.intent.mcp !== undefined) {
      if (this.options.mcp === undefined) {
        return { kind: "unavailable", reason: "mcp_host_unavailable" };
      }
      const authorization = await this.options.mcp.revalidate(request, existing.intent.mcp);
      this.options.assertActive(request.signal);
      if (authorization.kind !== "allowed") return authorization;
    }
    if (existing.approvalId !== undefined) {
      const approvedIntent = await this.options.approvals.findIntent?.({
        runId: request.runId,
        toolCallId: request.plan.effectId,
        toolName: request.plan.toolRef.name,
        args: request.plan.arguments,
      });
      if (approvedIntent === undefined || intentDigest(approvedIntent) !== existing.intentDigest) {
        await this.quarantine(existing);
        return { kind: "unavailable", reason: "approval_evidence_mismatch" };
      }
    }
    if (existing.state === "confirmed") {
      if (!existing.outputStored) {
        await this.quarantine(existing);
        return { kind: "unavailable", reason: "confirmed_effect_output_unavailable" };
      }
      if (!(await this.confirmedEvidenceValid(request, existing))) {
        await this.quarantine(existing);
        return { kind: "unavailable", reason: "effect_evidence_invalid" };
      }
      return replayed(existing);
    }
    if (settledOnly) {
      await this.quarantine(existing);
      return { kind: "unavailable", reason: "effect_not_confirmed" };
    }
    return existing.state === "authorized" || existing.state === "dispatched"
      ? undefined
      : replayed(existing);
  }

  private async confirmedEvidenceValid(
    request: RoutineToolRequest,
    effect: EffectRecord
  ): Promise<boolean> {
    try {
      const contract = this.catalogFor(request.bundle).get(
        request.plan.toolRef.name,
        request.plan.toolRef.version
      );
      if (contract === undefined || !ajv.compile(contract.outputSchema)(effect.output))
        return false;
      const confirmed = (
        await this.options.effects.listAttempts(effect.businessId, effect.effectId)
      ).filter((attempt) => attempt.state === "confirmed");
      return (
        confirmed.length === 1 &&
        confirmed[0]?.outputDigest !== undefined &&
        confirmed[0].outputDigest === canonicalHash(effect.output)
      );
    } catch {
      return false;
    }
  }

  private async quarantine(effect: EffectRecord): Promise<void> {
    await this.options.effects.transition({
      businessId: effect.businessId,
      effectId: effect.effectId,
      expectedStates: [effect.state, "reconciliation_required"],
      state: "reconciliation_required",
      updatedAt: this.now().toISOString(),
    });
  }

  private async dispatchEffect(
    request: RoutineToolRequest,
    catalog: ToolCatalog,
    prepared: Extract<RoutineMcpPreparation, { readonly kind: "ready" }> | undefined
  ): Promise<RoutineToolOutcome> {
    const adapters = new Map(this.options.adapters);
    for (const [ref, adapter] of this.options.adaptersFor?.(request) ?? []) {
      adapters.set(ref, adapter);
    }
    if (prepared !== undefined) adapters.set(prepared.adapterRef, prepared.adapter);
    const credentials =
      prepared?.hostCredentials === true
        ? undefined
        : (this.options.credentialsFor?.(request) ?? this.options.credentials);
    const dispatcher = new EffectDispatcher({
      store: this.options.effects,
      catalog,
      adapters,
      ...(credentials === undefined ? {} : { credentialDispatcher: credentials }),
      ...(this.options.mutationGuard === undefined
        ? {}
        : { mutationGuard: this.options.mutationGuard }),
      ...(this.options.parkRetry === undefined ? {} : { parkRetry: this.options.parkRetry }),
      ...(this.options.retryWaitStatus === undefined
        ? {}
        : { retryWaitStatus: this.options.retryWaitStatus }),
      now: () => this.now().toISOString(),
    });
    try {
      const output = await dispatcher.dispatch(
        request.businessId,
        request.plan.effectId,
        request.signal
      );
      this.options.assertActive(request.signal);
      return { kind: "succeeded", output };
    } catch (error) {
      this.options.assertActive(request.signal);
      if (error instanceof EffectDispatchDeferredError) {
        const { waitId, effectId, attempt, notBefore, reason, delayMs } = error.deferred;
        return { kind: "waiting", waitId, effectId, attempt, notBefore, reason, delayMs };
      }
      if (!(error instanceof ToolDispatchError)) throw error;
      // Provider write may have landed; park `ambiguous` for reconciliation, never retry here.
      const effect = await this.options.effects.get(request.businessId, request.plan.effectId);
      this.options.assertActive(request.signal);
      if (effect?.state === "ambiguous") return { kind: "unavailable", reason: "effect_ambiguous" };
      return error.code === "adapter_not_found"
        ? { kind: "unavailable", reason: error.code }
        : { kind: "failed", reason: error.code };
    }
  }

  private async approvalMatches(
    request: RoutineToolRequest,
    expectedIntentDigest: string
  ): Promise<boolean> {
    const approvedIntent = await this.options.approvals.findIntent?.({
      runId: request.runId,
      toolCallId: request.plan.effectId,
      toolName: request.plan.toolRef.name,
      args: request.plan.arguments,
    });
    return approvedIntent !== undefined && intentDigest(approvedIntent) === expectedIntentDigest;
  }

  private async consumeApproval(request: RoutineToolRequest, approvalId: string): Promise<boolean> {
    const consumed = await this.options.approvals.consume({
      approvalId,
      toolCallId: request.plan.effectId,
    });
    this.options.assertActive(request.signal);
    return consumed;
  }

  private policyFor(bundle: RoutineToolBundle): GuardrailPolicy {
    const cached = this.policies.get(bundle.digest);
    if (cached !== undefined) return cached;
    const policy = compileGuardrailPolicy(definitionsOf<GuardrailDefinition>(bundle, "Guardrail"));
    this.policies.set(bundle.digest, policy);
    return policy;
  }

  private catalogFor(bundle: RoutineToolBundle): ToolCatalog {
    const cached = this.catalogs.get(bundle.digest);
    if (cached !== undefined) return cached;
    const catalog = ToolCatalog.load(definitionsOf<ToolContractDefinition>(bundle, "ToolContract"));
    this.catalogs.set(bundle.digest, catalog);
    return catalog;
  }

  /** The Routine's own authority: only what its pinned ToolContracts declare. */
  private authorityFor(bundle: RoutineToolBundle): AuthorityLayer {
    const cached = this.authorities.get(bundle.digest);
    if (cached !== undefined) return cached;
    const layer: AuthorityLayer = {
      name: "routine",
      grants: compileRoutineAuthority(
        definitionsOf<ToolContractDefinition>(bundle, "ToolContract")
      ),
    };
    this.authorities.set(bundle.digest, layer);
    return layer;
  }
}
