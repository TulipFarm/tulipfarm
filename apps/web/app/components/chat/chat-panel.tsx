import type { ModelTier } from "~/lib/chat/types";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { Composer } from "./composer";
import { Transcript } from "./transcript";

const SUGGESTIONS = ["what can you do?", "show my open approvals", "summarize recent leads"];

function EmptyState({ agent, onPick }: { agent: string; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-16">
      <div className="flex w-full max-w-3xl flex-col gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          <span aria-hidden className="animate-cursor text-primary">
            ▍
          </span>
          tulipfarm
        </h1>
        <p className="text-muted-foreground">The business agent harness. Ask anything below.</p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span>ready</span>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span>{agent}</span>
        </p>
      </div>
      <div className="flex w-full max-w-3xl flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-sm border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Layer-1 chat surface: empty state → live transcript, with the composer pinned to the bottom. */
export function ChatPanel({
  agentId,
  defaultModel = "standard",
}: {
  agentId?: string;
  defaultModel?: ModelTier;
}) {
  const { messages, status, error, send, approve, regenerate, reset } = useChatStream();
  const busy = status === "submitted" || status === "streaming";
  const agent = agentId || "GeneralAssistant";
  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-[calc(100svh-3rem)] flex-col md:h-svh">
      {hasMessages ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2.5">
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          <span className="text-xs text-muted-foreground">{agent}</span>
          <button
            type="button"
            onClick={reset}
            className="ml-auto inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <span aria-hidden>+</span> new chat
          </button>
        </header>
      ) : null}
      {hasMessages ? (
        <Transcript
          messages={messages}
          status={status}
          onApprove={approve}
          onRegenerate={regenerate}
        />
      ) : (
        <EmptyState agent={agent} onPick={(text) => send(text, { model: defaultModel, agentId })} />
      )}
      <Composer
        busy={busy}
        defaultModel={defaultModel}
        onSend={(text, opts) => send(text, { ...opts, agentId })}
      />
      {status === "error" ? (
        <p className="mx-auto w-full max-w-3xl px-6 pb-2 text-xs text-destructive">
          [error] {error ?? "the stream failed"} — try again
        </p>
      ) : null}
    </div>
  );
}
