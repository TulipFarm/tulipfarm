import type { ApprovalsRepo } from "./runtime-repo";

/**
 * A pending Tool approval as the operator surfaces show it.
 *
 * Projected from the row rather than from anything in this process: the turn that asked for the
 * approval runs in the Worker, so there is no in-memory continuation here to read it off. Whichever
 * API instance serves the list renders the same answer.
 */
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
