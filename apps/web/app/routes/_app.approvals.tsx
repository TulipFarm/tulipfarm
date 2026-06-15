import type { MetaFunction } from "@remix-run/react";
import { useRef } from "react";
import { ApprovalCard } from "~/components/chat/approval-card";
import { EmptyState } from "~/components/empty-state";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { type PendingApproval, sendApprovalDecision } from "~/lib/approvals";
import { useApprovals } from "~/lib/approvals-context";

export const meta: MetaFunction = () => [{ title: "Approvals · tulipfarm" }];

// One-line, truncated args preview for a list row — the standalone approver needs to see WHAT the
// gated tool will do (the inline chat card shows only the tool name + countdown). Guards non-JSON.
function describeArgs(args: unknown): string {
  if (args == null) return "(no args)";
  try {
    return JSON.stringify(args);
  } catch {
    return "(unserializable args)";
  }
}

function ApprovalRow({
  item,
  onDecide,
}: {
  item: PendingApproval;
  onDecide: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  const full = describeArgs(item.args);
  const short = full.length > 160 ? `${full.slice(0, 160)}…` : full;
  return (
    // toolCallId retained as the anchor for a future "jump to the originating conversation" link
    // (chat rehydration-by-id is deferred in V1).
    <li className="flex flex-col gap-1.5 px-3 py-3" data-tool-call-id={item.toolCallId}>
      <ApprovalCard
        toolName={item.toolName}
        approval={{ approvalId: item.approvalId, status: "pending", expiresAt: item.expiresAt }}
        onDecide={(decision) => onDecide(item.approvalId, decision)}
      />
      <p className="truncate font-mono text-xs text-muted-foreground" title={full}>
        <span aria-hidden className="text-primary">
          args{" "}
        </span>
        <span>{short}</span>
      </p>
    </li>
  );
}

export default function ApprovalsPage() {
  const { approvals, loading, error, refresh } = useApprovals();
  // Approval ids with a decide POST in flight — guards a double-click from firing two decisions for
  // the same id (the second would 404 against the already-settled registry entry).
  const deciding = useRef<Set<string>>(new Set());

  // Decide via the existing decide route, then reconcile the shared context so the badge + list
  // update together. A 404 lost-race with the 5-min auto-deny is benign — the refresh drops the row.
  const handleDecide = async (approvalId: string, decision: "approve" | "deny") => {
    if (deciding.current.has(approvalId)) return;
    deciding.current.add(approvalId);
    try {
      await sendApprovalDecision(approvalId, decision);
    } catch {
      // The approval-resolved SSE is the run's source of truth; the refresh below reconciles the list.
    }
    await refresh();
    deciding.current.delete(approvalId);
  };

  if (loading && approvals.length === 0 && !error) {
    return (
      <ResourcePanel crumbs={[{ label: "approvals" }]}>
        <p className="text-xs text-muted-foreground">loading…</p>
      </ResourcePanel>
    );
  }

  // Only blank the page for an error when there's nothing cached to show; otherwise prefer stale data.
  if (error && approvals.length === 0) {
    return <ErrorState section="approvals" message={error} />;
  }

  if (approvals.length === 0) {
    return (
      <EmptyState
        section="approvals"
        title="Approvals"
        hint="No pending approvals. Gated tool calls awaiting a decision appear here (with full context in the chat that triggered them). Approvals are in-memory in V1 and clear on API restart."
      />
    );
  }

  return (
    <ResourcePanel crumbs={[{ label: "approvals" }]}>
      <p className="text-xs text-muted-foreground">{approvals.length} pending</p>
      <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
        {approvals.map((item) => (
          <ApprovalRow key={item.approvalId} item={item} onDecide={handleDecide} />
        ))}
      </ul>
    </ResourcePanel>
  );
}
