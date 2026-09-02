import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  redirect,
  useLoaderData,
} from "@remix-run/react";
import { useEffect } from "react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { asPickerPreset, DEFAULT_CHAT_MODEL_SELECTOR } from "~/components/chat/model-selector";
import { getAgent } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { messagesToTimeline } from "~/lib/chat/hydrate";
import type { ChatModelSelector } from "~/lib/chat/types";
import { getConversation, getConversationMessages } from "~/lib/conversations";
import { useConversations } from "~/lib/conversations-context";
import { getConversationFeedback } from "~/lib/feedback";

export const meta: MetaFunction = () => [{ title: "Chat · tulipfarm" }];

// Restore a persisted chat (UUID-chat persistence). Fetch the conversation + its messages, rehydrate
// the timeline, and seed ChatPanel so the transcript renders and follow-up turns reuse the same id. A
// 404 (unknown/deleted id) redirects to the new-chat surface rather than dead-ending. The default
// effort preset is derived from the conversation's agent, mirroring the index route.
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const id = params.id as string;
  // A deep link renders a full transcript on arrival, so start its lazily-split chunk now rather
  // than after the data resolves — the two then land together instead of end to end.
  void import("~/components/chat/transcript");
  let convo: Awaited<ReturnType<typeof getConversation>>;
  let messages: Awaited<ReturnType<typeof getConversationMessages>>;
  // Votes are best-effort: the caller's prior thumbs seed the transcript, and a feedback API hiccup
  // just means no votes are shown. It rides in this batch rather than after it because it depends on
  // nothing the batch returns — awaiting it separately cost a whole round trip before first paint.
  let votes: Map<string, "up" | "down"> | undefined;
  try {
    const [conversation, messageList, feedback] = await Promise.all([
      getConversation(id),
      getConversationMessages(id),
      getConversationFeedback(id).catch(() => null),
    ]);
    convo = conversation;
    messages = messageList;
    votes = feedback ? new Map(feedback.map((f) => [f.messageId, f.rating])) : undefined;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw redirect("/");
    throw err;
  }

  const agentId = convo.agentId ?? undefined;
  let defaultModel: ChatModelSelector = DEFAULT_CHAT_MODEL_SELECTOR;
  if (agentId) {
    try {
      const agent = await getAgent(agentId);
      defaultModel = asPickerPreset(agent.model) ?? DEFAULT_CHAT_MODEL_SELECTOR;
    } catch {
      // Unknown Agent / transient API error — keep Auto rather than break Chat.
    }
  }

  return {
    id,
    title: convo.title,
    agentId,
    defaultModel,
    messages: messagesToTimeline(messages, votes),
    latestTurn: convo.latestTurn,
  };
}

export default function ChatConversationRoute() {
  const { id, title, agentId, defaultModel, messages, latestTurn } =
    useLoaderData<typeof clientLoader>();
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
      initialTurn={latestTurn}
      onConversationChange={refresh}
    />
  );
}
