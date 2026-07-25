import { ajv } from "@tulipfarm/schema";
import {
  authorizeToolIntent,
  type ToolAuthorizationContext,
  type ToolAuthorizationDenialReason,
} from "./authorize";
import type { ToolCatalog } from "./catalog";
import type { PublishedToolContract } from "./contract";
import { intentDigest, normalizeToolIntent, type ToolIntent } from "./intent";
import { assessToolRisk, type ToolRiskAssessment } from "./risk";

export type ToolBrokerDenialReason =
  | ToolAuthorizationDenialReason
  | "invalid_intent"
  | "invalid_arguments"
  | "unknown_contract"
  | "contract_mismatch";

interface ToolBrokerOutcomeBase {
  readonly intent: ToolIntent;
  readonly intentDigest: string;
  readonly risk: ToolRiskAssessment;
  readonly guardrailRevision: string;
  readonly contract: PublishedToolContract;
}

export type ToolBrokerOutcome =
  | (ToolBrokerOutcomeBase & { readonly outcome: "authorized" })
  | (ToolBrokerOutcomeBase & { readonly outcome: "awaiting_approval" })
  | (Partial<ToolBrokerOutcomeBase> & {
      readonly outcome: "denied";
      readonly reason: ToolBrokerDenialReason;
    });

export class ToolBroker {
  constructor(private readonly catalog: ToolCatalog) {}

  authorize(input: unknown, context: ToolAuthorizationContext): ToolBrokerOutcome {
    let intent: ToolIntent;
    try {
      intent = normalizeToolIntent(input);
    } catch {
      return { outcome: "denied", reason: "invalid_intent" };
    }

    const contract = this.catalog.get(intent.toolId, intent.toolVersion);
    if (contract === undefined) return { outcome: "denied", reason: "unknown_contract" };
    const digest = intentDigest(intent);
    const risk = assessToolRisk(contract, context);
    const base = {
      intent,
      intentDigest: digest,
      risk,
      guardrailRevision: context.guardrailRevision,
      contract,
    };
    if (contract.action !== intent.action) {
      return { ...base, outcome: "denied", reason: "contract_mismatch" };
    }
    const validateArguments = ajv.compile(contract.inputSchema);
    if (!validateArguments(intent.arguments)) {
      return { ...base, outcome: "denied", reason: "invalid_arguments" };
    }

    const policy = authorizeToolIntent(intent, contract, context);
    if (policy.outcome === "denied") return { ...base, ...policy };
    return { ...base, outcome: policy.outcome };
  }
}
