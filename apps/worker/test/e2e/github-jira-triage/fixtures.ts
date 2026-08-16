import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import {
  GITHUB_TOOL_CONTRACTS,
  GITHUB_TOOL_IDS,
  JIRA_TOOL_CONTRACTS,
  JIRA_TOOL_IDS,
} from "@tulipfarm/integrations";
import type { CompiledState, IdentityCeiling } from "@tulipfarm/run-kernel";
import {
  type AccessGrantDefinition,
  parseYamlDocument,
  type SchemaRegistry,
} from "@tulipfarm/schema";
import { ToolCatalog } from "@tulipfarm/tool-broker";

/**
 * The authored triage example the end-to-end tests run against: its identifiers, the policy that
 * governs it, the shapes the tests assert on, and the readers that load its YAML.
 *
 * Everything here is fixed before a Run starts. It is kept apart from the harness so a test can
 * read what the example *is* — which Tools it may call, which two steps a human signs off, which
 * data class may leave for which provider — without reading how the harness drives it.
 */

export const EXAMPLES_DIR = join(
  import.meta.dirname,
  "../../../../../examples/github-issue-triage"
);

export const BUSINESS_ID = "biz-triage";
export const REPOSITORY = "tulip/farm";
export const JIRA_SITE_URL = "https://tulip.atlassian.net";
export const GUARDRAIL_REVISION = "guardrail-rev-1";
export const APPROVER_ROLE = "issue-triage-approver";
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

export const AGENT_PRINCIPAL_ID = "66666666-6666-4666-8666-666666666666";
export const ROUTINE_PRINCIPAL_ID = "principal-routine";
export const GITHUB_INTEGRATION_ID = "44444444-4444-4444-8444-444444444444";
export const JIRA_INTEGRATION_ID = "55555555-5555-4555-8555-555555555555";

export const GITHUB_SECRET_REF = "secret://integrations/github/issue-triage";
export const JIRA_SECRET_REF = "secret://integrations/jira/issue-triage";
export const GITHUB_CREDENTIAL = "github-installation-token-7f3a";
export const JIRA_CREDENTIAL = "jira-api-token-91b2";
export const WEBHOOK_SECRET = "webhook-signing-secret";

export const TOOL_ABILITIES = [
  GITHUB_TOOL_IDS.issueRead,
  GITHUB_TOOL_IDS.issueSearch,
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.issueLabel,
  GITHUB_TOOL_IDS.issueAssign,
  GITHUB_TOOL_IDS.issueClose,
  JIRA_TOOL_IDS.issueCreate,
  JIRA_TOOL_IDS.userAvailability,
];

export const IDENTITY_CEILING: IdentityCeiling = {
  principalKind: "agent",
  principalId: AGENT_PRINCIPAL_ID,
  grants: TOOL_ABILITIES,
  maxRiskClass: "high",
};

/** The published GitHub and Jira contracts, loaded exactly as the worker loads them. */
export function triageCatalog(): ToolCatalog {
  return ToolCatalog.load([...GITHUB_TOOL_CONTRACTS, ...JIRA_TOOL_CONTRACTS]);
}

export interface TriageClassification {
  readonly duplicate: boolean;
  readonly duplicateOfIssue?: number;
  readonly labels: readonly string[];
  readonly summary: string;
  readonly reply: string;
  readonly candidateAccountIds: readonly string[];
}

export type TriageStepStatus =
  | "completed"
  | "awaiting_approval"
  | "ambiguous"
  | "failed"
  | "cancelled";

export interface TriageStep {
  readonly state: string;
  readonly status: TriageStepStatus;
  readonly effectId?: string;
}

export interface TriageResult {
  readonly outcome: "completed" | "awaiting_approval" | "blocked" | "cancelled";
  readonly deliveryId: string;
  readonly issueNumber: number;
  readonly steps: readonly TriageStep[];
  readonly citations: readonly string[];
  readonly pendingApprovalId?: string;
  readonly blockedReason?: string;
}

export interface IngressResult {
  readonly status: number;
  readonly outcome?: "accepted" | "duplicate";
  readonly code?: string;
}

export interface DeliveryInput {
  readonly deliveryId: string;
  readonly issueNumber: number;
}

export function readDefinition(file: string): unknown {
  return parseYamlDocument(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
}

export function accessGrant(registry: SchemaRegistry, file: string): AccessGrantDefinition {
  return registry.validate(readDefinition(file)).document as AccessGrantDefinition;
}

export function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

export function authoredString(state: CompiledState, key: string): string {
  const value = authored(state)[key];
  if (typeof value !== "string") throw new Error(`missing ${key} on state ${state.name}`);
  return value;
}

export function toolRefOf(state: CompiledState): {
  readonly name: string;
  readonly version: string;
} {
  const ref = authored(state).toolRef;
  if (ref === null || typeof ref !== "object") throw new Error(`missing toolRef on ${state.name}`);
  const { name, version } = ref as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`malformed toolRef on ${state.name}`);
  }
  return { name, version };
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

/** Routine-level authority is broad here; adapter AccessGrants do target narrowing. */
export const AUTHORITY_LAYERS: readonly AuthorityLayer[] = [
  { name: "routine", grants: [{ action: "*", resourceType: "*", effect: "allow" }] },
];

/** Assigning and closing are the two steps a human signs off; everything else is policy-allowed. */
export const GUARDRAIL_RULES: readonly GuardrailRule[] = [
  { id: "triage-allow", effect: "allow", action: "*", resourceType: "*" },
  {
    id: "triage-approve-assign",
    effect: "require_approval",
    action: GITHUB_TOOL_IDS.issueAssign,
    resourceType: "*",
  },
  {
    id: "triage-approve-close",
    effect: "require_approval",
    action: GITHUB_TOOL_IDS.issueClose,
    resourceType: "*",
  },
];

export const DLP_RULES: readonly DlpRule[] = [
  { dataClass: "source_content", allowedDestinations: ["github", "jira"] },
  { dataClass: "directory", allowedDestinations: ["jira"] },
];
