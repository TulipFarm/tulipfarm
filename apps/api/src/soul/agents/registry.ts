import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import type { AgentResolver, HostedAgent } from "@tulipfarm/tool-host";
import { DEFAULT_ASSISTANT, getDefaultAssistant } from "./platform-agents";

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

/**
 * The `AgentResolver` the Tool host composes with. Only the built-in harness carries a tool
 * allowlist, so an authored Agent resolves to none and is offered the whole authorized catalog.
 */
export function hostedAgentResolver(soulLoader: SoulLoader | undefined): AgentResolver {
  return {
    resolve(agentId?: string): HostedAgent {
      const agent = resolveAgent(soulLoader, agentId);
      const allowlist = getDefaultAssistant(agent.name)?.toolAllowlist;
      return { name: agent.name, ...(allowlist === undefined ? {} : { toolAllowlist: allowlist }) };
    },
  };
}

/** The registry view contains only user-created Soul Agents. */
export function listAgents(soulLoader: SoulLoader | undefined): SoulAgent[] {
  return soulLoader ? Array.from(soulLoader.agents.values()) : [];
}

/** Look up one user-created Soul Agent for the detail view. */
export function getAgent(soulLoader: SoulLoader | undefined, name: string): SoulAgent | undefined {
  return soulLoader?.agents.get(name);
}
