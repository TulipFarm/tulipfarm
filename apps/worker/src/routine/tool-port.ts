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
  EffectDispatcher,
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
   * re-running the provider. A genuinely transient fault never lands here — it surfaces as
   * `unavailable`/`effect_ambiguous` and parks for reconciliation, which is its own durable retry.
   */
  | { readonly kind: "failed"; readonly reason: string }
  /** Policy requires a human. Routine Approvals are not composed yet, so the Run parks. */
  | { readonly kind: "awaiting_approval"; readonly reason: string }
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
}

export interface BrokerRoutineToolPortOptions {
  readonly effects: EffectStore;
  /** Keyed by `ToolContract.adapter.ref`, exactly as `EffectDispatcher` resolves them. */
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials?: CredentialDispatcher;
  /** Bundle-scoped adapters are built only from the Run's verified immutable package. */
  readonly adaptersFor?: (request: RoutineToolRequest) => ReadonlyMap<string, ToolAdapter>;
  readonly credentialsFor?: (request: RoutineToolRequest) => CredentialDispatcher | undefined;
  /** Emergency stop over mutating effects; absent leaves Routine Tools ungoverned. */
  readonly mutationGuard?: MutationGuard;
  readonly now?: () => Date;
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

function intentOf(request: RoutineToolRequest, targetRefs: readonly ToolTargetRef[]): ToolIntent {
  const { plan } = request;
  const credentialRef = scopedCredentialRef(plan);
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
    arguments: plan.arguments,
    ...(plan.destination === undefined ? {} : { destination: plan.destination }),
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

    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = targetsOf(catalog, request);
    } catch (error) {
      // A contract that declares a target the call cannot name must be refused, never widened to a
      // Tool-granular decision by handing the gate an empty target list.
      if (error instanceof ToolTargetDerivationError) {
        return { kind: "failed", reason: error.code };
      }
      throw error;
    }

    const intent = intentOf(request, targetRefs);
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
    if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

    const adapters = new Map(this.options.adapters);
    for (const [ref, adapter] of this.options.adaptersFor?.(request) ?? []) {
      adapters.set(ref, adapter);
    }
    const credentials = this.options.credentialsFor?.(request) ?? this.options.credentials;
    const dispatcher = new EffectDispatcher({
      store: this.options.effects,
      catalog,
      adapters,
      ...(credentials === undefined ? {} : { credentialDispatcher: credentials }),
      ...(this.options.mutationGuard === undefined
        ? {}
        : { mutationGuard: this.options.mutationGuard }),
      now: () => this.now().toISOString(),
    });
    try {
      await dispatcher.dispatch(request.businessId, request.plan.effectId);
      return { kind: "succeeded", output: null };
    } catch (error) {
      if (!(error instanceof ToolDispatchError)) throw error;
      // Provider write may have landed; park `ambiguous` for reconciliation, never retry here.
      const effect = await this.options.effects.get(request.businessId, request.plan.effectId);
      if (effect?.state === "ambiguous") return { kind: "unavailable", reason: "effect_ambiguous" };
      return error.code === "adapter_not_found"
        ? { kind: "unavailable", reason: error.code }
        : { kind: "failed", reason: error.code };
    }
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
