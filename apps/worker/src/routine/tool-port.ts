import {
  type AuthorityLayer,
  compileGuardrailPolicy,
  compileRoutineAuthority,
  type GuardrailPolicy,
  GuardrailPolicyError,
} from "@tulipfarm/authz";
import type { ToolDispatchPlan } from "@tulipfarm/run-kernel";
import type { GuardrailDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { RuntimeBundle } from "@tulipfarm/soul";
import {
  type CredentialDispatcher,
  EffectDispatcher,
  type EffectStore,
  type ToolAdapter,
  ToolBroker,
  ToolCatalog,
  ToolCatalogError,
  ToolDispatchError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";

/**
 * The Worker's Tool authority for Routine Runs.
 *
 * Everything a Tool State needs is read from the Run's own pinned, signature-verified bundle: the
 * ToolContract it names, and the Guardrails that decide it. That is what makes the evidence exact
 * — the policy that authorized a dispatch and the contract that shaped it are the ones this Run is
 * bound to, not whatever the live Soul says now — and it is why the bundle digest is the
 * `guardrailRevision` recorded against the effect.
 *
 * Order is load-bearing and fail-closed at every step: authorize, then reserve, then dispatch. A
 * denial never reaches an adapter; a dispatch never happens without a durable reservation carrying
 * the intent digest and the guardrail revision, so a replayed Run finds the effect it already made
 * instead of writing a second one. Nothing here interprets a missing piece as permission: no
 * authority layers, an uncompilable policy, or an unregistered adapter all stop the State.
 */

export type RoutineToolOutcome =
  /** Dispatched and confirmed, or recognized as an effect this Run already confirmed. */
  | { readonly kind: "succeeded" }
  /** A definitive negative the authored `onError` path may claim, named by its reason code. */
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
  /**
   * Layers beyond the bundle's own Tool authority — identity/Run-context layers a future caller
   * may add. The bundle's ToolContracts always contribute their own layer (see `authorityFor`
   * below); a Routine's authority can never widen past what it declares wanting to call, no
   * matter what this array carries.
   */
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
  readonly now?: () => Date;
}

function definitionsOf<T>(bundle: RuntimeBundle, kind: string): T[] {
  return bundle.definitions
    .filter((definition) => definition.kind === kind)
    .map((definition) => definition.document as unknown as T);
}

function intentOf(request: RoutineToolRequest): ToolIntent {
  const { plan } = request;
  return {
    // Derived from the Run and the State occurrence, so a replay proposes the same intent.
    intentId: plan.effectId,
    businessId: request.businessId,
    runId: request.runId,
    stateId: request.stateKey,
    toolId: plan.toolRef.name,
    toolVersion: plan.toolRef.version,
    action: plan.action,
    targetRefs: [],
    arguments: plan.arguments,
    ...(plan.destination === undefined ? {} : { destination: plan.destination }),
    ...(plan.credentialRef === undefined ? {} : { credentialRef: plan.credentialRef }),
    idempotencyKey: plan.idempotencyKey,
  };
}

/**
 * A Tool State whose effect is already durable. `confirmed` is the work this attempt was about to
 * do, so the State succeeds without repeating it; `ambiguous` is the one answer no executor may
 * resolve on its own — reconciliation reads the provider, this process does not guess.
 */
function replayed(state: string): RoutineToolOutcome {
  switch (state) {
    case "confirmed":
      return { kind: "succeeded" };
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
      // An authored rule this deployment cannot express exactly, or a contract the bundle did not
      // publish. Either way the policy that would decide this call is not the authored one.
      if (error instanceof GuardrailPolicyError) {
        return { kind: "unavailable", reason: `guardrail_${error.code}` };
      }
      if (error instanceof ToolCatalogError) {
        return { kind: "unavailable", reason: error.code };
      }
      throw error;
    }

    const intent = intentOf(request);
    const outcome = new ToolBroker(catalog).authorize(intent, {
      authorityLayers: [...request.authorityLayers, this.authorityFor(request.bundle)],
      guardrailRules: policy.rules,
      dlpRules: policy.dlpRules,
      // The bundle digest is the revision: it names every Guardrail this Run is bound to, and
      // nothing else can change under a Run that is already pinned to it.
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
      now: () => this.now().toISOString(),
    });
    try {
      await dispatcher.dispatch(request.businessId, request.plan.effectId);
      return { kind: "succeeded" };
    } catch (error) {
      if (!(error instanceof ToolDispatchError)) throw error;
      // `ambiguous` means the provider may or may not have applied the write. Only reconciliation
      // can answer that, so the State parks rather than retrying or failing over it.
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

  /** The Routine's own authority: exactly the actions/resources its pinned ToolContracts declare. */
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
