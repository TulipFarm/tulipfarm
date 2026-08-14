import { useEffect, useState } from "react";
import type { ApprovalState } from "~/lib/chat/types";

function secondsLeft(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

const OUTCOME_LABEL: Record<ApprovalState["status"], string> = {
  pending: "pending",
  approved: "approved",
  denied: "denied",
  timeout: "timed out",
};

/** Denial is `approval.status`, not a tool failure. */
export function ApprovalCard({
  toolName,
  approval,
  onDecide,
}: {
  toolName: string;
  approval: ApprovalState;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const pending = approval.status === "pending";
  const [left, setLeft] = useState<number | null>(() => secondsLeft(approval.expiresAt));

  useEffect(() => {
    if (!pending) return;
    setLeft(secondsLeft(approval.expiresAt));
    const id = setInterval(() => setLeft(secondsLeft(approval.expiresAt)), 1000);
    return () => clearInterval(id);
  }, [pending, approval.expiresAt]);

  return (
    <div className="rounded-sm border border-primary/60 bg-secondary px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-primary">
        <span aria-hidden>[approval required]</span>
        <span className="normal-case tracking-normal text-muted-foreground">{toolName}</span>
        {pending && left !== null ? (
          <span className="ml-auto tabular-nums text-muted-foreground">{left}s</span>
        ) : null}
      </div>
      {pending ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide("approve")}
            className="rounded-sm bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            approve
          </button>
          <button
            type="button"
            onClick={() => onDecide("deny")}
            className="rounded-sm border border-destructive px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            deny
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{OUTCOME_LABEL[approval.status]}</p>
      )}
    </div>
  );
}
