import { ApiError, apiCommand, apiGet } from "./api";

export type InboxItemModel = {
  id: string;
  kind: "approval" | "notification" | "human_task" | "form" | "access_request";
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
  representedTeamId?: string;
  createdAt?: string;
};

export async function getInbox(): Promise<InboxItemModel[]> {
  const [work, notifications] = await Promise.all([
    apiGet<{ items: InboxItemModel[] }>("/api/v1/inbox").catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return { items: [] };
      throw error;
    }),
    apiGet<{
      items: Array<{ id: string; kind: string; title: string; createdAt: string }>;
    }>("/api/v1/team-notifications"),
  ]);
  return [
    ...work.items,
    ...notifications.items.map((item) => ({
      id: item.id,
      kind: "notification" as const,
      title: item.title,
      status: "new",
      risk: "low" as const,
      decisions: 0,
      requiredDecisions: 0,
      canDecide: false,
      createdAt: item.createdAt,
    })),
  ];
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
    {
      decision,
      comment,
      ...(item.representedTeamId ? { representedTeamId: item.representedTeamId } : {}),
    },
    `${item.id}-${decision}-${item.decisions}`
  );
}
