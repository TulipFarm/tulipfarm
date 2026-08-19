import type { DurableWaitManager } from "@tulipfarm/run-kernel";
import type { ApprovalRow, ApprovalsRepo } from "./repo";

/** Pending Tool approval projected from durable rows, not in-process Worker state. */
export interface PendingToolApproval {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Pending Tool approvals, oldest first, as the repository orders them. */
export async function listPendingToolApprovals(
  repo: Pick<ApprovalsRepo, "listPending">
): Promise<PendingToolApproval[]> {
  const rows = await repo.listPending("tool_call");
  return rows.map((row) => {
    const payload =
      typeof row.payload === "object" && row.payload !== null
        ? (row.payload as Record<string, unknown>)
        : {};
    return {
      approvalId: row.id,
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "unknown-tool-call",
      toolName: typeof payload.toolName === "string" ? payload.toolName : "unknown-tool",
      args: payload.args,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** Pending Routine approvals whose durable wait admits one of the caller's roles. */
export async function listPendingRoutineApprovals(
  repo: Pick<ApprovalsRepo, "listPending">,
  waits: Pick<DurableWaitManager, "find">,
  input: { businessId: string; roles: readonly string[] }
): Promise<ApprovalRow[]> {
  const held = new Set(input.roles.map((role) => `role:${role}`));
  const rows = await repo.listPending("routine_state");
  const authorized = await Promise.all(
    rows.map(async (row) => {
      const payload = payloadOf(row);
      if (
        payload.waitId === undefined ||
        payload.runId === undefined ||
        payload.resumeToken === undefined
      ) {
        return null;
      }
      const wait = await waits.find(input.businessId, payload.waitId);
      return wait?.allowedPrincipals.some((principal) => held.has(principal)) ? row : null;
    })
  );
  return authorized.flatMap((row) => (row === null ? [] : [row]));
}

function payloadOf(row: ApprovalRow): { waitId?: string; runId?: string; resumeToken?: string } {
  return typeof row.payload === "object" && row.payload !== null
    ? (row.payload as { waitId?: string; runId?: string; resumeToken?: string })
    : {};
}
