import { type ClientLoaderFunctionArgs, type MetaFunction, useLoaderData } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { DEFAULT_CHAT_MODEL_SELECTOR } from "~/components/chat/model-selector";
import type { ChatModelSelector } from "~/lib/chat/types";
import { useCompanion } from "~/lib/companion-context";
import { useConversations } from "~/lib/conversations-context";
import { listOnboardingSuggestions, type Suggestion } from "~/lib/onboarding";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Default surface: the live Layer-1 chat. The Agents "Chat with" shortcut routes here with
// `?agent=<name>` selects a user-created Agent. Without it, Chat uses the normal harness.
//
// Deliberately does no fetching: a clientLoader gates the first paint of the app's landing route,
// so anything awaited here is blank-screen time. Onboarding is fetched after mount instead.
export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agent") || undefined;
  // Seeded by the onboarding Companion (a Task's "chat" action) — drafted into the
  // composer, never auto-sent.
  const draft = url.searchParams.get("draft") || undefined;
  const defaultModel: ChatModelSelector = DEFAULT_CHAT_MODEL_SELECTOR;
  return { agentId, defaultModel, draft };
}

/*
 * Adaptive onboarding suggestions (ONB-V1-002/003), loaded after the chat surface is already on
 * screen. Decorative: a failed or slow fetch just leaves the chips absent, and chat is usable
 * throughout. Re-runs on "+ new chat" so a soul the agent just changed is reflected, matching the
 * route-loader refetch this replaced. Tasks come from `useCompanion()` instead of a separate
 * fetch here, so the "My Tasks" preview card and the Companion panel never drift out of sync.
 */
function useOnboardingSuggestions(newChatNonce: number) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: newChatNonce is a deliberate refetch trigger
  useEffect(() => {
    let cancelled = false;
    void listOnboardingSuggestions().then(
      (items) => !cancelled && setSuggestions(items),
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [newChatNonce]);

  return suggestions;
}

export default function ChatRoute() {
  const { agentId, defaultModel, draft } = useLoaderData<typeof clientLoader>();
  // Strip `?draft=` once applied so a reload or Back doesn't redraft over the user's own typing.
  useEffect(() => {
    if (!draft) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("draft");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [draft]);
  const { refresh, setActiveChatId, newChatNonce } = useConversations();
  const suggestions = useOnboardingSuggestions(newChatNonce);
  const { tasks } = useCompanion();
  // First turn of a fresh chat: refresh the Recent chats sidebar AND reflect the new conversation in
  // the URL so a reload restores it. We use `history.replaceState` rather than a router navigate so the
  // in-flight stream keeps streaming on this mounted route — no remount, no message re-fetch race.
  // `setActiveChatId` shallow-syncs the sidebar highlight (the router location stays "/"). The
  // `pathname === "/"` guard makes it a one-shot (the follow-up `finish` callback is then a no-op here).
  const onConversationChange = useCallback(
    (id: string | undefined) => {
      void refresh();
      if (id && window.location.pathname === "/") {
        window.history.replaceState(null, "", `/chat/${id}`);
        setActiveChatId(id);
      }
    },
    [refresh, setActiveChatId]
  );
  return (
    // `key` is bumped by startNewChat ("+ new chat") to force a fresh transcript even when the router
    // location is unchanged (a shallow-routed chat at "/"). It never changes mid-turn, so the live
    // stream is safe.
    <ChatPanel
      key={newChatNonce}
      agentId={agentId}
      defaultModel={defaultModel}
      suggestions={suggestions}
      tasks={tasks}
      onConversationChange={onConversationChange}
      initialDraft={draft}
    />
  );
}
