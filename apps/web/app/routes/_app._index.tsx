import { type ClientLoaderFunctionArgs, type MetaFunction, useLoaderData } from "@remix-run/react";
import { useCallback, useState } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import type { ModelTier } from "~/lib/chat/types";
import { useConversations } from "~/lib/conversations-context";
import {
  dismissOnboardingChecklist,
  getOnboardingChecklist,
  listOnboardingSuggestions,
} from "~/lib/onboarding";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Default surface (AC-V1-001): the live Layer-1 chat. The Agents "Chat with" shortcut routes here with
// `?agent=<name>` selects a user-created Agent. Without it, Chat uses the normal harness.
export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const agentId = new URL(request.url).searchParams.get("agent") || undefined;
  const defaultModel: ModelTier = "standard";
  // Adaptive onboarding suggestions (ONB-V1-002/003) + the Getting-started checklist (ONB-V1).
  // Both non-blocking (AC-V1-001): a failed fetch resolves to a benign default so chat always
  // renders (mirrors the agent lookup above — no hard dependency).
  const [suggestions, checklist] = await Promise.all([
    listOnboardingSuggestions().catch(() => []),
    getOnboardingChecklist().catch(() => null),
  ]);
  return { agentId, defaultModel, suggestions, checklist };
}

export default function ChatRoute() {
  const { agentId, defaultModel, suggestions, checklist } = useLoaderData<typeof clientLoader>();
  const { refresh, setActiveChatId, newChatNonce } = useConversations();
  // Dismissal lives here, ABOVE the `newChatNonce`-keyed ChatPanel, so "+ new chat" (which remounts
  // ChatPanel) doesn't resurrect a card the user already dismissed. Seeded from the persisted flag.
  const [checklistDismissed, setChecklistDismissed] = useState(checklist?.dismissed ?? false);
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
      checklist={checklistDismissed ? null : checklist}
      onDismissChecklist={() => {
        setChecklistDismissed(true); // optimistic — survives ChatPanel remount
        void dismissOnboardingChecklist().catch(() => {});
      }}
      onConversationChange={onConversationChange}
    />
  );
}
