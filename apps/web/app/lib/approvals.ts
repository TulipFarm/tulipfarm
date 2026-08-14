import { apiGet } from "./api";

export { sendApprovalDecision } from "./chat/sse-client";

/*
 * Read-only client for the pending-approvals list (GET /api/v1/approvals). Mirrors
 * lib/agents.ts conventions (cookie-first auth, ApiError on non-2xx).
 */

export type PendingApproval = {
  approvalId: string;
  kind?: "tool_call" | "routine_state";
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  routineSlug?: string;
  runId?: string;
  stateName?: string;
  summary?: unknown;
  expiresAt: string;
  createdAt: string;
};

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const body = await apiGet<{ items: PendingApproval[] }>("/api/v1/approvals");
  return body.items;
}
