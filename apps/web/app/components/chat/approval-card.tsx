import { type ComponentType, useEffect, useState } from "react";
import { Check, Clock, ShieldAlert, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ToolChip } from "~/components/ui/tool-chip";
import type { ApprovalState } from "~/lib/chat/types";
import { cn } from "~/lib/utils";

function secondsLeft(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** Past tense, and neutral about who decided: on a shared instance it was not necessarily you. */
const OUTCOME: Record<
  Exclude<ApprovalState["status"], "pending">,
  { label: string; Icon: ComponentType<{ className?: string }>; tone: string }
> = {
  approved: { label: "Approved", Icon: Check, tone: "text-run-ok" },
  // A denial is a decision, not a crash. It reads as stopped, never as broken.
  denied: { label: "Denied", Icon: X, tone: "text-run-blocked" },
  timeout: { label: "Expired without a decision", Icon: Clock, tone: "text-run-blocked" },
};

/** Under the glyph and its gap, so the controls hang beneath the sentence they answer. */
const LABEL_INSET = "ml-[22px]";

/**
 * The one thing a Trace is not allowed to hide: a question addressed to the reader.
 *
 * It draws as a step on the rail rather than as a bordered card. It does not need the box — in a
 * surface with no chrome anywhere, one filled button is the loudest thing on screen, and the rail
 * around it stays quiet enough for that to carry. A box would have spent a border, a radius and a
 * fill making an ask conspicuous among steps that already whisper.
 *
 * Once decided it collapses to a single settled line, no heavier than the steps either side of it,
 * because the ask is over and the record is all that is left.
 */
export function ApprovalCard({
  toolName,
  approval,
  onDecide,
}: {
  toolName: string;
  approval: ApprovalState;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const status = approval.status;
  const pending = status === "pending";
  const [left, setLeft] = useState<number | null>(() => secondsLeft(approval.expiresAt));

  useEffect(() => {
    if (!pending) return;
    setLeft(secondsLeft(approval.expiresAt));
    const id = setInterval(() => setLeft(secondsLeft(approval.expiresAt)), 1000);
    return () => clearInterval(id);
  }, [pending, approval.expiresAt]);

  if (status !== "pending") {
    const { label, Icon, tone } = OUTCOME[status];
    return (
      <div className="tf-trace-row -mx-1.5 flex items-center gap-2 px-1.5 py-1">
        <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />
        <span className="shrink-0 truncate text-sm text-muted-foreground">{label}</span>
        <ToolChip mono>{toolName}</ToolChip>
      </div>
    );
  }

  // Under ten seconds the number stops being context and starts being pressure.
  const urgent = left !== null && left <= 10;

  return (
    <div className="py-0.5">
      <div className="tf-trace-row -mx-1.5 flex items-center gap-2 px-1.5 py-1">
        <ShieldAlert aria-hidden className="size-3.5 shrink-0 text-run-blocked" />
        {/* The only label in a trace set in medium: the rail is narrating, this one is asking. */}
        <span className="shrink-0 truncate text-sm font-medium text-foreground">
          Needs your approval
        </span>
        <ToolChip mono>{toolName}</ToolChip>
        {left === null ? null : (
          <span
            className={cn(
              "ml-auto shrink-0 font-mono text-xs tabular-nums transition-colors",
              urgent ? "text-run-error" : "text-muted-foreground"
            )}
          >
            <span aria-hidden>{`${left}s`}</span>
            {/* A bare number is meaningless read aloud; the sentence carries what runs out. */}
            <span className="sr-only">{`Expires in ${left} seconds`}</span>
          </span>
        )}
      </div>

      <div className={cn(LABEL_INSET, "mt-1 flex items-center gap-2")}>
        <Button type="button" size="sm" onClick={() => onDecide("approve")}>
          Approve
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onDecide("deny")}>
          Deny
        </Button>
      </div>

      {/*
       * Assertive on purpose. Every other announcement in a Trace is `status` — narration the
       * reader may ignore — but this one blocks the Turn until they act.
       */}
      <span role="alert" className="sr-only">{`${toolName} needs your approval`}</span>
    </div>
  );
}
