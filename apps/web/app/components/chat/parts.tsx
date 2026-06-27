import { Link } from "@remix-run/react";
import { type ReactNode, useState } from "react";
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

// Lightweight JSON syntax highlight tuned to the terminal palette: ruby keys, foreground values; the
// structure (braces/commas/colons/whitespace) inherits the <pre>'s muted base. No tokenizer dep — a
// single regex matches strings/numbers/literals, and a key is a string immediately followed by `:`.
const JSON_TOKEN = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlightJson(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  JSON_TOKEN.lastIndex = 0;
  for (let m = JSON_TOKEN.exec(json); m !== null; m = JSON_TOKEN.exec(json)) {
    if (m.index > last) out.push(json.slice(last, m.index));
    const token = m[0];
    const isKey = token.startsWith('"') && /^\s*:/.test(json.slice(m.index + token.length));
    out.push(
      <span key={key++} className={isKey ? "text-primary" : "text-foreground"}>
        {token}
      </span>
    );
    last = m.index + token.length;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-sm border border-border bg-muted p-2 text-xs text-muted-foreground">
      {highlightJson(JSON.stringify(value, null, 2))}
    </pre>
  );
}

/**
 * One tool call, collapsed by default. While the call is in-flight (no result yet, message still
 * streaming) the header shows a pulsing dot + "running…"; once it resolves it becomes a click-to-
 * expand accordion exposing the args + result. An attached approval card stays always-visible
 * (outside the collapse) because it needs the user to act.
 */
function ToolPart({
  toolName,
  args,
  result,
  approval,
  streaming,
  onApprove,
}: {
  toolName: string;
  args: unknown;
  result: unknown;
  approval: Extract<TimelinePart, { kind: "tool" }>["approval"];
  streaming?: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  const [open, setOpen] = useState(false);
  const running = result === undefined && !!streaming;
  const hasDetails = args != null || result !== undefined;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            running ? "bg-primary motion-safe:animate-pulse" : "bg-muted-foreground"
          )}
        />
        <Label text={`[tool: ${toolName}]`} />
        {running ? (
          <span className="text-xs text-muted-foreground">running…</span>
        ) : hasDetails ? (
          <span aria-hidden className="text-xs text-muted-foreground">
            {open ? "▾" : "▸"}
          </span>
        ) : null}
      </button>
      {open && hasDetails ? (
        <div className="space-y-1.5">
          {args != null ? <Json value={args} /> : null}
          {result !== undefined ? <Json value={result} /> : null}
        </div>
      ) : null}
      {approval ? (
        <ApprovalCard
          toolName={toolName}
          approval={approval}
          onDecide={(d) => onApprove(approval.approvalId, d)}
        />
      ) : null}
    </div>
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

const SOURCE_LINK_CLASS =
  "text-primary underline underline-offset-2 hover:opacity-80 cursor-pointer";

function SourcesPart({ sources }: { sources: SourceRef[] }) {
  return (
    <div className="text-sm">
      <Label text="[sources]" />
      <ul className="mt-1 space-y-0.5">
        {sources.map((s, i) => {
          const label = `📖 ${s.title ?? s.url ?? "source"}`;
          // Internal wiki citations (`/knowledge/…`) navigate in-app; external links open a new tab;
          // an unlinked source (no resolvable wiki page) renders as muted text.
          return (
            <li key={s.id ?? s.url ?? `${s.title ?? "source"}-${i}`}>
              {s.url ? (
                s.url.startsWith("/") ? (
                  <Link to={s.url} className={SOURCE_LINK_CLASS}>
                    {label}
                  </Link>
                ) : (
                  <a href={s.url} target="_blank" rel="noreferrer" className={SOURCE_LINK_CLASS}>
                    {label}
                  </a>
                )
              ) : (
                <span className="text-muted-foreground">{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Render one timeline part. Tool parts also host the live approval card when one is attached. */
export function MessagePartView({
  part,
  streaming,
  citations,
  onApprove,
  onA2uiAgent,
}: {
  part: TimelinePart;
  streaming?: boolean;
  /** The message's cited-source links, so `[n]` markers in a text part become clickable. */
  citations?: { ref: number; url: string }[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onA2uiAgent?: (payload: unknown) => void;
}) {
  switch (part.kind) {
    case "text":
      return <Response text={part.text} streaming={streaming} citations={citations} />;
    case "reasoning":
      return <ReasoningPart text={part.text} />;
    case "tool":
      return (
        <ToolPart
          toolName={part.toolName}
          args={part.args}
          result={part.result}
          approval={part.approval}
          streaming={streaming}
          onApprove={onApprove}
        />
      );
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
    case "guardrail":
      return (
        <div className="rounded-sm border border-primary/60 bg-secondary px-3 py-2 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-primary">[guardrail]</span>{" "}
          <span className="text-foreground">{part.message ?? part.reason}</span>
        </div>
      );
    case "a2ui":
      return (
        <A2uiFrame
          html={part.html}
          fragments={part.fragments}
          onAgent={onA2uiAgent}
          className="w-full rounded-sm border border-border"
        />
      );
  }
}
