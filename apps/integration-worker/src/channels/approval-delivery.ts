import type { IntegrationHttpPort } from "@tulipfarm/integrations";
import type {
  ChannelRunDeliveryStore,
  PersistedChannelRunDeliveryRecord,
} from "@tulipfarm/storage";
import type { InternalApiClient } from "../internal/client";

interface PendingApprovalResponse {
  pending: boolean;
  approvalId?: string;
  toolName?: string;
  args?: unknown;
}

interface PostMessageResponse {
  ok?: unknown;
  ts?: unknown;
}

function slackMessageTs(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as PostMessageResponse;
  return record.ok === true && typeof record.ts === "string" ? record.ts : undefined;
}

function summarize(args: unknown): string {
  if (args === undefined || args === null) return "(no arguments)";
  const text = JSON.stringify(args);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** Approve/Deny Block Kit; a click carries `{approvalId, decision}` straight in the button value. */
function approvalBlocks(toolName: string, args: unknown, approvalId: string): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed*\n\`${toolName}\`\n\`\`\`${summarize(args)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "channel_approval_decide",
          value: JSON.stringify({ approvalId, decision: "approved" }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: "channel_approval_decide",
          value: JSON.stringify({ approvalId, decision: "denied" }),
        },
      ],
    },
  ];
}

export interface ApprovalDeliveryDeps {
  businessId: string;
  internalApi: InternalApiClient;
  http: IntegrationHttpPort;
  credential: string;
  runDeliveries: ChannelRunDeliveryStore;
  log: { warn: (message: string, error?: unknown) => void };
}

/**
 * Posts the Approve/Deny prompt for a Channel-originated Run parked on a tool-call approval —
 * once per approval. `approvalPostedId` on the correlation row is what makes this idempotent
 * across poll ticks; a *new* `approvalId` (a Run can ask for more than one approval in its
 * lifetime) posts again.
 */
export async function deliverPendingApproval(
  row: PersistedChannelRunDeliveryRecord,
  deps: ApprovalDeliveryDeps
): Promise<void> {
  let pending: PendingApprovalResponse;
  try {
    pending = await deps.internalApi.require<PendingApprovalResponse>(
      "GET",
      `/api/v1/internal/channels/runs/${row.runId}/pending-approval`
    );
  } catch (error) {
    deps.log.warn(`pending-approval check failed for run ${row.runId}`, error);
    return;
  }
  if (!pending.pending || pending.approvalId === undefined) return;
  if (pending.approvalId === row.approvalPostedId) return;

  try {
    const posted = await deps.http.send(
      {
        method: "POST",
        path: "/chat.postMessage",
        body: {
          channel: row.destination,
          ...(row.threadId === undefined ? {} : { thread_ts: row.threadId }),
          text: "Approval needed",
          blocks: approvalBlocks(
            pending.toolName ?? "unknown tool",
            pending.args,
            pending.approvalId
          ),
        },
      },
      deps.credential
    );
    const ts = slackMessageTs(posted.body);
    if (ts === undefined) return;
    await deps.runDeliveries.setApprovalPosted(deps.businessId, row.runId, pending.approvalId, ts);
  } catch (error) {
    deps.log.warn(`approval prompt post failed for run ${row.runId}`, error);
  }
}
