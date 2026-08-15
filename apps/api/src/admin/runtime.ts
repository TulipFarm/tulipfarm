import { createHash } from "node:crypto";
import type { ApprovalsRepo, ToolApprovalService } from "@tulipfarm/tool-host";
import type { FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import { listPendingToolApprovals, type PendingToolApproval } from "../approvals/pending";
import { describeDeploymentRoles } from "../identity/roles";
import { type HealthProbe, probeHealth } from "./health";
import type {
  ApprovalDecisionInput,
  InboxItemReadModel,
  OperationalApiDeps,
  OperationalGrant,
  OperationalPermission,
} from "./routes";
import { OperationalNotImplementedError } from "./routes";
import type { RunReader } from "./run-reader";

type RuntimeOperationalDeps = {
  activity: Pick<ActivityService, "list">;
  approvals: Pick<ApprovalsRepo, "findById" | "listPending" | "settle">;
  /** Settles a Tool approval and resumes its parked Run; absent leaves only routine approvals. */
  toolApprovals?: Pick<ToolApprovalService, "signal">;
  runs: RunReader;
  healthProbes: readonly HealthProbe[];
  enqueueWake(job: {
    runId: string;
    reason: "approval";
    token: string;
    decision: "approved" | "denied";
  }): Promise<void>;
  guardrailsConfig(): unknown;
};

/** Admins get every defined operational permission; missing capabilities still return 501. */
const ADMIN_PERMISSIONS: readonly OperationalPermission[] = [
  "runs:read",
  "runs:control",
  "operations:read",
  "operations:control",
  "guardrails:read",
  "guardrails:write",
  "agents:write",
  "approvals:read",
  "approvals:decide",
  "roles:read",
  "roles:write",
];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Throws 501 for capabilities this deployment has not composed yet. */
function notImplemented(capability: string, blockedBy: string): never {
  throw new OperationalNotImplementedError(
    `${capability} is not available in this deployment: ${blockedBy}.`
  );
}

function safeActivity(item: Awaited<ReturnType<ActivityService["list"]>>["items"][number]) {
  return {
    id: item._id,
    category: item.category,
    action: item.action,
    actorType: item.actorType,
    targetType: item.targetType,
    targetId: item.targetId,
    summary: item.summary,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
  };
}

function toolApproval(item: PendingToolApproval): InboxItemReadModel {
  const args =
    typeof item.args === "object" && item.args !== null
      ? (item.args as Record<string, unknown>)
      : {};
  return {
    id: item.approvalId,
    kind: "approval",
    title: `Approve ${item.toolName}`,
    status: "pending",
    risk: "medium",
    intentDigest: digest({
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      args: item.args,
    }),
    target: item.toolName,
    fields: Object.keys(args).sort(),
    expiresAt: item.expiresAt,
    decisions: 0,
    requiredDecisions: 1,
    canDecide: true,
  };
}

function routineApproval(
  row: Awaited<ReturnType<ApprovalsRepo["listPending"]>>[number]
): InboxItemReadModel {
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : {};
  const routineSlug = typeof payload.routineSlug === "string" ? payload.routineSlug : "Routine";
  const stateName = typeof payload.stateName === "string" ? payload.stateName : "human task";
  const runId = typeof payload.runId === "string" ? payload.runId : undefined;
  return {
    id: row.id,
    kind: "approval",
    title: `${routineSlug}: ${stateName}`,
    status: row.status,
    risk: "medium",
    intentDigest: digest({
      approvalId: row.id,
      routineSlug,
      runId,
      stateName,
    }),
    target: runId,
    expiresAt: row.expiresAt.toISOString(),
    decisions: 0,
    requiredDecisions: 1,
    canDecide: true,
  };
}

export function createRuntimeOperationalApi(deps: RuntimeOperationalDeps): OperationalApiDeps {
  const decisions = new Map<
    string,
    {
      approvalId: string;
      status: "approved" | "denied";
      decisions: number;
      requiredDecisions: number;
    }
  >();

  return {
    async authorize(request: FastifyRequest): Promise<OperationalGrant | null> {
      const principal = request.principal;
      if (principal?.kind !== "user" || principal.role !== "admin") return null;
      return {
        businessId: principal.businessId,
        principalId: principal.id,
        permissions: ADMIN_PERMISSIONS,
      };
    },

    async listRuns(grant: OperationalGrant, options: { cursor?: string; limit: number }) {
      return deps.runs.list(grant.businessId, options);
    },

    async getRun(grant: OperationalGrant, runId: string) {
      return deps.runs.get(grant.businessId, runId);
    },

    async getRunBudgets(grant: OperationalGrant, runId: string) {
      return deps.runs.budgets(grant.businessId, runId);
    },

    async commandRun() {
      return notImplemented(
        "Run control",
        "no durable worker is running to act on the command (the Run authority lives in the worker)"
      );
    },

    async getOperations() {
      const [activity, health] = await Promise.all([
        deps.activity.list({ limit: 50 }),
        probeHealth(deps.healthProbes),
      ]);
      const recent = activity.items.map(safeActivity);
      return {
        health: health.map((component) => ({ ...component })),
        incidents: recent.filter((item) => item.status === "error"),
        // Quarantine and recovery are recorded by subsystems this deployment does not run yet.
        // Reported as empty because they are empty, not because the data is withheld.
        quarantine: [],
        killSwitches:
          process.env.HOOKS_DISABLED === "true"
            ? [{ id: "hooks", status: "enabled", scope: "all hooks" }]
            : [],
        activity: recent,
        recovery: { supportBundleAvailable: false, lastBackupAt: null },
      };
    },

    async getGuardrails() {
      const config = deps.guardrailsConfig();
      const items =
        typeof config === "object" && config !== null
          ? Object.entries(config).map(([name, policy]) => ({ name, policy }))
          : [];
      return { revision: digest(config), items };
    },

    async proposeGuardrailChangeset() {
      return notImplemented(
        "Guardrail authoring",
        "Soul writes do not route through the changeset gateway yet"
      );
    },

    async proposeAgentChangeset() {
      return notImplemented(
        "Agent authoring",
        "Soul writes do not route through the changeset gateway yet"
      );
    },

    async getInbox() {
      const [toolCalls, routineRows] = await Promise.all([
        listPendingToolApprovals(deps.approvals),
        deps.approvals.listPending("routine_state"),
      ]);
      return {
        items: [...toolCalls.map(toolApproval), ...routineRows.map(routineApproval)],
      };
    },

    async decideApproval(grant: OperationalGrant, input: ApprovalDecisionInput) {
      const cached = decisions.get(input.idempotencyKey);
      if (cached) return cached;

      // Tool approvals resume through their wait; `not_found` falls back to routine approvals.
      const signalled = await deps.toolApprovals?.signal({
        businessId: grant.businessId,
        approvalId: input.approvalId,
        decision: input.decision,
        principal: `user:${grant.principalId}`,
      });
      if (signalled === "forbidden") throw new Error("This approval is not yours to decide.");
      if (signalled === "already_settled")
        throw new Error("Approval not found or already resolved.");
      if (signalled !== "resumed") {
        const row = await deps.approvals.findById(input.approvalId);
        const payload =
          typeof row?.payload === "object" && row.payload !== null
            ? (row.payload as Record<string, unknown>)
            : {};
        const runId = typeof payload.runId === "string" ? payload.runId : undefined;
        if (row?.kind !== "routine_state" || row.status !== "pending" || !runId) {
          throw new Error("Approval not found or already resolved.");
        }
        await deps.approvals.settle(input.approvalId, input.decision);
        await deps.enqueueWake({
          runId,
          reason: "approval",
          token: `approval:${input.approvalId}`,
          decision: input.decision,
        });
      }

      const result = {
        approvalId: input.approvalId,
        status: input.decision,
        decisions: 1,
        requiredDecisions: 1,
      };
      decisions.set(input.idempotencyKey, result);
      return result;
    },

    async getRoles() {
      const items = describeDeploymentRoles();
      return { revision: digest(items), items };
    },

    async proposeRoleChangeset() {
      return notImplemented(
        "Role authoring",
        "roles are built into this deployment and have no changeset writer"
      );
    },

    async commandOperation() {
      return notImplemented(
        "Operational control",
        "support bundles, kill switches, quarantine, and recovery have no durable command authority yet"
      );
    },
  };
}
