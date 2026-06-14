import { Check, Copy, Pencil, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MarkdownView } from "~/components/markdown-view";
import type { ChatMessage, ChatStatus, TimelinePart } from "~/lib/chat/types";
import { MessagePartView } from "./parts";

function partKey(part: TimelinePart, i: number): string {
  switch (part.kind) {
    case "tool":
      return `tool-${part.toolCallId}`;
    case "plan":
      return `plan-${part.planId}`;
    case "task":
      return `task-${part.taskId}`;
    default:
      return `${part.kind}-${i}`;
  }
}

function messageText(message: ChatMessage): string {
  return message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

// Shared action-row chrome. `toolbarBase` keeps the layout; visibility (opacity) is applied by the
// caller so the assistant row can stay visible once a vote is active while un-voted rows hover-gate.
const toolbarBase =
  "flex items-center gap-1 pt-1 text-xs text-muted-foreground transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100";
const toolbar = `${toolbarBase} opacity-0`;
const actionBtn =
  "rounded-sm px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground";
// `active:scale-90` gives a press cue on click; `transition` (not just colors) animates the scale.
const iconBtn = "rounded-sm p-1 transition hover:bg-accent hover:text-foreground active:scale-90";

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
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (e.g. a non-secure context) — no-op
    }
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

// User turn: a right-aligned bubble with a copy/edit toolbar. Editing swaps the bubble for an inline
// textarea; saving re-runs the conversation from this turn (a local branch — see useChatStream).
function UserMessage({
  message,
  onEditResend,
}: {
  message: ChatMessage;
  onEditResend?: (messageId: string, text: string) => void;
}) {
  const text = messageText(message);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (editing && ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing]);

  function save() {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed) onEditResend?.(message.id, trimmed);
  }
  function cancel() {
    setDraft(text);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          rows={Math.min(8, draft.split("\n").length + 1)}
          aria-label="Edit message"
          className="w-full resize-none rounded-lg bg-muted px-3.5 py-2 text-sm text-foreground ring-1 ring-border"
        />
        <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
          <button type="button" onClick={cancel} className={actionBtn}>
            cancel
          </button>
          <button type="button" onClick={save} className={`${actionBtn} text-primary`}>
            save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="max-w-[80%] rounded-lg bg-muted px-3.5 py-2 text-sm text-foreground [&_:first-child]:mt-0 [&_:last-child]:mb-0">
        <MarkdownView>{text}</MarkdownView>
      </div>
      <div className={`${toolbar} justify-end`}>
        <CopyButton text={text} />
        {onEditResend ? (
          <IconAction label="edit" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconAction>
        ) : null}
      </div>
    </div>
  );
}

function Message({
  message,
  status,
  isLast,
  onApprove,
  onRegenerate,
  onEditResend,
  onFeedback,
  onA2uiAgent,
}: {
  message: ChatMessage;
  status: ChatStatus;
  isLast: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
  onEditResend?: (messageId: string, text: string) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onA2uiAgent?: (payload: unknown) => void;
}) {
  if (message.role === "user") {
    return <UserMessage message={message} onEditResend={onEditResend} />;
  }

  const streaming = !message.sealed && status === "streaming";
  const lastIndex = message.parts.length - 1;
  const text = messageText(message);
  // Regenerate re-runs the last turn — only offer it on the latest, finished assistant reply.
  const canRegenerate = isLast && status === "idle" ? onRegenerate : undefined;
  return (
    <div className="group flex flex-col gap-2">
      {message.parts.map((part, i) => (
        <MessagePartView
          key={partKey(part, i)}
          part={part}
          streaming={streaming && i === lastIndex && part.kind === "text"}
          onApprove={onApprove}
          onA2uiAgent={onA2uiAgent}
        />
      ))}
      {message.sealed && text ? (
        <AssistantActions
          text={text}
          messageId={message.serverId}
          initialFeedback={message.feedback}
          onRegenerate={canRegenerate}
          onFeedback={onFeedback}
        />
      ) : null}
    </div>
  );
}

function Loader() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <span aria-hidden className="animate-cursor text-primary">
        ▍
      </span>
      <span className="sr-only">Assistant is responding</span>
    </div>
  );
}

/** Scrolling transcript; auto-sticks to the bottom unless the reader has scrolled up. */
export function Transcript({
  messages,
  status,
  onApprove,
  onRegenerate,
  onEditResend,
  onFeedback,
  onA2uiAgent,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
  onEditResend?: (messageId: string, text: string) => void;
  onFeedback?: (messageId: string, rating: "up" | "down" | null, note?: string) => void;
  onA2uiAgent?: (payload: unknown) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on any transcript change
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
        {messages.map((m, i) => (
          <Message
            key={m.id}
            message={m}
            status={status}
            isLast={i === messages.length - 1}
            onApprove={onApprove}
            onRegenerate={onRegenerate}
            onEditResend={onEditResend}
            onFeedback={onFeedback}
            onA2uiAgent={onA2uiAgent}
          />
        ))}
        {status === "submitted" ? <Loader /> : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
