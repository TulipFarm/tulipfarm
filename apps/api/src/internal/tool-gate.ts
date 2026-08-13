/**
 * The authorization gate for the chat path.
 *
 * `BrokerRoutineToolPort` has always run every Routine Tool call through `ToolBroker.authorize`.
 * The chat path did not: it checked that the Tool was *available* to the turn — a per-agent
 * visibility list — and then executed it. Availability is not authority. It is the same for every
 * caller, so an HR user and an engineer sharing an Agent saw the same Tools and could invoke them
 * identically; the only thing standing between them was whatever each Tool's handler happened to
 * check for itself.
 *
 * This closes that. The decision is the same `authorizeToolIntent` the Routine path uses, over the
 * same `AuthorityLayer`s, so the two paths cannot drift into two different answers for the same
 * question. It runs after argument validation and before `execute`, for the same reason approval
 * does: a denial must not leave an effect behind it.
 *
 * Two things are deliberately *not* decided here.
 *
 * Guardrails and DLP are left to the chat path's own guard stages
 * (`packages/agent-runtime`'s `GuardrailsService`), which already run over the same call, so this
 * gate contributes the authorization decision and nothing else rather than inventing a second,
 * weaker guardrail evaluation that would disagree with the first.
 *
 * That is expressed as an explicit baseline rule, not as an empty rule list, and the difference is
 * not cosmetic: `evaluateGuardrail` ends `approval ?? allow ?? ceilingDenial ?? deny`, so **no
 * rules means every call is denied**, not that guardrails abstain. A deployment that compiles real
 * Guardrail rules for the chat path passes them in and the baseline is replaced wholesale; until
 * then the baseline says, in one readable place, that guardrails are decided elsewhere. The
 * revision is still threaded through, because `authorizeToolIntent` refuses to decide without one —
 * an unknown policy revision is not an empty one.
 *
 * Provider entitlement is likewise not decided here. A grant of `integration.github` says the
 * caller may reach the GitHub Tools; whether *this* account may touch *that* repository is GitHub's
 * own ACL, enforced where it already is. Duplicating it into Roles would mean keeping a copy of
 * every provider's permission model in sync with the provider.
 */

import type { AccessGrant, AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import {
  authorizeToolIntent,
  normalizeToolIntent,
  type PublishedToolContract,
  publishLocalToolContract,
  type ToolPolicyOutcome,
  type ToolTargetRef,
} from "@tulipfarm/tool-broker";
import type { ApiToolDefinition } from "../tools/define";

export interface ToolGateRequest {
  readonly definition: ApiToolDefinition<unknown>;
  readonly arguments: unknown;
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  /** Caller layers only. The agent layer is compiled here — see {@link ToolGateAgent}. */
  readonly authorityLayers: readonly AuthorityLayer[];
  /**
   * The Agent whose allowlist bounds this turn. Supplied rather than pre-compiled because the
   * agent layer has to be built *after* targets derive — see {@link agentAuthorityLayer}.
   */
  readonly agent?: ToolGateAgent;
  /**
   * The derivation context passed to `targetsFor`. Load-bearing, not optional decoration: a
   * Resource Tool reads its Resource's `domain` from `ctx.soulLoader`, and `grantMatches` treats a
   * domainless request as matching only domainless grants. Omitting it therefore erases the domain
   * wall — the very separation between an HR Resource and an engineering one — by making every
   * derived target look undomained.
   */
  readonly context?: unknown;
  readonly guardrailRevision: string;
  readonly autonomy?:
    | "answer_only"
    | "propose_actions"
    | "execute_low_risk"
    | "execute_policy_authorized";
  /** Replaces {@link GUARDRAILS_DECIDED_ELSEWHERE} where a deployment compiles real rules. */
  readonly guardrailRules?: readonly GuardrailRule[];
  /** Replaces {@link CHAT_DLP_RULES} where a deployment compiles real rules. */
  readonly dlpRules?: readonly DlpRule[];
}

/** The Agent bounding a turn: its name, and the Tools its allowlist offered. */
export interface ToolGateAgent {
  readonly name: string;
  readonly available: readonly { readonly definition?: ApiToolDefinition<never> }[];
}

/**
 * Lets each classification this deployment's Tools declare cross, unconstrained.
 *
 * These rules are not the DLP policy — the boundary a chat reply actually crosses (which channel,
 * which audience) is decided by the delivery path, which knows the destination; this gate does not.
 * What the rules preserve is the one part of `checkDlpBoundary` that *is* this gate's business:
 * `unclassified_data`. A Tool that declares no `dataClasses` is refused here, so "say what class of
 * data you touch" stays a hard requirement of defining a Tool rather than a convention.
 *
 * The fitness check in `contract-projection.test.ts` pins the two together: every class any Tool
 * declares must appear here, so adding a classification cannot silently start denying its Tools.
 */
export const CHAT_DLP_RULES: readonly DlpRule[] = [
  { dataClass: "source_content" },
  { dataClass: "business_record" },
  { dataClass: "soul_definition" },
  { dataClass: "operational" },
  { dataClass: "memory" },
  { dataClass: "directory" },
  { dataClass: "internal" },
];

export interface ToolGate {
  authorize(request: ToolGateRequest): ToolPolicyOutcome;
}

/**
 * Says "guardrails abstain here" in the only vocabulary `evaluateGuardrail` has.
 *
 * It carries no ceiling of its own precisely so it cannot quietly become a *second* policy: every
 * ceiling this gate would otherwise impose (volume, taint, autonomy) is already imposed by the chat
 * guard stages, and a ceiling stated in two places is a ceiling that will eventually disagree with
 * itself.
 */
export const GUARDRAILS_DECIDED_ELSEWHERE: readonly GuardrailRule[] = [
  { id: "chat-baseline", effect: "allow", action: "*", resourceType: "*" },
];

/**
 * A Tool the gate cannot build a contract for is not a Tool the gate may wave through.
 *
 * `ToolCatalog.load` rejects a spec the published contract schema does not accept. That is a
 * definition defect, but at this point in a turn it is indistinguishable from a Tool trying to
 * avoid being described — so it denies rather than falling back to an unchecked execution.
 */
export class LiveToolGate implements ToolGate {
  private readonly contracts = new Map<string, PublishedToolContract | undefined>();

  authorize(request: ToolGateRequest): ToolPolicyOutcome {
    const { definition } = request;
    const contract = this.contractFor(definition);
    if (contract === undefined) return { outcome: "denied", reason: "authorization_denied" };

    // `targetsFor` throws `ToolDefinitionError` on arguments it cannot turn into a target — a
    // reserved `"*"` id, or a type that is not a valid name. Those arguments come straight from the
    // model, and AJV only requires a non-empty string, so `record_list({type:"*"})` is an ordinary
    // thing for a model to try. Unwrapped it escapes the gate, the dispatcher and the route guard
    // and 500s the whole turn. It is a refusal, and it is answered as one.
    let targetRefs: readonly ToolTargetRef[];
    try {
      targetRefs = definition.targetsFor(request.arguments, request.context);
    } catch {
      return { outcome: "denied", reason: "authorization_denied" };
    }

    const intent = normalizeToolIntent({
      intentId: `gate:${request.runId}:${request.stateId}:${definition.name}`,
      businessId: request.businessId,
      runId: request.runId,
      stateId: request.stateId,
      toolId: definition.name,
      toolVersion: definition.version,
      action: definition.authorization.action,
      // The Tool's own declared derivation. Deriving nothing is fail-closed: the gate then checks
      // the coarse static resource instead, which is never narrower than a derived target.
      targetRefs,
      arguments: request.arguments,
      idempotencyKey: `gate:${request.runId}:${request.stateId}:${definition.name}`,
    });

    const layers =
      request.agent === undefined
        ? request.authorityLayers
        : [
            ...request.authorityLayers,
            agentAuthorityLayer(request.agent.name, request.agent.available, {
              definition,
              targetRefs,
            }),
          ];

    return authorizeToolIntent(intent, contract, {
      authorityLayers: layers,
      guardrailRules: request.guardrailRules ?? GUARDRAILS_DECIDED_ELSEWHERE,
      dlpRules: request.dlpRules ?? CHAT_DLP_RULES,
      guardrailRevision: request.guardrailRevision,
      ...(request.autonomy === undefined ? {} : { autonomy: request.autonomy }),
    });
  }

  private contractFor(definition: ApiToolDefinition<unknown>): PublishedToolContract | undefined {
    const key = `${definition.name}@${definition.version}`;
    if (this.contracts.has(key)) return this.contracts.get(key);
    let contract: PublishedToolContract | undefined;
    try {
      contract = publishLocalToolContract(definition);
    } catch {
      contract = undefined;
    }
    this.contracts.set(key, contract);
    return contract;
  }
}

/**
 * Chat autonomy names, mapped onto the autonomy vocabulary the risk rules are written against.
 *
 * The two vocabularies are genuinely different and neither is a subset of the other: chat says
 * `full | supervised | approval-required | manual` (`tools/types.ts`, `packages/schema`'s
 * `AUTONOMY_VALUES`, and the `CHAT_REQUEST_SCHEMA` enum), while the risk ladder says
 * `answer_only < propose_actions < execute_low_risk < execute_policy_authorized`.
 *
 * Every chat value must map. `checkCeilings` denies with `missing_context` whenever a rule carries
 * `maxAutonomy` and the context has none, so an unmapped value is not "unconstrained" — it is a
 * blanket denial the moment a deployment compiles a rule with an autonomy ceiling, and it makes
 * `manual`, the most restrictive mode, indistinguishable from `full`, the least.
 */
export function gateAutonomyOf(autonomy: string | undefined): ToolGateRequest["autonomy"] {
  switch (autonomy) {
    case "manual":
      return "answer_only";
    // Both put a human between the proposal and the effect: `supervised` by watching,
    // `approval-required` by blocking on an explicit decision.
    case "supervised":
    case "approval-required":
      return "propose_actions";
    case "full":
      return "execute_policy_authorized";
    default:
      return undefined;
  }
}

/**
 * The Agent's own layer, derived from what the Agent declares it may call.
 *
 * There is no durable principal row for an Agent, and seeding one would not help: nothing would
 * know what to grant it. But an Agent already states its authority — the Tool allowlist its Soul
 * definition carries is precisely "these are the effects I exist to have". Compiling that list into
 * grants makes the second half of caller-∩-agent mean what it says, without inventing a second
 * place to author Agent authority that would immediately disagree with the allowlist.
 *
 * Deriving rather than resolving is also what keeps the flip safe. `decideEffectivePermission`
 * allows only what *every* layer allows, so an agent layer that resolved to empty — which is what a
 * principal lookup returns for a row that was never written — denies every call in the deployment
 * while looking exactly like a correct default-deny.
 *
 * **It must be compiled from what the Tool can reach, not only from what it statically declares.**
 * A Tool declaring `resources: ["record"]` derives `record.<type>` for the row it touches, and
 * `grantMatches` compares `resourceType` by exact string with no prefix rule — so a layer built
 * from `resources` alone holds `record` and never `record.ticket`, and denies every Tool that
 * derives a narrow target *including for an owner holding `*`/`*`*. That is why `reached` exists:
 * the derived types of this call are admitted, but only those a declared resource covers, so a Tool
 * reaching outside what it declared still finds nothing here.
 *
 * Each admitted type yields two grants, domainless and `domain: "*"`, because `grantMatches` treats
 * the two as disjoint — a domainless grant matches only domainless requests. Without the pair, the
 * moment a Resource declares a `domain` the agent layer would deny it, turning the domain wall into
 * a blanket refusal rather than a caller-scoped one. Scoping *by* domain is the caller layer's job.
 *
 * Be precise about what this buys today, because it is easy to mistake for more. The layer is
 * compiled from the very set the turn was already restricted to, so it cannot refuse a Tool the
 * allowlist would have offered — it is not a second allowlist. What it does refuse is a caller
 * holding a wildcard grant reaching, through a Tool, an action or resource that Tool never
 * declared. Its larger purpose is structural: caller-∩-agent is evaluated for real from this point
 * on, so when Agent authority becomes authorable it narrows this layer rather than introducing one.
 */
export function agentAuthorityLayer(
  agentName: string,
  available: readonly { readonly definition?: ApiToolDefinition<never> }[],
  reached?: {
    readonly definition: ApiToolDefinition<unknown>;
    readonly targetRefs: readonly ToolTargetRef[];
  }
): AuthorityLayer {
  const grants: AccessGrant[] = [];
  const admit = (action: string, resourceType: string): void => {
    grants.push({ action, resourceType, effect: "allow" });
    grants.push({ action, resourceType, domain: "*", effect: "allow" });
  };
  for (const tool of available) {
    const auth = tool.definition?.authorization;
    if (auth === undefined) continue;
    for (const resourceType of auth.resources ?? []) admit(auth.action, resourceType);
  }
  if (reached !== undefined) {
    const auth = reached.definition.authorization;
    const declared = auth.resources ?? [];
    for (const target of reached.targetRefs) {
      if (declared.some((resource) => coversTargetType(resource, target.type))) {
        admit(auth.action, target.type);
      }
    }
  }
  return { name: `agent:${agentName}`, grants };
}

/**
 * Whether a declared static resource covers a derived target type: the type itself, or one of its
 * dotted children. Mirrors the coherence rule the `contract-projection` fitness check enforces, so
 * a target shape that check accepts is one this layer can express.
 */
function coversTargetType(resource: string, targetType: string): boolean {
  return targetType === resource || targetType.startsWith(`${resource}.`);
}
