import { useState } from "react";
import { A2uiFrame } from "~/components/a2ui-frame";
import type { PlanStep, SourceRef, StepStatus, TimelinePart } from "~/lib/chat/types";
import { cn } from "~/lib/utils";
import { ApprovalCard } from "./approval-card";
import { Response } from "./response";

const STEP_MARK: Record<StepStatus, string> = {
  pending: "[ ]",
  running: "[~]",
  done: "[x]",
  error: "[!]",
};

function Label({ text }: { text: string }) {
  return <span className="text-xs uppercase tracking-[0.15em] text-muted-foreground">{text}</span>;
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-sm border border-border bg-muted p-2 text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ReasoningPart({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-sm border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        [reasoning]
      </button>
      {open ? (
        <div className="whitespace-pre-wrap border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  );
}

function PlanPart({ title, steps }: { title?: string; steps: PlanStep[] }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <Label text="[plan]" />
        {title ? <span className="text-foreground">{title}</span> : null}
      </div>
      <ul className="space-y-0.5">
        {steps.map((s) => (
          <li key={s.id} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className={cn(
                "tabular-nums",
                s.status === "done"
                  ? "text-primary"
                  : s.status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground"
              )}
            >
              {STEP_MARK[s.status]}
            </span>
            <span className={cn(s.status === "done" && "text-muted-foreground line-through")}>
              {s.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourcesPart({ sources }: { sources: SourceRef[] }) {
  return (
    <div className="text-sm">
      <Label text="[sources]" />
      <ul className="mt-1 space-y-0.5">
        {sources.map((s, i) => (
          <li key={s.id ?? s.url ?? `${s.title ?? "source"}-${i}`}>
            {s.url ? (
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2 hover:opacity-80"
              >
                {s.title ?? s.url}
              </a>
            ) : (
              <span className="text-muted-foreground">{s.title ?? "source"}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Render one timeline part. Tool parts also host the live approval card when one is attached. */
export function MessagePartView({
  part,
  streaming,
  onApprove,
}: {
  part: TimelinePart;
  streaming?: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  switch (part.kind) {
    case "text":
      return <Response text={part.text} streaming={streaming} />;
    case "reasoning":
      return <ReasoningPart text={part.text} />;
    case "tool": {
      const approval = part.approval;
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                part.status === "done"
                  ? "bg-muted-foreground"
                  : "bg-primary motion-safe:animate-pulse"
              )}
            />
            <Label text={`[tool: ${part.toolName}]`} />
          </div>
          {part.args != null ? <Json value={part.args} /> : null}
          {approval ? (
            <ApprovalCard
              toolName={part.toolName}
              approval={approval}
              onDecide={(d) => onApprove(approval.approvalId, d)}
            />
          ) : null}
          {part.result !== undefined ? <Json value={part.result} /> : null}
        </div>
      );
    }
    case "plan":
      return <PlanPart title={part.title} steps={part.steps} />;
    case "task":
      return (
        <p className="flex items-baseline gap-2 text-sm">
          <Label text="[task]" />
          <span>
            {STEP_MARK[part.status]} {part.label}
          </span>
        </p>
      );
    case "sources":
      return <SourcesPart sources={part.sources} />;
    case "agent-handoff":
      return (
        <p className="text-sm text-muted-foreground">
          <span className="text-primary">→</span> handing off to{" "}
          <span className="text-foreground">{part.to}</span>
          {part.reason ? <span> · {part.reason}</span> : null}
        </p>
      );
    case "a2ui":
      return <A2uiFrame html={part.html} className="w-full rounded-sm border border-border" />;
  }
}
