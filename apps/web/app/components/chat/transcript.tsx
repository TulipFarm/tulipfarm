import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUp, Copy, Info, RotateCcw, ThumbsDown, ThumbsUp } from "~/components/icons";
import { MarkdownView } from "~/components/markdown-view";
import { LoadingState } from "~/components/ui/loading-state";
import { nextEffortPreset } from "~/lib/chat/effort-escalation";
import type { ChatMessage, ChatStatus, ModelReceipt, TimelinePart } from "~/lib/chat/types";
import { copyText } from "~/lib/clipboard";
import { useLlmMode } from "~/lib/llm-mode-context";
import { markdownLinksToPlainText } from "~/lib/markdown-to-text";
import { FileAttachment, RemovedAttachment } from "./file-attachment";
import type { FileDraftResult } from "./file-draft-card";
import { MessagePartView } from "./parts";
import { PlanTrace } from "./plan-trace";
import { ResourceChanges } from "./resource-changes";
import { groupTimelineParts } from "./timeline-groups";
import { ToolTrace } from "./tool-trace";
import type { MentionEntry } from "./use-mention-catalog";

function partKey(part: TimelinePart, i: number): string {
  switch (part.kind) {
    case "tool":
      return `tool-${part.toolCallId}`;
    case "surface":
      return `surface-${part.artifactId}-${part.revision ?? "latest"}`;
    default:
      return `${part.kind}-${i}`;
  }
}

function messageText(message: ChatMessage): string {
  return message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

function effortLabel(preset: ModelReceipt["effortPreset"]): string | undefined {
  switch (preset) {
    case "auto":
      return "Auto";
    case "fast":
      return "Fast";
    case "balanced":
      return "Balanced";
    case "thorough":
      return "Thorough";
    default:
      return undefined;
  }
}

function requiredEffortLabel(preset: NonNullable<ModelReceipt["effortPreset"]>): string {
  return effortLabel(preset) ?? preset;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * When a turn shape makes more than one model call (e.g. a tool proposal denied, then a second
 * call answers), `modelCallLatencyMs` alone reports only the last call and understates the
 * turn's real model time. Render the total plus the call count whenever there is more than one,
 * so triage can see the breakdown rather than a bare, misleadingly small number.
 */
function modelTimeLabel(receipt: ModelReceipt): string {
  const total = receipt.totalModelCallLatencyMs ?? receipt.modelCallLatencyMs;
  const count = receipt.modelCallCount ?? 1;
  if (count <= 1) return `model call ${formatLatency(total)}`;
  return `${count} model calls · ${formatLatency(total)} total`;
}

function ModelReceiptView({ receipt }: { receipt: ModelReceipt }) {
  const asked = effortLabel(receipt.effortPreset);
  // `auto` is a request, not an outcome. Showing only "Auto" hides the choice the deployment made
  // on the participant's behalf; showing only the rung hides that they never picked it.
  const applied = receipt.effortPreset === "auto" ? effortLabel(receipt.effortApplied) : undefined;
  const effort = applied ? `${asked} → ${applied}` : asked;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5 text-muted-foreground">
      <span>Answered by</span>
      <code className="break-all font-mono text-[11px] text-muted-foreground">
        {receipt.modelId}
      </code>
      {effort ? <span>· {effort} effort</span> : null}
      <span>· {modelTimeLabel(receipt)}</span>
    </p>
  );
}

/**
 * Model receipt and the "Try harder" escalation, tucked behind a toggle rather than shown on
 * every completed reply. An always-visible model id, routing rung and latency reads like a
 * benchmark harness, not a business control panel — so the details stay a click away, and the
 * toggle itself only appears once there is something behind it to show.
 */
function AssistantMetaDetails({
  receipt,
  tryHarderTarget,
  onTryHarder,
  open,
}: {
  receipt?: ModelReceipt;
  tryHarderTarget?: NonNullable<ModelReceipt["effortPreset"]>;
  onTryHarder?: () => void;
  open: boolean;
}) {
  const llmMode = useLlmMode();
  // In Basic, every effort tier is the same model — "try harder" would re-run the identical
  // request, so the escalation offer is meaningless there.
  const canTryHarder = llmMode === "advanced";
  if (!open) return null;
  if (!receipt && !(canTryHarder && tryHarderTarget)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {receipt ? <ModelReceiptView receipt={receipt} /> : null}
      {canTryHarder && tryHarderTarget && onTryHarder ? (
        <button
          type="button"
          onClick={onTryHarder}
          aria-label={`Try harder with ${requiredEffortLabel(tryHarderTarget)} effort`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:translate-y-px sm:min-h-7"
        >
          <ChevronsUp aria-hidden className="size-3.5 text-primary" />
          <span>Try harder: {requiredEffortLabel(tryHarderTarget)}</span>
        </button>
      ) : null}
    </div>
  );
}

/** Whether there is anything an `AssistantMetaDetails` toggle would reveal. */
function useHasMetaDetails(
  receipt: ModelReceipt | undefined,
  tryHarderTarget: NonNullable<ModelReceipt["effortPreset"]> | undefined
): boolean {
  const llmMode = useLlmMode();
  const canTryHarder = llmMode === "advanced";
  return receipt !== undefined || (canTryHarder && tryHarderTarget !== undefined);
}

/**
 * The bare toggle, for a reply with no copy/vote toolbar of its own (a failed or cancelled turn
 * still made a model call worth disclosing, but there is no answer here to act on).
 */
function MetaOnlyFooter({
  receipt,
  tryHarderTarget,
}: {
  receipt?: ModelReceipt;
  tryHarderTarget?: NonNullable<ModelReceipt["effortPreset"]>;
}) {
  const [open, setOpen] = useState(false);
  const hasMetaDetails = useHasMetaDetails(receipt, tryHarderTarget);
  if (!hasMetaDetails) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`${toolbarBase} ${open ? "opacity-100" : "opacity-0"}`}>
        <IconAction
          label={open ? "Hide model details" : "Show model details"}
          onClick={() => setOpen((value) => !value)}
          active={open}
        >
          <Info className="size-3.5" />
        </IconAction>
      </div>
      <AssistantMetaDetails receipt={receipt} tryHarderTarget={tryHarderTarget} open={open} />
    </div>
  );
}

// Shared action-row chrome. `toolbarBase` keeps the layout; visibility (opacity) is applied by the
// caller so the assistant row can stay visible once a vote is active while un-voted rows hover-gate.
const toolbarBase =
  "flex items-center gap-1 pt-1 text-xs text-muted-foreground opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100";
const toolbar = toolbarBase;
// `active:scale-90` gives a press cue on click; `transition` (not just colors) animates the scale.
const iconBtn =
  "inline-flex size-10 items-center justify-center rounded-md transition hover:bg-accent hover:text-foreground active:scale-90 sm:size-7";

// A compact icon button for a message action, with a styled tooltip on hover/focus. `active` (toggle
// controls only) renders aria-pressed and a ruby tint; the label is the accessible name + tooltip.
function IconAction({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={`${iconBtn} ${active ? "text-primary hover:text-primary" : ""}`}
      >
        {children}
      </button>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-popover px-1.5 py-0.5 text-popover-foreground opacity-0 transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

// Copy-to-clipboard icon button, shared by the user and assistant toolbars. `text` is the raw
// message markdown; copy it as it reads (link syntax resolved to its label), not as source.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!(await copyText(markdownLinksToPlainText(text)))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <IconAction label={copied ? "copied" : "copy"} onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </IconAction>
  );
}

// Assistant toolbar: copy, regenerate (only offered on the latest finished reply), and a persisted
// up/down vote. A vote calls `onFeedback` (null clears it); a fresh down-vote opens an optional,
// skippable note ("what was off?"). Votes are decoupled from regenerate (its own button). Thumbs
// only show once the reply has a server id (`messageId`) to attach feedback to.
function AssistantActions({
  text,
  messageId,
  initialFeedback,
  onRegenerate,
  onFeedback,
  receipt,
  tryHarderTarget,
  onTryHarder,
}: {
  text: string;
  messageId?: string;
  initialFeedback?: "up" | "down";
  onRegenerate?: () => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  receipt?: ModelReceipt;
  tryHarderTarget?: NonNullable<ModelReceipt["effortPreset"]>;
  onTryHarder?: () => void;
}) {
  const [reaction, setReaction] = useState<"up" | "down" | null>(initialFeedback ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [metaOpen, setMetaOpen] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  // Enter both submits and (on the resulting unmount) can fire onBlur — guard so the note posts once.
  const noteSubmitted = useRef(false);
  const canVote = messageId !== undefined && onFeedback !== undefined;
  const hasMetaDetails = useHasMetaDetails(receipt, tryHarderTarget);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  function vote(next: "up" | "down") {
    if (!canVote) return;
    const value = reaction === next ? null : next; // re-click clears the vote
    setReaction(value);
    setNoteOpen(value === "down");
    if (value === "down") noteSubmitted.current = false;
    else setNote("");
    onFeedback(messageId, value);
  }
  function submitNote() {
    if (noteSubmitted.current) return;
    noteSubmitted.current = true;
    const trimmed = note.trim();
    setNoteOpen(false);
    if (canVote && reaction === "down" && trimmed) onFeedback(messageId, "down", trimmed);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* A recorded vote or an opened details panel keeps the row visible; otherwise it stays
       * hover-gated like the rest. */}
      <div className={`${toolbarBase} ${reaction || metaOpen ? "opacity-100" : "opacity-0"}`}>
        {text ? <CopyButton text={text} /> : null}
        {onRegenerate ? (
          <IconAction label="regenerate" onClick={onRegenerate}>
            <RotateCcw className="size-3.5" />
          </IconAction>
        ) : null}
        {canVote ? (
          <>
            <span aria-hidden className="px-0.5 text-border">
              ·
            </span>
            <IconAction label="Good response" onClick={() => vote("up")} active={reaction === "up"}>
              <ThumbsUp className={`size-3.5 ${reaction === "up" ? "fill-current" : ""}`} />
            </IconAction>
            <IconAction
              label="Bad response"
              onClick={() => vote("down")}
              active={reaction === "down"}
            >
              <ThumbsDown className={`size-3.5 ${reaction === "down" ? "fill-current" : ""}`} />
            </IconAction>
          </>
        ) : null}
        {hasMetaDetails ? (
          <>
            <span aria-hidden className="px-0.5 text-border">
              ·
            </span>
            <IconAction
              label={metaOpen ? "Hide model details" : "Show model details"}
              onClick={() => setMetaOpen((value) => !value)}
              active={metaOpen}
            >
              <Info className="size-3.5" />
            </IconAction>
          </>
        ) : null}
      </div>
      <AssistantMetaDetails
        receipt={receipt}
        tryHarderTarget={tryHarderTarget}
        onTryHarder={onTryHarder}
        open={metaOpen}
      />
      {noteOpen ? (
        <input
          ref={noteRef}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitNote();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setNoteOpen(false);
            }
          }}
          onBlur={submitNote}
          placeholder="what was off? (optional)"
          aria-label="Feedback note"
          className="w-full max-w-sm rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
        />
      ) : null}
    </div>
  );
}

// User turn: a right-aligned bubble with a copy toolbar.
function UserMessage({ message, mentions }: { message: ChatMessage; mentions?: MentionEntry[] }) {
  const text = messageText(message);
  const files = message.parts.filter(
    (part) => part.kind === "file" || part.kind === "file-unavailable"
  );

  return (
    <article aria-label="Your message" className="group flex flex-col items-end gap-1">
      {files.length > 0 ? (
        <div className="flex max-w-[90%] flex-wrap justify-end gap-2 sm:max-w-[78%]">
          {files.map((file) =>
            file.kind === "file-unavailable" ? (
              <RemovedAttachment key={file.fileId} name={file.name} />
            ) : (
              <FileAttachment
                fileId={file.fileId}
                key={file.fileId}
                mediaType={file.mediaType}
                name={file.name}
              />
            )
          )}
        </div>
      ) : null}
      {text.length > 0 ? (
        <div className="max-w-[90%] rounded-lg bg-secondary px-3 py-2 text-base text-foreground sm:max-w-[78%] [&_:first-child]:mt-0 [&_:last-child]:mb-0">
          <MarkdownView mentions={mentions}>{text}</MarkdownView>
        </div>
      ) : null}
      <div className={`${toolbar} justify-end`}>
        <CopyButton text={text} />
      </div>
    </article>
  );
}

function MessageRow({
  message,
  status,
  isLast,
  planInSidebar,
  mentions,
  onApprove,
  onRegenerate,
  onTryHarder,
  onFeedback,
  onSurfaceInteraction,
  onReviseDraft,
}: {
  message: ChatMessage;
  status: ChatStatus;
  isLast: boolean;
  /** Whether `PlanSidebar` is already showing this Turn's plan, so the inline copy defers to it
      on desktop and only remains the fallback below the `md` breakpoint. */
  planInSidebar?: boolean;
  mentions?: MentionEntry[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void | Promise<void>;
  onRegenerate?: () => void;
  onTryHarder?: (messageId: string, model: NonNullable<ModelReceipt["effortPreset"]>) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onSurfaceInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
  onReviseDraft?: (draft: FileDraftResult) => void;
}) {
  // Cited-source links for this message, gathered from its `sources` part(s), so inline `[n]` markers
  // in the text become clickable. Memoized on `parts` so the markdown isn't re-parsed each render.
  // Computed before the user-message early return so the hook order stays stable (Rules of Hooks).
  const citations = useMemo(
    () =>
      message.parts
        .filter((p) => p.kind === "sources")
        .flatMap((p) => (p as Extract<TimelinePart, { kind: "sources" }>).sources)
        .flatMap((s) => (s.ref != null && s.url ? [{ ref: s.ref, url: s.url }] : [])),
    [message.parts]
  );
  if (message.role === "user") {
    return <UserMessage message={message} mentions={mentions} />;
  }

  const streaming = !message.sealed && status === "streaming";
  const lastIndex = message.parts.length - 1;
  const nodes = groupTimelineParts(message.parts, { streaming });
  const text = messageText(message);
  const successful =
    message.sealed &&
    !(isLast && status === "error") &&
    message.turnAttempt?.outcome !== "failed" &&
    message.turnAttempt?.outcome !== "cancelled" &&
    !message.parts.some((part) => part.kind === "turn-status");
  const hasAnswer = text.length > 0 || message.parts.some((part) => part.kind === "surface");
  // Regenerate re-runs the last turn — only offer it on the latest, finished assistant reply.
  const canRegenerate = successful && isLast && status === "idle" ? onRegenerate : undefined;
  const nextPreset =
    successful && status === "idle" && message.sourceTurn && message.receipt
      ? nextEffortPreset(
          message.sourceTurn.options?.model ?? message.receipt.effortPreset,
          message.receipt.effortApplied
        )
      : undefined;
  return (
    <article aria-label="Assistant response" className="group flex flex-col gap-2">
      {nodes.map((node, nodeIndex) => {
        if (node.kind === "surface-building") {
          // A presentation Tool draws no row, so this is the only sign the reply is still building
          // the thing the reader is about to look at.
          return <LoadingState key="surface-building" label="Rendering" />;
        }
        if (node.kind === "plan") {
          // Only the last, still-open message can be the plan `PlanSidebar` is currently showing
          // (see `findActivePlan`) — anything sealed or earlier in the transcript is a finished
          // plan with no sidebar copy to defer to, so it always renders inline.
          const ownedBySidebar = planInSidebar === true && isLast && !message.sealed;
          return (
            <div key={`plan-${node.index}`} className={ownedBySidebar ? "md:hidden" : undefined}>
              <PlanTrace
                rounds={node.rounds}
                pending={streaming && nodeIndex === nodes.length - 1}
              />
            </div>
          );
        }
        if (node.kind === "tool-run") {
          return (
            <ToolTrace
              key={`tools-${node.index}`}
              parts={node.parts}
              foldable={node.foldable}
              pending={streaming && nodeIndex === nodes.length - 1}
              onApprove={onApprove}
              onReviseDraft={onReviseDraft}
            />
          );
        }
        return (
          <MessagePartView
            key={partKey(node.part, node.index)}
            part={node.part}
            streaming={streaming && node.index === lastIndex}
            citations={citations}
            onApprove={onApprove}
            onSurfaceInteraction={onSurfaceInteraction}
            onReviseDraft={onReviseDraft}
          />
        );
      })}
      {message.sealed ? <ResourceChanges parts={message.parts} /> : null}
      {successful && hasAnswer ? (
        <AssistantActions
          text={text}
          messageId={message.serverId}
          initialFeedback={message.feedback}
          onRegenerate={canRegenerate}
          onFeedback={onFeedback}
          receipt={message.receipt}
          tryHarderTarget={nextPreset}
          onTryHarder={
            nextPreset && onTryHarder ? () => onTryHarder(message.id, nextPreset) : undefined
          }
        />
      ) : message.sealed ? (
        // A reply with nothing to copy or vote on (a failed or cancelled turn) still tucks its
        // model receipt behind the same toggle, rather than reviving the always-visible row here.
        <MetaOnlyFooter receipt={message.receipt} tryHarderTarget={nextPreset} />
      ) : null}
    </article>
  );
}

/**
 * Every streamed token produces a new `messages` array. Without this boundary React re-renders —
 * and `MarkdownView` re-parses — every historical message on every token.
 */
const Message = memo(MessageRow);

function Loader() {
  return <LoadingState className="text-muted-foreground" />;
}

/** Scrolling transcript; auto-sticks to the bottom unless the reader has scrolled up. */
export function Transcript({
  messages,
  status,
  planInSidebar,
  mentions,
  onApprove,
  onRegenerate,
  onTryHarder,
  onFeedback,
  onSurfaceInteraction,
  onReviseDraft,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  /** Whether `PlanSidebar` is currently mounted for this Chat, so the last message's inline plan
      can defer to it on desktop (see `MessageRow`). */
  planInSidebar?: boolean;
  mentions?: MentionEntry[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void | Promise<void>;
  onRegenerate?: () => void;
  onTryHarder?: (messageId: string, model: NonNullable<ModelReceipt["effortPreset"]>) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onSurfaceInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
  onReviseDraft?: (draft: FileDraftResult) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const programmaticScrollTop = useRef<number | null>(null);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const programmatic =
      programmaticScrollTop.current !== null &&
      Math.abs(el.scrollTop - programmaticScrollTop.current) < 1;
    programmaticScrollTop.current = null;
    // Reaching the bottom re-arms sticking regardless of what caused it — including our own
    // programmatic jump — so a stale "unstuck" state from an earlier incidental scroll cannot
    // outlive the moment the reader is actually back at the tail.
    if (atBottom) {
      stick.current = true;
    } else if (!programmatic) {
      stick.current = false;
    }
  }

  const followBottom = useCallback(() => {
    if (!stick.current) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && el.contains(selection.anchorNode)) return;
      programmaticScrollTop.current = el.scrollHeight;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript changes are the trigger
  useEffect(() => followBottom(), [followBottom, messages, status]);
  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => followBottom());
    observer.observe(content);
    return () => observer.disconnect();
  }, [followBottom]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
      <div
        ref={contentRef}
        className="mx-auto flex w-full max-w-4xl flex-col gap-7 px-4 py-7 sm:px-6 sm:py-9"
      >
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          return (
            <div key={m.id}>
              <Message
                message={m}
                status={status}
                isLast={isLast}
                planInSidebar={planInSidebar}
                mentions={mentions}
                onApprove={onApprove}
                onRegenerate={onRegenerate}
                onTryHarder={onTryHarder}
                onFeedback={onFeedback}
                onSurfaceInteraction={onSurfaceInteraction}
                onReviseDraft={onReviseDraft}
              />
            </div>
          );
        })}
        {status === "submitted" ? <Loader /> : null}
      </div>
    </div>
  );
}
