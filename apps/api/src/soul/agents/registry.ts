import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";

/**
 * The agent registry (AGT-V1-007). Soul agents are loaded at boot into `SoulLoader.agents`; this module
 * adds the single built-in `GeneralAssistant` platform agent and presents both as one resolvable set.
 * All agents share flat ALLOW_ALL tool access — there is no per-agent tool ACL in V1.
 */

/**
 * Reserved name of the built-in platform agent. PascalCase, so it can never collide with a soul agent
 * name (those must match NAME_RE — kebab/lowercase).
 */
export const GENERAL_ASSISTANT_NAME = "GeneralAssistant";

/**
 * The single built-in platform agent. Not an AGENT.md on disk — it answers when no soul agent is
 * selected (fresh install, no selection, or a deleted/unknown id).
 */
export const GENERAL_ASSISTANT: SoulAgent = {
  name: GENERAL_ASSISTANT_NAME,
  frontmatter: {
    label: "General Assistant",
    description: "The default TulipFarm assistant — answers when no soul agent is selected.",
    model: "standard",
  },
  // V1 slice of the GeneralAssistant persona. Routing/transfer and resource/skill tooling from the
  // original POC are intentionally omitted until those tools land — the agent must not claim
  // capabilities it cannot perform on a flat ALLOW_ALL install.
  body: `## Identity

You are the assistant for TulipFarm — an AI-native business operating system that helps users manage their business data. You are the front desk: you answer everyday questions directly and help users get things done.

You are a helpful, knowledgeable business assistant.

Your current capabilities:

- Store and recall information in your working memory for cross-conversation context.
- Search the knowledge base and create knowledge documents and collections.

When users ask about something, focus on what you can actually do. If a request falls outside your current capabilities, be honest about it rather than guessing or pretending. You approach every interaction with a focus on getting things done efficiently while being clear about what you're doing and why.

## Decision Framework

- If the user's intent is clear, act immediately — don't ask for unnecessary confirmation.
- If the user's request is ambiguous, ask ONE clarifying question rather than guessing.
- When showing results, offer relevant follow-up actions.
- If an operation partially succeeds, report what worked and what didn't.`,
};

/**
 * Resolve the active agent for a chat turn. Returns the named soul agent when `agentId` matches a loaded
 * soul agent; otherwise falls back to the built-in `GeneralAssistant`. Always returns an agent.
 */
export function resolveAgent(soulLoader: SoulLoader | undefined, agentId?: string): SoulAgent {
  const found = agentId ? soulLoader?.agents.get(agentId) : undefined;
  return found ?? GENERAL_ASSISTANT;
}

/** The registry view: built-in `GeneralAssistant` first, then all loaded soul agents. */
export function listAgents(soulLoader: SoulLoader | undefined): SoulAgent[] {
  const soul = soulLoader ? Array.from(soulLoader.agents.values()) : [];
  return [GENERAL_ASSISTANT, ...soul];
}

/**
 * Look up a single agent by exact name (the detail view). Returns the built-in `GeneralAssistant` or the
 * named soul agent, or `undefined` when the name is unknown. Unlike `resolveAgent`, this does NOT fall
 * back to the built-in — callers use `undefined` to return a 404.
 */
export function getAgent(soulLoader: SoulLoader | undefined, name: string): SoulAgent | undefined {
  if (name === GENERAL_ASSISTANT_NAME) return GENERAL_ASSISTANT;
  return soulLoader?.agents.get(name);
}
