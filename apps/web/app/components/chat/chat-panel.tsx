import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import { ConnectionStatus } from "~/components/shell/states";
import { Link } from "~/components/ui/link";
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
import { useMentionCatalog } from "./use-mention-catalog";

/*
 * The transcript drags in the markdown renderer (react-markdown + remark + micromark, 34KB gz) on
 * top of its own 24KB — none of which a new chat has anything to render with. Splitting it out keeps
 * both off the landing route's critical path, where they were blocking the first API call.
 */
const Transcript = lazy(() => import("./transcript").then((m) => ({ default: m.Transcript })));

const GENERIC_GREETINGS = [
  "What’s on your mind?",
  "Where should we start?",
  "What needs sorting out?",
  "What are you thinking through?",
  "What should we tackle?",
  "Where do you want to begin?",
  "What can we make easier?",
  "Ready when you are.",
] as const;

function greetingFor(userName: string | undefined, greetingIndex: number) {
  const firstName = userName?.trim().split(/\s+/)[0];
  const greetings = firstName
    ? [
        `What’s on your mind, ${firstName}?`,
        `Where should we start, ${firstName}?`,
        `What needs sorting out, ${firstName}?`,
        `What are you thinking through, ${firstName}?`,
        `What should we tackle, ${firstName}?`,
        `Where do you want to begin, ${firstName}?`,
        `What can we make easier, ${firstName}?`,
        `Ready when you are, ${firstName}.`,
      ]
    : GENERIC_GREETINGS;
  return greetings[greetingIndex % greetings.length];
}

function EmptyState({
  businessName,
  userName,
  greetingIndex,
  agent,
  label,
  tasks,
  onPick,
  composer,
}: {
  businessName?: string;
  userName?: string;
  greetingIndex: number;
  agent?: string;
  label?: string;
  tasks: Task[];
  onPick: (text: string) => void;
  composer: ReactNode;
}) {
  const title = agent
    ? `Chat with ${label ?? agent}`
    : businessName
      ? `Where should we start with ${businessName}?`
      : greetingFor(userName, greetingIndex);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section
        aria-labelledby="new-chat-title"
        className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-10 sm:px-6"
      >
        <div className="text-center">
          <h1
            id="new-chat-title"
            className="text-balance text-xl font-semibold tracking-tight text-foreground"
          >
            {title}
          </h1>
          {agent ? (
            <p className="mt-2 text-sm text-muted-foreground">
              This Chat is using a user-created Agent.
            </p>
          ) : null}
        </div>
        <div className="mt-5">{composer}</div>
        {!agent && tasks.length > 0 ? <TasksPreviewCard tasks={tasks} onPick={onPick} /> : null}
      </section>
    </div>
  );
}

/** Layer-1 Chat surface: centered first prompt → live transcript with a docked composer. */
export function ChatPanel({
  agentId,
  defaultModel = DEFAULT_CHAT_MODEL_SELECTOR,
  suggestions = [],
  tasks = [],
  businessName,
  userName,
  greetingIndex = 0,
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
  userName?: string;
  greetingIndex?: number;
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
    errorDetails,
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
  const [revisionDraft, setRevisionDraft] = useState<{ key: string; text: string } | null>(null);
  // Fetch the transcript's chunk as soon as the panel exists rather than when the first turn needs
  // it — off the critical path, but resident well before anyone has finished typing.
  useEffect(() => {
    void import("./transcript");
  }, []);
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
  const retryableFailure =
    errorDetails?.reason === "model_rate_limited" ||
    errorDetails?.reason === "model_provider_unavailable" ||
    errorDetails?.reason === "model_error";
  const composer = (
    <Composer
      key={revisionDraft?.key ?? "composer"}
      placement={hasMessages ? "docked" : "centered"}
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
      initialDraft={revisionDraft?.text ?? initialDraft}
      attachFileId={attachFileId}
      onSend={(text, opts) => send(text, { ...opts, agentId: opts.agentId ?? agentId })}
    />
  );

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
        <Suspense fallback={<div className="min-h-0 flex-1" />}>
          <Transcript
            messages={messages}
            status={status}
            mentions={entries}
            onApprove={approve}
            onRegenerate={regenerate}
            onTryHarder={tryHarder}
            onFeedback={sendFeedback}
            onSurfaceInteraction={sendSurfaceInteraction}
            onReviseDraft={(draft) =>
              setRevisionDraft({
                key: draft.draftId,
                text: `Please revise ${draft.filename}: `,
              })
            }
          />
        </Suspense>
      ) : (
        <EmptyState
          businessName={businessName}
          userName={userName}
          greetingIndex={greetingIndex}
          agent={activeAgentName}
          label={agentInfo?.label}
          tasks={tasks}
          onPick={(text) => send(text, { model: activeAgentPreset ?? defaultModel, agentId })}
          composer={composer}
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
          {retryableFailure ? (
            <button
              type="button"
              onClick={() => void regenerate()}
              className="ml-2 min-h-11 font-medium underline underline-offset-2 hover:text-foreground"
            >
              Retry
            </button>
          ) : null}
          {errorDetails ? (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Class: {errorDetails.reason ?? "unknown"}
              {errorDetails.modelId ? ` · Model: ${errorDetails.modelId}` : ""}
              {errorDetails.requestId ? ` · Reference: ${errorDetails.requestId}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      {connectionState === "reconnecting" ? (
        <div className="mx-auto w-full max-w-4xl px-4 pb-2 sm:px-6">
          <ConnectionStatus state="reconnecting" />
        </div>
      ) : null}
      {hasMessages ? composer : null}
      <ChatDebugDrawer conversationId={conversationId} />
    </div>
  );
}
