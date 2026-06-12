import { type ClientLoaderFunctionArgs, type MetaFunction, useLoaderData } from "@remix-run/react";
import { ChatPanel } from "~/components/chat/chat-panel";
import { getAgent } from "~/lib/agents";
import type { ModelTier } from "~/lib/chat/types";
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
  return <ChatPanel agentId={agentId} defaultModel={defaultModel} suggestions={suggestions} />;
}
