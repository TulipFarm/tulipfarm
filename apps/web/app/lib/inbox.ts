import { apiCommand, apiGet } from "./api";

export type InboxItemModel = {
  id: string;
  kind: "approval" | "human_task" | "form" | "access_request";
  title: string;
  status: string;
  risk: "low" | "medium" | "high";
  intentDigest?: string;
  guardrailRevision?: string;
  target?: string;
  destination?: string;
  fields?: string[];
  expiresAt?: string;
  decisions: number;
  requiredDecisions: number;
  canDecide: boolean;
  denialReason?: string;
};

export async function getInbox(): Promise<InboxItemModel[]> {
  return (await apiGet<{ items: InboxItemModel[] }>("/api/v1/inbox")).items;
}

export function decideApproval(
  item: InboxItemModel,
  decision: "approved" | "denied",
  comment?: string
): Promise<{
  approvalId: string;
  status: "pending" | "approved" | "denied";
  decisions: number;
  requiredDecisions: number;
}> {
  return apiCommand(
    `/api/v1/approvals/${encodeURIComponent(item.id)}/decisions`,
    { decision, comment },
    `${item.id}-${decision}-${item.decisions}`
  );
}
