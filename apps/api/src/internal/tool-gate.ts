/** Chat Tool calls require caller authority intersected with the Agent grant layer. */

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
  /** Agent is supplied because its layer is built after target derivation. */
  readonly agent?: ToolGateAgent;
  /** Load-bearing: omitting soulLoader erases Resource domains. */
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

/** Preserve only unclassified_data here; delivery-specific DLP checks happen elsewhere. */
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

/** Guardrails abstain here so this gate cannot become a second, drifting ceiling policy. */
export const GUARDRAILS_DECIDED_ELSEWHERE: readonly GuardrailRule[] = [
  { id: "chat-baseline", effect: "allow", action: "*", resourceType: "*" },
];

/** Deny Tools whose contract cannot be built; never fall back to unchecked execution. */
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

/** Every chat autonomy value must map to the risk-rule ladder; missing mappings deny. */
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

/** Agent authority comes from its Tool allowlist; intersection is the delegation boundary. */
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

/** Static resources cover the type and dotted children. */
function coversTargetType(resource: string, targetType: string): boolean {
  return targetType === resource || targetType.startsWith(`${resource}.`);
}
