import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { DEFAULT_ASSISTANT } from "./platform-agents";

/**
 * User-created Agent registry. Normal chat uses the unlisted default harness when no Soul Agent
 * is selected; only authored AGENT.md files are exposed as Agents in the API and UI.
 */

export {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  type PlatformAgent,
} from "./platform-agents";

/** Resolve a named Soul Agent, falling back to the normal-chat harness. */
export function resolveAgent(soulLoader: SoulLoader | undefined, agentId?: string): SoulAgent {
  return (agentId ? soulLoader?.agents.get(agentId) : undefined) ?? DEFAULT_ASSISTANT;
}

/** The registry view contains only user-created Soul Agents. */
export function listAgents(soulLoader: SoulLoader | undefined): SoulAgent[] {
  return soulLoader ? Array.from(soulLoader.agents.values()) : [];
}

/** Look up one user-created Soul Agent for the detail view. */
export function getAgent(soulLoader: SoulLoader | undefined, name: string): SoulAgent | undefined {
  return soulLoader?.agents.get(name);
}
