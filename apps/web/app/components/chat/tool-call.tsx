import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Database,
  GitBranch,
  LayoutGrid,
  Loader2,
  MessageSquare,
  PenLine,
  Sparkles,
  Wrench,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import type { TimelinePart, ToolPreview } from "~/lib/chat/types";
import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import { ApprovalCard } from "./approval-card";
import { JsonView, PreviewNotice } from "./json-view";
import {
  describeToolCall,
  describeToolResult,
  formatDuration,
  type ToolFamily,
  toolFamily,
  toolTierLabel,
} from "./tool-summary";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

const FAMILY_ICON: Record<ToolFamily, ComponentType<{ className?: string }>> = {
  knowledge: BookOpen,
  memory: Brain,
  storage: Database,
  github: GitBranch,
  slack: MessageSquare,
  surface: LayoutGrid,
  time: Clock,
  delegation: Sparkles,
  generic: Wrench,
};

/** Tier drives the glyph tint, so a system call and an outbound integration call never look alike. */
const TIER_CLASS: Record<string, string> = {
  system: "text-tool-tier-system",
  platform: "text-tool-tier-platform",
  integration: "text-tool-tier-integration",
};

type RunState = "running" | "awaiting" | "ok" | "error" | "blocked";

function runStateOf(part: ToolPart, streaming: boolean | undefined): RunState {
  if (part.approval?.status === "pending") return "awaiting";
  if (part.approval?.status === "denied" || part.approval?.status === "timeout") return "blocked";
  if (part.outcome === "error") return "error";
  if (part.status === "done") return "ok";
  // Still `running` on the timeline. Once the stream ends it can no longer finish, so a call left
  // open is reported as stopped rather than as forever in flight.
  return streaming === true ? "running" : "blocked";
}

function StatusNode({ state }: { state: RunState }) {
  const base = "relative z-10 flex size-4 shrink-0 items-center justify-center rounded-full";

  if (state === "running") {
    return (
      <span className={cn(base, "bg-background")}>
        <Loader2
          aria-hidden
          className="size-3.5 text-run-active motion-safe:animate-spin motion-reduce:opacity-70"
        />
      </span>
    );
  }
  if (state === "ok") {
    return (
      <span className={cn(base, "bg-background text-run-ok")}>
        <Check aria-hidden className="size-3.5" strokeWidth={2.75} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={cn(base, "bg-background text-run-error")}>
        <AlertTriangle aria-hidden className="size-3.5" />
      </span>
    );
  }
  if (state === "awaiting") {
    return (
      <span className={cn(base, "bg-background text-run-blocked")}>
        <Clock aria-hidden className="size-3.5" />
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-background")}>
      <span aria-hidden className="size-1.5 rounded-full bg-run-skipped" />
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_400);
        }
      }}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-run-surface-hover hover:text-foreground"
    >
      {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function InspectPane({
  label,
  preview,
  fallback,
}: {
  label: string;
  preview?: ToolPreview;
  fallback?: unknown;
}) {
  const json =
    preview?.json ?? (fallback === undefined ? undefined : JSON.stringify(fallback, null, 2));
  if (json === undefined) return null;

  return (
    <section className="overflow-hidden rounded-md border border-code-border bg-code-surface">
      <header className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
        <h4 className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </h4>
        <CopyButton value={json} label={`Copy ${label.toLowerCase()}`} />
      </header>
      <div className="px-3 py-2">
        <JsonView json={json} />
      </div>
      {preview === undefined ? null : <PreviewNotice preview={preview} />}
    </section>
  );
}

export function ToolCallRow({
  part,
  streaming,
  onApprove,
}: {
  part: ToolPart;
  streaming?: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  const [open, setOpen] = useState(false);

  const family = toolFamily(part.toolName);
  const Icon = FAMILY_ICON[family];
  const tier = toolTierLabel(part.meta?.tier, family);
  const state = runStateOf(part, streaming);
  const args = parsedArgs(part);
  const result = parsedResult(part);
  const summary = describeToolCall(part.toolName, args, part.meta?.summary);
  const outcomeHint = state === "ok" ? describeToolResult(part) : undefined;
  const duration = formatDuration(part.meta?.durationMs);
  // Mirror what the panes actually render. Deriving this from the parsed values meant an
  // unparseable preview made the row silently non-expandable, hiding the truncation notice too.
  const hasDetails =
    part.argsPreview !== undefined ||
    part.resultPreview !== undefined ||
    args !== undefined ||
    result !== undefined;

  return (
    <div className={cn("group/row", state === "error" && "bg-run-error/5")}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen((previous) => !previous)}
        aria-expanded={hasDetails ? open : undefined}
        disabled={!hasDetails}
        className={cn(
          // The run clips its children, and the global focus halo is outset — so on a full-bleed
          // row it gets eaten and leaves one stray line that reads as a divider. Draw it inside.
          "flex w-full items-center gap-2 py-1.5 pl-2.5 pr-2 text-left transition-colors",
          "focus-visible:-outline-offset-2 focus-visible:rounded-md",
          hasDetails ? "hover:bg-run-surface-hover" : "cursor-default"
        )}
      >
        <StatusNode state={state} />

        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 opacity-70",
            TIER_CLASS[tier] ?? "text-tool-tier-platform"
          )}
        />

        <span className="truncate text-sm text-foreground">{summary}</span>

        {part.meta?.mutating === true ? (
          <PenLine
            aria-label="This tool can write"
            className="size-3 shrink-0 text-tool-mutating"
          />
        ) : null}

        {/* Shrinks well before the summary does. Weighted equally, a tight row truncated both and
            left "Listed age… agent_li…" — two half-words instead of one readable one. */}
        <span className="hidden shrink-[8] truncate font-mono text-[11px] text-muted-foreground/70 sm:inline">
          {part.toolName}
        </span>

        {state === "error" && part.meta?.errorCode !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] text-run-error">
            {part.meta.errorCode}
          </span>
        ) : null}

        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {outcomeHint === undefined ? null : (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {outcomeHint}
            </span>
          )}
          {duration === undefined ? null : (
            <span className="font-mono text-[11px] text-muted-foreground/80">{duration}</span>
          )}
          {hasDetails ? (
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground/50 transition-transform duration-150 ease-snappy",
                "group-hover/row:text-muted-foreground",
                open && "rotate-90"
              )}
            />
          ) : (
            <span aria-hidden className="size-3.5" />
          )}
        </span>
      </button>

      {/* Motion here reports live execution, which is the only thing that earns a loop. */}
      {state === "running" ? (
        <div
          aria-hidden
          className="relative h-px w-full overflow-hidden bg-run-rail run-rail-active"
        />
      ) : null}

      {open && hasDetails ? (
        <div className="space-y-2 border-t border-run-border/70 bg-background/40 px-2.5 py-2.5">
          <InspectPane label="Input" preview={part.argsPreview} fallback={args} />
          <InspectPane label="Output" preview={part.resultPreview} fallback={result} />
          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
            <Meta label="Tier" value={tier} />
            {part.meta?.agentId === undefined ? null : (
              <Meta label="Agent" value={part.meta.agentId} />
            )}
            <Meta label="Call" value={part.toolCallId} mono />
            {digestOf(part) === undefined ? null : (
              <Meta label="Digest" value={digestOf(part) ?? ""} mono />
            )}
          </dl>
        </div>
      ) : null}

      {part.approval ? (
        <div className="px-2.5 pb-2.5 pt-1">
          <ApprovalCard
            toolName={part.toolName}
            approval={part.approval}
            onDecide={(decision) => onApprove(part.approval?.approvalId ?? "", decision)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Long, non-interactive Tool runs collapse to one line until opened. */
export function ToolRun({
  parts,
  streaming,
  foldable,
  onApprove,
}: {
  parts: readonly ToolPart[];
  streaming?: boolean;
  foldable?: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
}) {
  const [open, setOpen] = useState(false);
  const folded = foldable === true && !open;

  const durations = parts.flatMap((part) =>
    part.meta?.durationMs === undefined ? [] : [part.meta.durationMs]
  );
  // Only claim a total when every call reported one; a partial sum would understate the work.
  const total =
    durations.length === parts.length
      ? formatDuration(durations.reduce((sum, value) => sum + value, 0))
      : undefined;

  // Distinct families, in the order they first ran, so the glyph strip previews what happened.
  const families: ToolFamily[] = [];
  for (const part of parts) {
    const family = toolFamily(part.toolName);
    if (!families.includes(family)) families.push(family);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-run-border bg-run-surface">
      {folded ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="group/row flex w-full items-center gap-2 py-1.5 pl-2.5 pr-2 text-left transition-colors hover:bg-run-surface-hover focus-visible:-outline-offset-2 focus-visible:rounded-md"
        >
          <span className="relative z-10 flex size-4 shrink-0 items-center justify-center rounded-full bg-background text-run-ok">
            <Check aria-hidden className="size-3.5" strokeWidth={2.75} />
          </span>

          <span className="flex shrink-0 items-center gap-1">
            {families.slice(0, 3).map((family) => {
              const FamilyIcon = FAMILY_ICON[family];
              return (
                <FamilyIcon
                  key={family}
                  aria-hidden
                  className="size-3.5 text-tool-tier-platform opacity-70"
                />
              );
            })}
          </span>

          {/* Fixed, short, and the point of the row — it must never be the thing that truncates.
              Left shrinkable, the mono name list below stole its width and left "Ran 5 …". */}
          <span className="shrink-0 text-sm text-foreground">Ran {parts.length} tools</span>

          {/* The names are the point of the row: a run the reader cannot identify is just a
              number, and they would have to expand it to learn anything. */}
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground/70 sm:inline">
            {parts.map((part) => part.toolName).join(" · ")}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            {total === undefined ? null : (
              <span className="font-mono text-[11px] text-muted-foreground/80">{total}</span>
            )}
            <ChevronRight
              aria-hidden
              className="size-3.5 text-muted-foreground/50 transition-transform duration-150 ease-snappy group-hover/row:text-muted-foreground"
            />
          </span>
        </button>
      ) : (
        <div className="divide-y divide-run-border/60">
          {parts.map((part) => (
            <ToolCallRow
              key={part.toolCallId}
              part={part}
              streaming={streaming}
              onApprove={onApprove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <dt className="uppercase tracking-wide opacity-70">{label}</dt>
      <dd className={cn("text-foreground/80", mono === true && "font-mono")}>{value}</dd>
    </span>
  );
}

/** Live `args` may be only `{ argsDigest }`; show it as metadata, not arguments. */
function parsedArgs(part: ToolPart): unknown {
  if (part.argsPreview !== undefined) {
    try {
      return JSON.parse(part.argsPreview.json);
    } catch {
      return undefined;
    }
  }
  if (isDigestOnly(part.args)) return undefined;
  return part.args;
}

function isDigestOnly(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const keys = Object.keys(args);
  return keys.length === 0 || (keys.length === 1 && keys[0] === "argsDigest");
}

/** Keep the digest so a redacted call remains verifiable. */
function digestOf(part: ToolPart): string | undefined {
  if (part.meta?.argsDigest !== undefined) return part.meta.argsDigest;
  if (typeof part.args !== "object" || part.args === null) return undefined;
  const digest = (part.args as { argsDigest?: unknown }).argsDigest;
  return typeof digest === "string" ? digest : undefined;
}

/** The result to show. Same rule as the arguments: preview first, verbatim second. */
function parsedResult(part: ToolPart): unknown {
  if (part.resultPreview !== undefined) {
    try {
      return JSON.parse(part.resultPreview.json);
    } catch {
      return undefined;
    }
  }
  return part.result;
}
