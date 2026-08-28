import { Check, ChevronsUp, Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import { LoadingState } from "~/components/ui/loading-state";
import { nextEffortPreset } from "~/lib/chat/effort-escalation";
import type { ChatMessage, ChatStatus, ModelReceipt, TimelinePart } from "~/lib/chat/types";
import { copyText } from "~/lib/clipboard";
import { FileAttachment, RemovedAttachment } from "./file-attachment";
import { MessagePartView } from "./parts";
import { PlanTrace } from "./plan-trace";
import { groupTimelineParts } from "./timeline-groups";
import { ToolTrace } from "./tool-trace";
import type { MentionEntry } from "./use-mention-catalog";

function partKey(part: TimelinePart, i: number): string {
  switch (part.kind) {
    case "tool":
      return `tool-${part.toolCallId}`;
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
      <span>· model call {formatLatency(receipt.modelCallLatencyMs)}</span>
    </p>
  );
}

function AssistantMetaRow({
  receipt,
  tryHarderTarget,
  onTryHarder,
}: {
  receipt?: ModelReceipt;
  tryHarderTarget?: NonNullable<ModelReceipt["effortPreset"]>;
  onTryHarder?: () => void;
}) {
  if (!receipt && !tryHarderTarget) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {receipt ? <ModelReceiptView receipt={receipt} /> : null}
      {tryHarderTarget && onTryHarder ? (
        <button
          type="button"
          onClick={onTryHarder}
          aria-label={`Try harder with ${requiredEffortLabel(tryHarderTarget)} effort`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:translate-y-px sm:min-h-7"
        >
          <ChevronsUp aria-hidden className="size-3.5 text-primary" />
          <span>Try harder: {requiredEffortLabel(tryHarderTarget)}</span>
        </button>
      ) : null}
    </div>
  );
}

// Shared action-row chrome. `toolbarBase` keeps the layout; visibility (opacity) is applied by the
// caller so the assistant row can stay visible once a vote is active while un-voted rows hover-gate.
const toolbarBase =
  "flex items-center gap-1 pt-1 text-xs text-muted-foreground opacity-100 transition-opacity duration-150 focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100";
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

// Copy-to-clipboard icon button, shared by the user and assistant toolbars.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!(await copyText(text))) return;
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
}: {
  text: string;
  messageId?: string;
  initialFeedback?: "up" | "down";
  onRegenerate?: () => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
}) {
  const [reaction, setReaction] = useState<"up" | "down" | null>(initialFeedback ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  // Enter both submits and (on the resulting unmount) can fire onBlur — guard so the note posts once.
  const noteSubmitted = useRef(false);
  const canVote = messageId !== undefined && onFeedback !== undefined;

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
      {/* A recorded vote keeps the row visible; otherwise it stays hover-gated like the rest. */}
      <div className={`${toolbarBase} ${reaction ? "opacity-100" : "opacity-0"}`}>
        <CopyButton text={text} />
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
      </div>
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
        <div className="max-w-[90%] rounded-lg bg-secondary px-3.5 py-2.5 text-sm leading-6 text-foreground sm:max-w-[78%] [&_:first-child]:mt-0 [&_:last-child]:mb-0">
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
  mentions,
  onApprove,
  onRegenerate,
  onTryHarder,
  onFeedback,
  onSurfaceInteraction,
}: {
  message: ChatMessage;
  status: ChatStatus;
  isLast: boolean;
  mentions?: MentionEntry[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
  onTryHarder?: (messageId: string, model: NonNullable<ModelReceipt["effortPreset"]>) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onSurfaceInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
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
  // Regenerate re-runs the last turn — only offer it on the latest, finished assistant reply.
  const canRegenerate = isLast && status === "idle" ? onRegenerate : undefined;
  const nextPreset =
    message.sealed && status === "idle" && message.sourceTurn && message.receipt
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
          return <PlanTrace key={`plan-${node.index}`} rounds={node.rounds} />;
        }
        if (node.kind === "tool-run") {
          return (
            <ToolTrace
              key={`tools-${node.index}`}
              parts={node.parts}
              foldable={node.foldable}
              pending={streaming && nodeIndex === nodes.length - 1}
              onApprove={onApprove}
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
          />
        );
      })}
      {message.sealed ? (
        <AssistantMetaRow
          receipt={message.receipt}
          tryHarderTarget={nextPreset}
          onTryHarder={
            nextPreset && onTryHarder ? () => onTryHarder(message.id, nextPreset) : undefined
          }
        />
      ) : null}
      {message.sealed && text ? (
        <AssistantActions
          text={text}
          messageId={message.serverId}
          initialFeedback={message.feedback}
          onRegenerate={canRegenerate}
          onFeedback={onFeedback}
        />
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
  mentions,
  onApprove,
  onRegenerate,
  onTryHarder,
  onFeedback,
  onSurfaceInteraction,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  mentions?: MentionEntry[];
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
  onTryHarder?: (messageId: string, model: NonNullable<ModelReceipt["effortPreset"]>) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onSurfaceInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  // Auto-scroll is layout-forcing, so coalesce bursts of stream updates into one write per frame.
  // Writing scrollTop instead of scrolling a sentinel into view keeps the movement inside this
  // container: scrollIntoView also scrolls every scrollable ancestor, which dragged the shell's
  // <main> and the document down whenever a response started loading (#69).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on any transcript change
  useEffect(() => {
    if (!stick.current) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, status]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-7 px-4 py-7 sm:px-6 sm:py-9">
        {messages.map((m, i) => (
          <Message
            key={m.id}
            message={m}
            status={status}
            isLast={i === messages.length - 1}
            mentions={mentions}
            onApprove={onApprove}
            onRegenerate={onRegenerate}
            onTryHarder={onTryHarder}
            onFeedback={onFeedback}
            onSurfaceInteraction={onSurfaceInteraction}
          />
        ))}
        {status === "submitted" ? <Loader /> : null}
      </div>
    </div>
  );
}
