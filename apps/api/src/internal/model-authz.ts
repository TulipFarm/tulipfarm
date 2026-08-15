/** Authorizes which model a principal may cause a call to. */

import {
  type AuthorityLayer,
  type AuthzDecision,
  decideEffectivePermission,
  MODEL_INVOKE_ACTION,
  MODEL_RESOURCE,
} from "@tulipfarm/authz";
import {
  type AuthorityPrincipal,
  agentAuthorityPrincipal,
  type LiveAuthorityLayerResolver,
  principalKindOf,
} from "@tulipfarm/tool-host";

/**
 * How the gate behaves when the decision is a deny.
 *
 * `shadow` evaluates and reports but never changes the outcome. The authorization design's
 * implementation sequence (§5, "declare before enforce") requires shadow evidence over real
 * traffic before a gate may deny, because flipping straight to enforcing locks every principal
 * out of every model until roles grant `platform.model` — and no role grants it today.
 */
export type ModelGateMode = "shadow" | "enforcing";

/**
 * The gate's mode, defaulting to `shadow`.
 *
 * Enforcing is opt-in because the flip is the one step that can lock a deployment out of its own
 * models: no role grants `platform.model` yet, so an enforcing gate denies every turn until roles
 * declare it. §5 of the authorization design requires shadow evidence before that flip.
 */
export function modelGateModeFromEnv(
  env: Record<string, string | undefined> = process.env
): ModelGateMode {
  return env.AUTHZ_MODEL_GATE === "enforcing" ? "enforcing" : "shadow";
}

/** Thrown only in `enforcing` mode; shadow mode reports the same decision without raising. */
export class ModelSelectorDeniedError extends Error {
  readonly name = "ModelSelectorDeniedError";

  constructor(
    readonly selector: string,
    readonly reason: string
  ) {
    super(`model "${selector}" denied: ${reason}`);
  }
}

export interface ModelAuthorizationRequest {
  readonly businessId: string;
  /** Whom the turn acts as, taken from the Run rather than from whoever asked. */
  readonly subject: { readonly kind: string; readonly id: string };
  /** The Agent bounding the turn. Its own authority is layer L2 of the intersection. */
  readonly agentId?: string;
  /** The model as named by the request: an effort preset, a profile ref, or a raw model id. */
  readonly selector: string;
}

export interface ModelAuthorizationOutcome {
  readonly decision: AuthzDecision;
  /** True when the decision was a deny that `shadow` mode did not act on. */
  readonly wouldDeny: boolean;
  /** False when the mode let a denied selector through. */
  readonly enforced: boolean;
}

export interface ModelSelectorGateOptions {
  readonly resolver: LiveAuthorityLayerResolver;
  readonly mode: ModelGateMode;
  readonly log?: (event: Record<string, unknown>, message: string) => void;
}

/**
 * The model-path adapter onto the one decision function.
 *
 * It builds its layers from the same live resolver the Tool gate uses, so "may this principal use
 * this model" is answered by `decideEffectivePermission` rather than by a second implementation
 * (D4). Layers are resolved live on every call and never read from a Run-pinned copy (D1), so a
 * revoked assignment lands on the next model call rather than at the end of the Run.
 */
export class ModelSelectorGate {
  constructor(private readonly options: ModelSelectorGateOptions) {}

  async authorize(request: ModelAuthorizationRequest): Promise<ModelAuthorizationOutcome> {
    const decision = await this.decide(request);
    const enforced = this.options.mode === "enforcing";
    const wouldDeny = !decision.allowed;

    if (wouldDeny) {
      this.options.log?.(
        {
          event: "authz.model.decision",
          mode: this.options.mode,
          model: request.selector,
          subject: `${request.subject.kind}:${request.subject.id}`,
          ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
          reason: decision.reason,
          ...(decision.deniedLayer === undefined ? {} : { deniedLayer: decision.deniedLayer }),
          enforced,
        },
        enforced ? "model call denied" : "model call would be denied (shadow)"
      );
    }

    return { decision, wouldDeny, enforced };
  }

  private async decide(request: ModelAuthorizationRequest): Promise<AuthzDecision> {
    const kind = principalKindOf(request.subject.kind);
    if (kind === undefined) {
      // An unmappable subject kind is not a principal we can reason about. Fail closed rather
      // than intersecting an empty set, which would read as "allowed" to a careless caller.
      return { allowed: false, reason: "no_layers" };
    }

    const principal: AuthorityPrincipal = {
      id: request.subject.id,
      businessId: request.businessId,
      kind,
    };

    const layers: AuthorityLayer[] = [
      await this.options.resolver.resolvePrincipalLayer("user", principal),
    ];
    if (request.agentId !== undefined) {
      layers.push(
        await this.options.resolver.resolvePrincipalLayer(
          "agent",
          agentAuthorityPrincipal(request.businessId, request.agentId)
        )
      );
    }

    return decideEffectivePermission(layers, {
      action: MODEL_INVOKE_ACTION,
      resourceType: MODEL_RESOURCE,
      // The named model travels as the record id, so a grant can name one model, or `*` for all.
      recordId: request.selector,
    });
  }
}
