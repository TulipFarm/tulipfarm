import { createHash } from "node:crypto";
import {
  type AuthorityLayer,
  compileGuardrailPolicy,
  compileRoutineAuthority,
  type GuardrailPolicy,
  GuardrailPolicyError,
} from "@tulipfarm/authz";
import type { MutationGuard } from "@tulipfarm/observability";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import type { GuardrailDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import {
  type CredentialDispatcher,
  deriveContractTargets,
  EffectDispatchDeferredError,
  EffectDispatcher,
  type EffectRetryDeferred,
  type EffectRetryParkInput,
  type EffectRetryParkResult,
  type EffectStore,
  type ToolAdapter,
  ToolBroker,
  ToolCatalog,
  ToolCatalogError,
  ToolDispatchError,
  type ToolIntent,
  ToolTargetDerivationError,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import { GITHUB_INSTALLATION_SECRET_REF, githubInstallationSecretRef } from "./github-credentials";

/** Routine Tool authority: pinned bundle only; authorize, reserve, then dispatch fail-closed. */

export type RoutineToolWaitMetadata = Pick<
  EffectRetryDeferred,
  "waitId" | "effectId" | "attempt" | "notBefore" | "reason" | "delayMs"
>;

export type RoutineToolOutcome =
  /**
   * Dispatched and confirmed, or recognized as an effect this Run already confirmed.
   *
   * `output` is `null` for a `tool` State: the Broker settles a ToolContract as a durable *effect*
   * in the ledger, and a replayed Run reads back only that the effect was confirmed, never what the
   * provider returned. A State that needs the provider's data uses an `action` State instead.
   */
  | { readonly kind: "succeeded"; readonly output: unknown }
  /**
   * A definitive negative the authored `onError` path may claim, named by its reason code.
   *
   * Tool failures are always terminal for the `retry` policy: the effect ledger keys an effect by
   * its `(run, state)` occurrence, so a re-dispatch replays this same confirmed result rather than
   * re-running the provider. A provider-directed safe retry parks as `waiting`; an ambiguous
   * mutation parks for reconciliation instead.
   */
  | { readonly kind: "failed"; readonly reason: string }
  /** Policy requires a human. Routine Approvals are not composed yet, so the Run parks. */
  | { readonly kind: "awaiting_approval"; readonly reason: string }
  /** A provider-directed retry is parked on a durable timer. */
  | ({ readonly kind: "waiting" } & RoutineToolWaitMetadata)
  /** Nothing decided the call. The State parks for reconciliation rather than guessing. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RoutineToolRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key; the ledger's `state_id`. */
  readonly stateKey: string;
  readonly plan: ToolDispatchPlan;
  /** The Run's exact pinned bundle — the only source of contracts and policy. */
  readonly bundle: RuntimeBundle;
  /** Extra layers cannot widen past the pinned ToolContracts' own authority. */
  readonly authorityLayers: readonly AuthorityLayer[];
}

export interface RoutineToolPort {
  execute(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
  /** Resume an already-reserved effect without passing through reservation again. */
  resume?(request: RoutineToolRequest): Promise<RoutineToolOutcome>;
  retryStatus?(request: RoutineToolRequest): Promise<"none" | "pending" | "ready" | "unavailable">;
}

export type RoutineOimPreparation =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly arguments: Record<string, unknown>;
      readonly adapterRef: string;
      readonly adapter: ToolAdapter;
      readonly hostCredentials: true;
      readonly filePrincipalId?: string;
      readonly destination?: string;
      readonly credentialRef?: string;
      readonly connection?: ToolIntent["connection"];
      readonly secondaryCredentialRef?: string;
      readonly secondaryConnection?: ToolIntent["secondaryConnection"];
    };

export interface RoutineOimPreparationPort {
  prepare(request: RoutineToolRequest): Promise<RoutineOimPreparation>;
}

export interface RoutineToolRetryWaitPort {
  register(input: {
    readonly id: string;
    readonly businessId: string;
    readonly runId: string;
    readonly stateKey: string;
    readonly kind: "timer";
    readonly aggregation: "first";
    readonly schemaRef: string;
    readonly allowedPrincipals: readonly string[];
    readonly expectedSignals: 1;
    readonly quorum: null;
    readonly deadlineAt: string;
    readonly createdAt: string;
  }): Promise<unknown>;
  find(
    businessId: string,
    waitId: string
  ): Promise<{
    readonly runId: string;
    readonly stateKey: string;
    readonly kind: string;
    readonly schemaRef: string;
    readonly status: string;
    readonly deadlineAt: string;
    readonly createdAt: string;
  } | null>;
}

export interface BrokerRoutineToolPortOptions {
  readonly effects: EffectStore;
  /** Keyed by `ToolContract.adapter.ref`, exactly as `EffectDispatcher` resolves them. */
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials?: CredentialDispatcher;
  /** Bundle-scoped adapters are built only from the Run's verified immutable package. */
  readonly adaptersFor?: (request: RoutineToolRequest) => ReadonlyMap<string, ToolAdapter>;
  readonly credentialsFor?: (request: RoutineToolRequest) => CredentialDispatcher | undefined;
  /** OIM resolution stays API-side; only opaque bindings and a remote adapter cross back. */
  readonly oim?: RoutineOimPreparationPort;
  /** Durable provider backoff; required before an adapter-directed Retry-After can be honored. */
  readonly retryWaits?: RoutineToolRetryWaitPort;
  /** Emergency stop over mutating effects; absent leaves Routine Tools ungoverned. */
  readonly mutationGuard?: MutationGuard;
  readonly now?: () => Date;
}

const TOOL_RETRY_WAIT_SCHEMA_REF = "tulipfarm://oim/rate-retry/v1";

function retryWaitId(effectId: string, attempt: number): string {
  const digest = createHash("sha256").update(`oim-rate-retry:${effectId}:${attempt}`).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function matchesRetryWait(
  wait: Awaited<ReturnType<RoutineToolRetryWaitPort["find"]>>,
  input: EffectRetryParkInput
): boolean {
  return (
    wait !== null &&
    wait.runId === input.runId &&
    wait.stateKey === input.stateId &&
    wait.kind === "timer" &&
    wait.schemaRef === TOOL_RETRY_WAIT_SCHEMA_REF &&
    wait.deadlineAt === input.notBefore
  );
}

function definitionsOf<T>(bundle: RuntimeBundle, kind: string): T[] {
  return bundle.definitions
    .filter((definition) => definition.kind === kind)
    .map((definition) => definition.document as unknown as T);
}

/** Narrow bare GitHub installation refs from arguments; leave authored scoped refs unchanged. */
function scopedCredentialRef(plan: ToolDispatchPlan): string | undefined {
  const ref = plan.credentialRef;
  if (ref !== GITHUB_INSTALLATION_SECRET_REF) return ref;
  const args = plan.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ref;
  const source = args as Record<string, unknown>;
  const repository = source.repository;
  if (typeof repository === "string" && repository.length > 0) {
    return githubInstallationSecretRef({ kind: "repository", repository });
  }
  const owner = source.owner;
  if (typeof owner === "string" && owner.length > 0) {
    return githubInstallationSecretRef({ kind: "account", owner });
  }
  return ref;
}

function intentOf(
  request: RoutineToolRequest,
  targetRefs: readonly ToolTargetRef[],
  prepared?: Extract<RoutineOimPreparation, { readonly kind: "ready" }>
): ToolIntent {
  const { plan } = request;
  const credentialRef = prepared?.credentialRef ?? scopedCredentialRef(plan);
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
    ...((prepared?.destination ?? plan.destination) === undefined
      ? {}
      : { destination: prepared?.destination ?? plan.destination }),
    ...(prepared?.filePrincipalId === undefined
      ? {}
      : { filePrincipalId: prepared.filePrincipalId }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(prepared?.connection === undefined ? {} : { connection: prepared.connection }),
    ...(prepared?.secondaryCredentialRef === undefined
      ? {}
      : { secondaryCredentialRef: prepared.secondaryCredentialRef }),
    ...(prepared?.secondaryConnection === undefined
      ? {}
      : { secondaryConnection: prepared.secondaryConnection }),
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
function replayed(state: string): RoutineToolOutcome {
  switch (state) {
    case "confirmed":
      return { kind: "succeeded", output: null };
    case "denied":
      return { kind: "failed", reason: "effect_denied" };
    case "failed":
      return { kind: "failed", reason: "effect_failed" };
    default:
      return { kind: "unavailable", reason: `effect_${state}` };
  }
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

  async execute(request: RoutineToolRequest): Promise<RoutineToolOutcome> {
    const existing = await this.options.effects.get(request.businessId, request.plan.effectId);
    if (existing !== undefined) {
      if (
        existing.runId !== request.runId ||
        existing.stateId !== request.stateKey ||
        existing.guardrailRevision !== request.bundle.digest ||
        existing.idempotencyKey !== request.plan.idempotencyKey ||
        existing.intent.toolId !== request.plan.toolRef.name ||
        existing.intent.toolVersion !== request.plan.toolRef.version
      ) {
        return { kind: "unavailable", reason: "effect_binding_mismatch" };
      }
      if (existing.state !== "authorized") return replayed(existing.state);
      return this.resume(request);
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
    let prepared: Extract<RoutineOimPreparation, { readonly kind: "ready" }> | undefined;
    if (contract?.adapter.ref.startsWith("oim-") && this.options.oim !== undefined) {
      const resolution = await this.options.oim.prepare(request);
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

    const intent = intentOf(request, targetRefs, prepared);
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
    if (outcome.outcome === "awaiting_approval") {
      return { kind: "awaiting_approval", reason: "approval_required" };
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
      createdAt: this.now().toISOString(),
    });
    if (reserved.outcome === "duplicate" && reserved.effect.state !== "authorized") {
      return replayed(reserved.effect.state);
    }
    if (reserved.outcome === "duplicate") {
      return this.resume(request);
    }

    return this.dispatchEffect(request, catalog, prepared);
  }

  async resume(request: RoutineToolRequest): Promise<RoutineToolOutcome> {
    const effect = await this.options.effects.get(request.businessId, request.plan.effectId);
    if (
      effect === undefined ||
      effect.state !== "authorized" ||
      effect.runId !== request.runId ||
      effect.stateId !== request.stateKey ||
      effect.guardrailRevision !== request.bundle.digest ||
      effect.idempotencyKey !== request.plan.idempotencyKey ||
      effect.intent.toolId !== request.plan.toolRef.name ||
      effect.intent.toolVersion !== request.plan.toolRef.version
    ) {
      return { kind: "unavailable", reason: "effect_not_resumable" };
    }
    const retry = await this.retryState(request);
    if (retry.status === "pending") return { kind: "waiting", ...retry.deferred };
    if (retry.status === "unavailable") {
      return { kind: "unavailable", reason: "provider_retry_wait_unresolved" };
    }

    let catalog: ToolCatalog;
    try {
      catalog = this.catalogFor(request.bundle);
    } catch (error) {
      if (error instanceof ToolCatalogError) {
        return { kind: "unavailable", reason: error.code };
      }
      throw error;
    }
    const contract = catalog.get(request.plan.toolRef.name, request.plan.toolRef.version);
    let prepared: Extract<RoutineOimPreparation, { readonly kind: "ready" }> | undefined;
    if (contract?.adapter.ref.startsWith("oim-") && this.options.oim !== undefined) {
      const resolution = await this.options.oim.prepare(request);
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
    return this.dispatchEffect(request, catalog, prepared);
  }

  private async dispatchEffect(
    request: RoutineToolRequest,
    catalog: ToolCatalog,
    prepared: Extract<RoutineOimPreparation, { readonly kind: "ready" }> | undefined
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
      ...(this.options.retryWaits === undefined
        ? {}
        : {
            parkRetry: (input: EffectRetryParkInput) => this.parkRetry(input),
          }),
      now: () => this.now().toISOString(),
    });
    try {
      await dispatcher.dispatch(request.businessId, request.plan.effectId);
      return { kind: "succeeded", output: null };
    } catch (error) {
      if (error instanceof EffectDispatchDeferredError) {
        const { waitId, effectId, attempt, notBefore, reason, delayMs } = error.deferred;
        return { kind: "waiting", waitId, effectId, attempt, notBefore, reason, delayMs };
      }
      if (!(error instanceof ToolDispatchError)) throw error;
      // Provider write may have landed; park `ambiguous` for reconciliation, never retry here.
      const effect = await this.options.effects.get(request.businessId, request.plan.effectId);
      if (effect?.state === "ambiguous") return { kind: "unavailable", reason: "effect_ambiguous" };
      return error.code === "adapter_not_found"
        ? { kind: "unavailable", reason: error.code }
        : { kind: "failed", reason: error.code };
    }
  }

  async retryStatus(
    request: RoutineToolRequest
  ): Promise<"none" | "pending" | "ready" | "unavailable"> {
    return (await this.retryState(request)).status;
  }

  private async retryState(
    request: RoutineToolRequest
  ): Promise<
    | { readonly status: "none" | "ready" | "unavailable" }
    | { readonly status: "pending"; readonly deferred: RoutineToolWaitMetadata }
  > {
    if (this.options.retryWaits === undefined) return { status: "none" };
    const effect = await this.options.effects.get(request.businessId, request.plan.effectId);
    if (effect === undefined || effect.state !== "authorized") return { status: "none" };
    const attempts = await this.options.effects.listAttempts(effect.businessId, effect.effectId);
    const last = attempts.at(-1);
    if (last?.state !== "failed") return { status: "none" };
    const wait = await this.options.retryWaits.find(
      effect.businessId,
      retryWaitId(effect.effectId, last.attempt)
    );
    // The effect was returned to `authorized` before its wait was registered. If the process died
    // in that gap, dispatching now would ignore the provider's retry window.
    if (wait === null) return { status: "unavailable" };
    if (wait.status === "pending") {
      return {
        status: "pending",
        deferred: {
          waitId: retryWaitId(effect.effectId, last.attempt),
          effectId: effect.effectId,
          attempt: last.attempt,
          notBefore: wait.deadlineAt,
          delayMs: Date.parse(wait.deadlineAt) - Date.parse(wait.createdAt),
          reason: last.errorCode ?? "provider_retry_wait",
        },
      };
    }
    if (wait.status === "satisfied") return { status: "ready" };
    return { status: "unavailable" };
  }

  private async parkRetry(input: EffectRetryParkInput): Promise<EffectRetryParkResult> {
    const waits = this.options.retryWaits;
    if (waits === undefined) throw new Error("Routine Tool retry wait store is unavailable");
    const waitId = retryWaitId(input.effectId, input.attempt);
    const existing = await waits.find(input.businessId, waitId);
    if (existing !== null) {
      if (!matchesRetryWait(existing, input)) {
        throw new Error("routine_tool_retry_wait_conflict");
      }
      return { waitId };
    }
    const createdAt = new Date(Date.parse(input.notBefore) - input.delayMs).toISOString();
    try {
      await waits.register({
        id: waitId,
        businessId: input.businessId,
        runId: input.runId,
        stateKey: input.stateId,
        kind: "timer",
        aggregation: "first",
        schemaRef: TOOL_RETRY_WAIT_SCHEMA_REF,
        allowedPrincipals: [],
        expectedSignals: 1,
        quorum: null,
        deadlineAt: input.notBefore,
        createdAt,
      });
    } catch (error) {
      const raced = await waits.find(input.businessId, waitId);
      if (!matchesRetryWait(raced, input)) throw error;
    }
    return { waitId };
  }

  private policyFor(bundle: RuntimeBundle): GuardrailPolicy {
    const cached = this.policies.get(bundle.digest);
    if (cached !== undefined) return cached;
    const policy = compileGuardrailPolicy(definitionsOf<GuardrailDefinition>(bundle, "Guardrail"));
    this.policies.set(bundle.digest, policy);
    return policy;
  }

  private catalogFor(bundle: RuntimeBundle): ToolCatalog {
    const cached = this.catalogs.get(bundle.digest);
    if (cached !== undefined) return cached;
    const catalog = ToolCatalog.load(definitionsOf<ToolContractDefinition>(bundle, "ToolContract"));
    this.catalogs.set(bundle.digest, catalog);
    return catalog;
  }

  /** The Routine's own authority: only what its pinned ToolContracts declare. */
  private authorityFor(bundle: RuntimeBundle): AuthorityLayer {
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
