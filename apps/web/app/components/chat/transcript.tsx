import { useEffect, useRef, useState } from "react";
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

// Copy the response / re-run the turn. Dimmed by default, brightening on hover or keyboard focus.
function Actions({ text, onRegenerate }: { text: string; onRegenerate?: () => void }) {
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
    <div className="flex items-center gap-1 pt-1 text-xs text-muted-foreground opacity-60 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
      <button
        type="button"
        onClick={copy}
        className="rounded-sm px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? "copied" : "copy"}
      </button>
      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          className="rounded-sm px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
        >
          regenerate
        </button>
      ) : null}
    </div>
  );
}

function Message({
  message,
  status,
  isLast,
  onApprove,
  onRegenerate,
}: {
  message: ChatMessage;
  status: ChatStatus;
  isLast: boolean;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex gap-2 text-sm">
        <span aria-hidden className="select-none text-primary">
          {">"}
        </span>
        <div className="whitespace-pre-wrap text-foreground">{messageText(message)}</div>
      </div>
    );
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
        />
      ))}
      {message.sealed && text ? <Actions text={text} onRegenerate={canRegenerate} /> : null}
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
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  onApprove: (approvalId: string, decision: "approve" | "deny") => void;
  onRegenerate?: () => void;
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
          />
        ))}
        {status === "submitted" ? <Loader /> : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
