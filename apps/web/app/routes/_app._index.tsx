import { type ClientLoaderFunctionArgs, type MetaFunction, useLoaderData } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { DEFAULT_CHAT_MODEL_SELECTOR } from "~/components/chat/model-selector";
import type { ChatModelSelector } from "~/lib/chat/types";
import { useConversations } from "~/lib/conversations-context";
import {
  dismissOnboardingChecklist,
  getOnboardingChecklist,
  listOnboardingSuggestions,
  type OnboardingChecklist,
  type Suggestion,
} from "~/lib/onboarding";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Default surface: the live Layer-1 chat. The Agents "Chat with" shortcut routes here with
// `?agent=<name>` selects a user-created Agent. Without it, Chat uses the normal harness.
//
// Deliberately does no fetching: a clientLoader gates the first paint of the app's landing route,
// so anything awaited here is blank-screen time. Onboarding is fetched after mount instead.
export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const agentId = new URL(request.url).searchParams.get("agent") || undefined;
  const defaultModel: ChatModelSelector = DEFAULT_CHAT_MODEL_SELECTOR;
  return { agentId, defaultModel };
}

/*
 * Adaptive onboarding suggestions (ONB-V1-002/003) + the Getting-started checklist (ONB-V1), loaded
 * after the chat surface is already on screen. Both are decorative: a failed or slow fetch just
 * leaves the chips absent, and chat is usable throughout. Re-runs on "+ new chat" so a soul the
 * agent just changed is reflected, matching the route-loader refetch this replaced.
 */
function useOnboarding(newChatNonce: number) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [checklist, setChecklist] = useState<OnboardingChecklist | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: newChatNonce is a deliberate refetch trigger
  useEffect(() => {
    let cancelled = false;
    void listOnboardingSuggestions().then(
      (items) => !cancelled && setSuggestions(items),
      () => {}
    );
    void getOnboardingChecklist().then(
      (value) => {
        if (cancelled) return;
        setChecklist(value);
        // Latches on only. A slower fetch must never resurrect a card the user just dismissed, and an
        // optimistic dismiss whose PUT failed should still stay dismissed for this session.
        if (value?.dismissed) setDismissed(true);
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [newChatNonce]);

  return { suggestions, checklist, dismissed, setDismissed };
}

export default function ChatRoute() {
  const { agentId, defaultModel } = useLoaderData<typeof clientLoader>();
  const { refresh, setActiveChatId, newChatNonce } = useConversations();
  // Dismissal lives here, ABOVE the `newChatNonce`-keyed ChatPanel, so "+ new chat" (which remounts
  // ChatPanel) doesn't resurrect a card the user already dismissed.
  const { suggestions, checklist, dismissed, setDismissed } = useOnboarding(newChatNonce);
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
      businessName={checklist?.businessName}
      checklist={dismissed ? null : checklist}
      onDismissChecklist={() => {
        setDismissed(true); // optimistic — survives ChatPanel remount
        void dismissOnboardingChecklist().catch(() => {});
      }}
      onConversationChange={onConversationChange}
    />
  );
}
