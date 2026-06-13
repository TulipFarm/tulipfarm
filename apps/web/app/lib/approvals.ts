import { apiGet } from "./api";

// Re-export the existing decide POST so the approvals feature has one import surface (chat untouched).
export { sendApprovalDecision } from "./chat/sse-client";

/*
 * Read-only client for the pending-approvals list (GET /api/v1/approvals). Ephemeral,
 * single-trust V1: returns ALL pending tool approvals (no per-user filter). Mirrors lib/agents.ts
 * conventions (cookie-first auth, ApiError on non-2xx). The sidebar badge and the Approvals page
 * both poll this via the shared ApprovalsProvider.
 */

export type PendingApproval = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expiresAt: string;
  createdAt: string;
};

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const body = await apiGet<{ items: PendingApproval[] }>("/api/v1/approvals");
  return body.items;
}
