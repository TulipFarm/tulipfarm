import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ActivityService } from "../activity/service";
import type { ApprovalsRepo } from "../approvals/repo";
import type { ApprovalRegistry } from "../chat/approvals";
import type {
  ApprovalDecisionInput,
  InboxItemReadModel,
  OperationalApiDeps,
  OperationalGrant,
  OperationalPermission,
} from "./routes";

type RuntimeOperationalDeps = {
  activity: Pick<ActivityService, "list">;
  approvals: Pick<ApprovalsRepo, "findById" | "listPending" | "settle">;
  approvalRegistry: Pick<ApprovalRegistry, "decide" | "listPending">;
  enqueueWake(job: {
    runId: string;
    reason: "approval";
    token: string;
    decision: "approved" | "denied";
  }): Promise<void>;
  guardrailsConfig(): unknown;
};

const ADMIN_PERMISSIONS: readonly OperationalPermission[] = [
  "runs:read",
  "operations:read",
  "guardrails:read",
  "approvals:read",
  "approvals:decide",
  "roles:read",
];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailable(): never {
  throw new Error("operational control is not available from this runtime");
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

function toolApproval(
  item: ReturnType<ApprovalRegistry["listPending"]>[number]
): InboxItemReadModel {
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

    async listRuns() {
      return { items: [], nextCursor: null };
    },

    async getRun() {
      return null;
    },

    async commandRun() {
      return unavailable();
    },

    async getOperations() {
      const activity = await deps.activity.list({ limit: 50 });
      const audit = activity.items.map(safeActivity);
      return {
        health: [{ component: "api", status: "ok" }],
        incidents: audit.filter((item) => item.status === "error"),
        quarantine: [],
        killSwitches:
          process.env.HOOKS_DISABLED === "true"
            ? [{ id: "hooks", status: "enabled", scope: "all hooks" }]
            : [],
        audit,
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
      return unavailable();
    },

    async proposeAgentChangeset() {
      return unavailable();
    },

    async getInbox() {
      const [toolCalls, routineRows] = await Promise.all([
        Promise.resolve(deps.approvalRegistry.listPending()),
        deps.approvals.listPending("routine_state"),
      ]);
      return {
        items: [...toolCalls.map(toolApproval), ...routineRows.map(routineApproval)],
      };
    },

    async decideApproval(_grant, input: ApprovalDecisionInput) {
      const cached = decisions.get(input.idempotencyKey);
      if (cached) return cached;

      const resolved = deps.approvalRegistry.decide(input.approvalId, input.decision);
      if (!resolved) {
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
      return { revision: digest([]), items: [] };
    },

    async proposeRoleChangeset() {
      return unavailable();
    },

    async commandOperation() {
      return unavailable();
    },
  };
}
