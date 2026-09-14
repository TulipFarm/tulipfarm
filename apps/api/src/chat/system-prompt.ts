import { assembleSystemPrompt } from "@tulipfarm/agent-runtime";
import type { ConversationMode } from "@tulipfarm/schema";
import type { SoulAgent } from "@tulipfarm/soul";

/** The Agent's AGENT.md body is the `<agent-personality>` block; the platform law is built in. */
export function assembleAgentSystemPrompt(args: {
  agent: SoulAgent;
  mode?: ConversationMode | null;
}): string {
  return assembleSystemPrompt({ personality: args.agent.body, mode: args.mode || undefined });
}
