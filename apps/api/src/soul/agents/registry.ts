import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { GENERAL_ASSISTANT, getPlatformAgent, PLATFORM_AGENTS } from "./platform-agents";

/**
 * The agent registry (AGT-V1-007). Two code-defined platform agents (`GeneralAssistant` front desk
 * + `InformationArchitect` creation specialist) are always present and resolve before soul agents.
 * Soul agents are loaded at boot into `SoulLoader.agents`. Both are presented as one resolvable set.
 * Soul agents share flat ALLOW_ALL tool access; platform agents carry a `toolAllowlist` enforced in
 * the chat route. See `platform-agents.ts`.
 */

// Re-exported for the many callers (chat route, agents REST, tests) that already import them here.
export {
  EXCLUSIVE_SOUL_WRITE_TOOLS,
  GENERAL_ASSISTANT,
  GENERAL_ASSISTANT_NAME,
  getPlatformAgent,
  INFORMATION_ARCHITECT,
  INFORMATION_ARCHITECT_NAME,
  INFORMATION_ARCHITECT_TOOL_ALLOWLIST,
  PLATFORM_AGENTS,
  type PlatformAgent,
} from "./platform-agents";

/**
 * Resolve the active agent for a chat turn. A platform agent (matched by its reserved PascalCase
 * name) wins; otherwise the named soul agent; otherwise the `GeneralAssistant` fallback. Always
 * returns an agent.
 */
export function resolveAgent(soulLoader: SoulLoader | undefined, agentId?: string): SoulAgent {
  const platform = getPlatformAgent(agentId);
  if (platform) return platform;
  const found = agentId ? soulLoader?.agents.get(agentId) : undefined;
  return found ?? GENERAL_ASSISTANT;
}

/** The registry view: the platform agents first, then all loaded soul agents. */
export function listAgents(soulLoader: SoulLoader | undefined): SoulAgent[] {
  const soul = soulLoader ? Array.from(soulLoader.agents.values()) : [];
  return [...PLATFORM_AGENTS, ...soul];
}

/**
 * Look up a single agent by exact name (the detail view). Returns a platform agent or the named
 * soul agent, or `undefined` when the name is unknown. Unlike `resolveAgent`, this does NOT fall
 * back to a built-in — callers use `undefined` to return a 404.
 */
export function getAgent(soulLoader: SoulLoader | undefined, name: string): SoulAgent | undefined {
  const platform = getPlatformAgent(name);
  if (platform) return platform;
  return soulLoader?.agents.get(name);
}
