import type { BudgetExhaustionPolicy } from "@tulipfarm/storage";
import type { FastifyRequest } from "fastify";

export type OperationalPermission =
  | "runs:read"
  | "runs:control"
  | "operations:read"
  | "guardrails:read"
  | "guardrails:write"
  | "agents:write"
  | "approvals:read"
  | "approvals:decide"
  | "roles:read"
  | "roles:write"
  | "operations:control";

export interface OperationalGrant {
  readonly businessId: string;
  readonly principalId: string;
  readonly permissions: readonly OperationalPermission[];
}

export interface RunStateReadModel {
  readonly key: string;
  readonly status: string;
  readonly attempts: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errorEvidenceRef?: string;
}

export interface RunReadModel {
  readonly id: string;
  readonly routineId: string;
  readonly routineVersion: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly states: readonly RunStateReadModel[];
  readonly effects: readonly Record<string, unknown>[];
  readonly waits: readonly Record<string, unknown>[];
  readonly guardrailDecisions: readonly Record<string, unknown>[];
  readonly lineage: readonly Record<string, unknown>[];
  readonly costs: { readonly amountUsd: number; readonly modelTokens: number };
}

/**
 * One limit key of a Run's write-once budget ledger (`run_budgets`), projected for reading: the
 * committed ceiling, how much has been consumed against it, and the exhaustion policy that applies
 * once it is spent. This is the enforced ledger, not a recomputation.
 */
export interface RunBudgetReadModel {
  readonly key: string;
  readonly limit: number;
  readonly consumed: number;
  readonly exhaustionPolicy: BudgetExhaustionPolicy;
}

export type RunCommandAction = "pause" | "resume" | "cancel" | "retry" | "reconcile";

export interface RunCommandInput {
  readonly action: RunCommandAction;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface OperationsReadModel {
  readonly health: readonly Record<string, unknown>[];
  readonly incidents: readonly Record<string, unknown>[];
  readonly quarantine: readonly Record<string, unknown>[];
  readonly killSwitches: readonly Record<string, unknown>[];
  /** Activity feed entries, not audit-ledger events; the ledger is `/api/v1/audit/events`. */
  readonly activity: readonly Record<string, unknown>[];
  readonly recovery: {
    readonly supportBundleAvailable: boolean;
    readonly lastBackupAt: string | null;
  };
}

export interface GuardrailsReadModel {
  readonly revision: string;
  readonly items: readonly Record<string, unknown>[];
}

export interface GuardrailChangesetInput {
  readonly baseRevision: string;
  readonly changes: readonly {
    readonly op: "add" | "remove" | "replace";
    readonly path: string;
    readonly value?: unknown;
  }[];
  readonly idempotencyKey: string;
}

export interface AgentChangesetInput {
  readonly agentId: string;
  readonly baseVersion: string;
  readonly candidateVersion: string;
  readonly patch: Record<string, unknown>;
  readonly idempotencyKey: string;
}

export interface InboxItemReadModel {
  readonly id: string;
  readonly kind: "approval" | "human_task" | "form" | "access_request";
  readonly title: string;
  readonly status: string;
  readonly risk: "low" | "medium" | "high";
  readonly intentDigest?: string;
  readonly guardrailRevision?: string;
  readonly target?: string;
  readonly destination?: string;
  readonly fields?: readonly string[];
  readonly expiresAt?: string;
  readonly decisions: number;
  readonly requiredDecisions: number;
  readonly canDecide: boolean;
  readonly denialReason?: string;
}

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly comment?: string;
  readonly idempotencyKey: string;
}

export interface RolesReadModel {
  readonly revision: string;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly principalKinds: readonly string[];
    readonly grants: readonly string[];
    readonly conditions: readonly string[];
  }[];
}

export interface OperationalApiDeps {
  authorize(req: FastifyRequest): Promise<OperationalGrant | null>;
  listRuns(
    grant: OperationalGrant,
    options: { cursor?: string; limit: number }
  ): Promise<{ items: readonly RunReadModel[]; nextCursor: string | null }>;
  getRun(grant: OperationalGrant, runId: string): Promise<RunReadModel | null>;
  /**
   * The write-once budget ledger for one Run. `null` denies existence (unknown Run, or a Run owned
   * by another business — the two are indistinguishable), which the route answers as `404`.
   */
  getRunBudgets(
    grant: OperationalGrant,
    runId: string
  ): Promise<readonly RunBudgetReadModel[] | null>;
  commandRun(
    grant: OperationalGrant,
    input: RunCommandInput
  ): Promise<{ commandId: string; runId: string; status: "accepted" | "duplicate" }>;
  getOperations(grant: OperationalGrant): Promise<OperationsReadModel>;
  getGuardrails(grant: OperationalGrant): Promise<GuardrailsReadModel>;
  proposeGuardrailChangeset(
    grant: OperationalGrant,
    input: GuardrailChangesetInput
  ): Promise<{
    changesetId: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  proposeAgentChangeset(
    grant: OperationalGrant,
    input: AgentChangesetInput
  ): Promise<{
    changesetId: string;
    candidateVersion: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  getInbox(grant: OperationalGrant): Promise<{ items: readonly InboxItemReadModel[] }>;
  decideApproval(
    grant: OperationalGrant,
    input: ApprovalDecisionInput
  ): Promise<{
    approvalId: string;
    status: "pending" | "approved" | "denied";
    decisions: number;
    requiredDecisions: number;
  }>;
  getRoles(grant: OperationalGrant): Promise<RolesReadModel>;
  proposeRoleChangeset(
    grant: OperationalGrant,
    input: {
      baseRevision: string;
      role: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<{
    changesetId: string;
    status: "validated" | "awaiting_approval" | "published";
  }>;
  commandOperation(
    grant: OperationalGrant,
    input: {
      action: "support-bundle.create" | "kill-switch.set" | "quarantine.resolve" | "recovery.start";
      parameters: Record<string, unknown>;
      idempotencyKey: string;
    }
  ): Promise<{ commandId: string; status: "accepted" | "duplicate" }>;
}
