import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  redirect,
  useLoaderData,
} from "@remix-run/react";
import { useEffect } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { getAgent } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { messagesToTimeline } from "~/lib/chat/hydrate";
import type { ModelTier } from "~/lib/chat/types";
import { getConversation, getConversationMessages } from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";
import { getConversationFeedback } from "~/lib/feedback";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Restore a persisted chat (UUID-chat persistence). Fetch the conversation + its messages, rehydrate
// the timeline, and seed ChatPanel so the transcript renders and follow-up turns reuse the same id. A
// 404 (unknown/deleted id) redirects to the new-chat surface rather than dead-ending. The default
// model tier is derived from the conversation's agent, mirroring the index route.
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id as string;
  let convo: Awaited<ReturnType<typeof getConversation>>;
  let messages: Awaited<ReturnType<typeof getConversationMessages>>;
  try {
    [convo, messages] = await Promise.all([getConversation(id), getConversationMessages(id)]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw redirect("/");
    throw err;
  }

  // Best-effort: the caller's prior thumbs votes seed the transcript. A failure (feedback API hiccup)
  // just means no votes are shown — never block the chat restore on it.
  let votes: Map<string, "up" | "down"> | undefined;
  try {
    const feedback = await getConversationFeedback(id);
    votes = new Map(feedback.map((f) => [f.messageId, f.rating]));
  } catch {
    votes = undefined;
  }

  const agentId = convo.agentId ?? undefined;
  let defaultModel: ModelTier = "standard";
  if (agentId) {
    try {
      const agent = await getAgent(agentId);
      if (agent.model === "complex") defaultModel = "complex";
    } catch {
      // Unknown Agent / transient API error — keep the standard default rather than break chat.
    }
  }

  return {
    id,
    title: convo.title,
    agentId,
    defaultModel,
    messages: messagesToTimeline(messages, votes),
  };
}

export default function ChatConversationRoute() {
  const { id, title, agentId, defaultModel, messages } = useLoaderData<typeof clientLoader>();
  const { refresh, setActiveChatTitle } = useConversations();
  // The top bar names the conversation. Publish the loader's title so it is right immediately, and
  // stays right for chats older than the sidebar's Recent list.
  useEffect(() => {
    setActiveChatTitle(id, title ?? null);
  }, [id, title, setActiveChatTitle]);
  return (
    <ChatPanel
      key={id}
      agentId={agentId}
      defaultModel={defaultModel}
      initialConversationId={id}
      initialMessages={messages}
      onConversationChange={refresh}
    />
  );
}
