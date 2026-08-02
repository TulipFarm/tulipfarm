import { Link } from "@remix-run/react";
import { AgentGlyph } from "~/components/agent-glyph";
import { ConnectionStatus } from "~/components/shell/states";
import type { Autonomy } from "~/lib/agents";
import type { ChatMessage, ModelTier } from "~/lib/chat/types";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import { useConversations } from "~/lib/conversations-context";
import { errorAction } from "~/lib/error-actions";
import type { OnboardingChecklist, Suggestion } from "~/lib/onboarding";
import { ChatDebugDrawer } from "./chat-debug-drawer";
import { Composer } from "./composer";
import { GettingStartedCard } from "./getting-started-card";
import { asTier } from "./model-selector";
import { Transcript } from "./transcript";
import { useMentionCatalog } from "./use-mention-catalog";

function EmptyState({
  agent,
  label,
  domain,
  autonomy,
  suggestions = [],
  checklist,
  onDismissChecklist,
  onPick,
}: {
  agent: string;
  label?: string;
  domain?: string;
  autonomy?: Autonomy;
  suggestions?: Suggestion[];
  checklist?: OnboardingChecklist | null;
  onDismissChecklist?: () => void;
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-7 overflow-y-auto px-6 py-12">
      <div className="flex w-full max-w-5xl flex-col gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Your AI workspace
        </p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          <span aria-hidden className="animate-cursor text-primary">
            ▍
          </span>
          tulipfarm
        </h1>
        <p className="text-muted-foreground">The business agent harness. Ask anything below.</p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <AgentGlyph
            name={agent}
            domain={domain}
            autonomy={autonomy}
            size="xs"
            active
            decorative
          />
          <span>ready</span>
          <span aria-hidden className="text-border">
            ·
          </span>
          <span>{label ?? agent}</span>
        </p>
      </div>
      <div className="flex w-full max-w-5xl flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="cursor-pointer rounded-sm border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            {s.label}
          </button>
        ))}
      </div>
      {checklist && !checklist.dismissed ? (
        <GettingStartedCard
          checklist={checklist}
          onPick={onPick}
          onDismiss={() => onDismissChecklist?.()}
        />
      ) : null}
    </div>
  );
}

/** Layer-1 chat surface: empty state → live transcript, with the composer pinned to the bottom. */
export function ChatPanel({
  agentId,
  title,
  defaultModel = "standard",
  suggestions = [],
  checklist,
  onDismissChecklist,
  initialConversationId,
  initialMessages,
  onConversationChange,
}: {
  agentId?: string;
  // The conversation's title (restored chats); shown beside the agent in the header.
  title?: string;
  defaultModel?: ModelTier;
  suggestions?: Suggestion[];
  checklist?: OnboardingChecklist | null;
  onDismissChecklist?: () => void;
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
  onConversationChange?: (conversationId: string | undefined) => void;
}) {
  const {
    messages,
    status,
    error,
    currentAgent,
    conversationId,
    send,
    stop,
    approve,
    regenerate,
    sendFeedback,
    sendSurfaceInteraction,
    connectionState,
  } = useChatStream({
    initialConversationId,
    initialMessages,
    onConversationChange,
  });
  const busy = status === "submitted" || status === "streaming";
  // Prefer the live agent from a handoff; fall back to the restored conversation's persisted agent.
  const agent = currentAgent || agentId || "TulipFarm";
  // Resolve the active agent's domain/autonomy so its header glyph matches the agents list. Undefined
  // until the list loads (and for the two platform agents) → glyph uses its name-hashed fallback.
  // Mentionable entities: powers the active-agent header glyph AND highlights @/#// tags (with hover
  // cards) inside user messages.
  const { entries, agentByName } = useMentionCatalog();
  const agentInfo = agentByName.get(agent);
  // The composer's MODEL selector reflects the active agent's tier (and a mentioned agent's tier as
  // it's typed). asTier narrows each agent's raw frontmatter `model` to a pickable tier (or undefined,
  // for "auto"/raw ids → the selector then keeps its current value).
  const activeAgentTier = asTier(agentInfo?.model);
  const tierById = (id: string) => asTier(agentByName.get(id)?.model);
  // Live conversation title from the sidebar context — fills in for fresh chats once the title is
  // async-generated; the prop is the immediate value for restored chats (from the loader).
  const { conversations, activeChatId } = useConversations();
  const liveTitle = activeChatId
    ? (conversations.find((c) => c.id === activeChatId)?.title ?? undefined)
    : undefined;
  const displayTitle = liveTitle ?? title;
  const hasMessages = messages.length > 0;
  // Actionable errors (e.g. "LLM not configured") get a deep-link CTA to where the user fixes them.
  const errorCta = status === "error" ? errorAction(error) : null;

  return (
    <div className="flex h-[calc(100svh-3.25rem)] flex-col lg:h-full">
      {hasMessages ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2.5">
          <AgentGlyph
            name={agent}
            domain={agentInfo?.domain}
            autonomy={agentInfo?.autonomy}
            size="sm"
            active
            state={busy ? "thinking" : "idle"}
            decorative
          />
          <span className="text-xs font-medium text-foreground">{agentInfo?.label ?? agent}</span>
          {displayTitle ? (
            <>
              <span aria-hidden className="text-border">
                ·
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground">{displayTitle}</span>
            </>
          ) : null}
        </header>
      ) : null}
      {hasMessages ? (
        <Transcript
          messages={messages}
          status={status}
          mentions={entries}
          onApprove={approve}
          onRegenerate={regenerate}
          onFeedback={sendFeedback}
          onSurfaceInteraction={sendSurfaceInteraction}
        />
      ) : (
        <EmptyState
          agent={agent}
          label={agentInfo?.label}
          domain={agentInfo?.domain}
          autonomy={agentInfo?.autonomy}
          suggestions={suggestions}
          checklist={checklist}
          onDismissChecklist={onDismissChecklist}
          onPick={(text) => send(text, { model: activeAgentTier ?? defaultModel, agentId })}
        />
      )}
      {status === "error" ? (
        <p className="mx-auto w-full max-w-3xl px-6 pb-2 text-xs text-destructive">
          [error] {error ?? "the stream failed"} — try again
          {errorCta ? (
            <>
              {" · "}
              <Link
                to={errorCta.to}
                className="cursor-pointer font-medium underline underline-offset-2 hover:text-foreground"
              >
                {errorCta.label} →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {connectionState === "reconnecting" ? (
        <div className="mx-auto w-full max-w-3xl px-6 pb-2">
          <ConnectionStatus state="reconnecting" />
        </div>
      ) : null}
      <Composer
        busy={busy}
        defaultModel={defaultModel}
        onStop={stop}
        // The MODEL selector follows the active agent's tier, and a mentioned agent's tier as typed.
        activeAgentTier={activeAgentTier}
        tierById={tierById}
        // A `@agent` mention in the composer overrides the panel's active agent for that turn.
        onSend={(text, opts) => send(text, { ...opts, agentId: opts.agentId ?? agentId })}
      />
      <ChatDebugDrawer conversationId={conversationId} />
    </div>
  );
}
