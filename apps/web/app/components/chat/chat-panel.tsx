import { Link } from "@remix-run/react";
import { AgentGlyph } from "~/components/agent-glyph";
import { ConnectionStatus } from "~/components/shell/states";
import type { ChatMessage, ChatModelSelector } from "~/lib/chat/types";
import { useChatStream } from "~/lib/chat/use-chat-stream";
import type { ConversationTurn } from "~/lib/conversations";
import { errorAction } from "~/lib/error-actions";
import type { Suggestion } from "~/lib/onboarding";
import type { Task } from "~/lib/tasks";
import { ChatDebugDrawer } from "./chat-debug-drawer";
import { Composer } from "./composer";
import { asPickerPreset, DEFAULT_CHAT_MODEL_SELECTOR } from "./model-selector";
import { TasksPreviewCard } from "./tasks-preview-card";
import { Transcript } from "./transcript";
import { useMentionCatalog } from "./use-mention-catalog";

function EmptyState({
  businessName,
  agent,
  label,
  tasks,
  onPick,
}: {
  businessName?: string;
  agent?: string;
  label?: string;
  tasks: Task[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-1 min-h-0 overflow-y-auto">
      <section className="mx-auto flex w-full max-w-4xl flex-col justify-start gap-7 px-4 py-8 sm:px-6 sm:py-14 md:justify-center">
        <div className="grid gap-7 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 md:grid-cols-[minmax(0,1fr)_12rem] md:items-end">
          <div>
            <p className="mb-3 text-sm font-medium text-primary">Chat</p>
            <h1 className="max-w-2xl text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              {agent
                ? `Chat with ${label ?? agent}`
                : businessName
                  ? `What can I help ${businessName} with?`
                  : "What can I help with?"}
            </h1>
            <p className="mt-3 max-w-xl text-pretty text-base leading-7 text-muted-foreground">
              {agent
                ? "This Chat is using a user-created Agent."
                : "Ask about your business, build your system, or start with a suggested prompt."}
            </p>
          </div>
          <aside className="border-l border-border pl-4 text-xs leading-6 text-muted-foreground">
            <p className="font-medium text-foreground">Add context as you write</p>
            <p>
              <kbd className="font-mono text-primary">@</kbd> Agent
            </p>
            <p>
              <kbd className="font-mono text-primary">/</kbd> Skill
            </p>
            <p>
              <kbd className="font-mono text-primary">#</kbd> Resource type
            </p>
            <p>
              <kbd className="font-mono text-primary">~</kbd> Knowledge page
            </p>
          </aside>
        </div>
        {!agent && tasks.length > 0 ? <TasksPreviewCard tasks={tasks} onPick={onPick} /> : null}
      </section>
    </div>
  );
}

/** Layer-1 chat surface: empty state → live transcript, with the composer pinned to the bottom. */
export function ChatPanel({
  agentId,
  defaultModel = DEFAULT_CHAT_MODEL_SELECTOR,
  suggestions = [],
  tasks = [],
  businessName,
  initialConversationId,
  initialMessages,
  initialTurn,
  onConversationChange,
  initialDraft,
  attachFileId,
}: {
  agentId?: string;
  defaultModel?: ChatModelSelector;
  suggestions?: Suggestion[];
  tasks?: Task[];
  businessName?: string;
  initialConversationId?: string;
  initialMessages?: ChatMessage[];
  initialTurn?: ConversationTurn | null;
  onConversationChange?: (conversationId: string | undefined) => void;
  /** A prompt to draft into the composer once, seeded by the onboarding Companion. */
  initialDraft?: string;
  /** An already-stored File to stage on the composer, handed over by the Files library. */
  attachFileId?: string | null;
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
    tryHarder,
    sendFeedback,
    sendSurfaceInteraction,
    connectionState,
  } = useChatStream({
    initialConversationId,
    initialMessages,
    initialTurn,
    onConversationChange,
  });
  const busy = status === "submitted" || status === "streaming";
  // Prefer the live agent from a handoff; fall back to the restored conversation's persisted agent.
  const routedAgentName = currentAgent || agentId;
  const activeAgentName = routedAgentName === "TulipFarm" ? undefined : routedAgentName;
  // Resolve the active agent's domain/autonomy so its header glyph matches the agents list. Undefined
  // until the list loads (and for the two platform agents) → glyph uses its name-hashed fallback.
  // Mentionable entities: powers the active-agent header glyph AND highlights @/#// tags (with hover
  // cards) inside user messages.
  const { entries, agentByName } = useMentionCatalog();
  const agentInfo = activeAgentName ? agentByName.get(activeAgentName) : undefined;
  // The composer's preset selector reflects the active agent's preset (and a mentioned agent's
  // preset as it's typed). Raw ids yield undefined, so the picker keeps its current value.
  const activeAgentPreset = asPickerPreset(agentInfo?.model);
  const presetById = (id: string) => asPickerPreset(agentByName.get(id)?.model);
  const hasMessages = messages.length > 0;
  // Actionable errors (e.g. "LLM not configured") get a deep-link CTA to where the user fixes them.
  const errorCta = status === "error" ? errorAction(error) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The top bar names the conversation, so this strip only says what it can't: which Agent is
          driving the chat. Without an Agent there is nothing left to show and it collapses away. */}
      {hasMessages && activeAgentName ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <AgentGlyph
            name={activeAgentName}
            domain={agentInfo?.domain}
            autonomy={agentInfo?.autonomy}
            size="sm"
            active
            state={busy ? "thinking" : "idle"}
            decorative
          />
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            Agent ·{" "}
            <span className="font-medium text-foreground">
              {agentInfo?.label ?? activeAgentName}
            </span>
          </p>
        </header>
      ) : null}
      {hasMessages ? (
        <Transcript
          messages={messages}
          status={status}
          mentions={entries}
          onApprove={approve}
          onRegenerate={regenerate}
          onTryHarder={tryHarder}
          onFeedback={sendFeedback}
          onSurfaceInteraction={sendSurfaceInteraction}
        />
      ) : (
        <EmptyState
          businessName={businessName}
          agent={activeAgentName}
          label={agentInfo?.label}
          tasks={tasks}
          onPick={(text) => send(text, { model: activeAgentPreset ?? defaultModel, agentId })}
        />
      )}
      {status === "error" ? (
        <div
          role="alert"
          className="mx-auto mb-2 w-[calc(100%-2rem)] max-w-4xl rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:w-[calc(100%-3rem)]"
        >
          <span className="font-medium">Response failed.</span>{" "}
          {error ?? "The stream ended unexpectedly. Try again."}
          {errorCta ? (
            <>
              {" "}
              <Link
                to={errorCta.to}
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                {errorCta.label}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
      {connectionState === "reconnecting" ? (
        <div className="mx-auto w-full max-w-4xl px-4 pb-2 sm:px-6">
          <ConnectionStatus state="reconnecting" />
        </div>
      ) : null}
      <Composer
        busy={busy}
        defaultModel={defaultModel}
        onStop={stop}
        activeAgentPreset={activeAgentPreset}
        presetById={presetById}
        activeAgent={
          activeAgentName
            ? {
                name: activeAgentName,
                label: agentInfo?.label,
                domain: agentInfo?.domain,
                autonomy: agentInfo?.autonomy,
              }
            : undefined
        }
        suggestions={hasMessages ? [] : suggestions}
        initialDraft={initialDraft}
        attachFileId={attachFileId}
        // A `@agent` mention in the composer overrides the panel's active agent for that turn.
        onSend={(text, opts) => send(text, { ...opts, agentId: opts.agentId ?? agentId })}
      />
      <ChatDebugDrawer conversationId={conversationId} />
    </div>
  );
}
