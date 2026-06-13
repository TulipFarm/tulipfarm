import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  redirect,
  useLoaderData,
} from "@remix-run/react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { getAgent } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { messagesToTimeline } from "~/lib/chat/hydrate";
import type { ModelTier } from "~/lib/chat/types";
import { getConversation, getConversationMessages } from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";

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

  const agentId = convo.agentId ?? undefined;
  let defaultModel: ModelTier = "standard";
  try {
    const agent = await getAgent(agentId ?? "GeneralAssistant");
    if (agent.model === "complex") defaultModel = "complex";
  } catch {
    // Unknown agent / transient API error — keep the standard default rather than break the page.
  }

  return {
    id,
    title: convo.title,
    agentId,
    defaultModel,
    messages: messagesToTimeline(messages),
  };
}

export default function ChatConversationRoute() {
  const { id, agentId, defaultModel, messages } = useLoaderData<typeof clientLoader>();
  const { refresh } = useConversations();
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
