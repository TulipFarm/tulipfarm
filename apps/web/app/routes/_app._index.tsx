import { type ClientLoaderFunctionArgs, type MetaFunction, useLoaderData } from "@remix-run/react";
import { useCallback } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { getAgent } from "~/lib/agents";
import type { ModelTier } from "~/lib/chat/types";
import { useConversations } from "~/lib/conversations-context";
import { listOnboardingSuggestions } from "~/lib/onboarding";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Default surface (AC-V1-001): the live Layer-1 chat. The Agents "Chat with" shortcut routes here with
// ?agent=<name> to seed the conversation's agent; the API falls back to GeneralAssistant when absent.
// The composer's default model tier comes from the active agent's frontmatter (GeneralAssistant →
// standard). Anything other than `complex` resolves to `standard`, and a failed lookup never blocks
// chat — it falls back to standard.
export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const agentId = new URL(request.url).searchParams.get("agent") || undefined;
  let defaultModel: ModelTier = "standard";
  try {
    const agent = await getAgent(agentId ?? "GeneralAssistant");
    if (agent.model === "complex") defaultModel = "complex";
  } catch {
    // Unknown agent / transient API error — keep the standard default rather than break the page.
  }
  // Adaptive onboarding suggestions (ONB-V1-002/003). Non-blocking (AC-V1-001): a failed fetch
  // resolves to [] so chat always renders (mirrors the agent lookup above — no hard dependency).
  const suggestions = await listOnboardingSuggestions().catch(() => []);
  return { agentId, defaultModel, suggestions };
}

export default function ChatRoute() {
  const { agentId, defaultModel, suggestions } = useLoaderData<typeof clientLoader>();
  const { refresh, setActiveChatId, newChatNonce } = useConversations();
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
      onConversationChange={onConversationChange}
    />
  );
}
