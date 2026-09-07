import type { SoulLoader } from "../published-loader";
import type { SoulAgent } from "../types";
import { resolveAgentRef } from "./agent-id";
import { DEFAULT_ASSISTANT, DEFAULT_ASSISTANT_ID } from "./platform-agents";

/**
 * User-created Agent registry. Normal chat uses the unlisted default harness when no Soul Agent
 * is selected; only authored AGENT.md files are exposed as Agents in the API and UI.
 */

export {
  DEFAULT_ASSISTANT,
  DEFAULT_ASSISTANT_ID,
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  type PlatformAgent,
} from "./platform-agents";

/**
 * Resolve the Agent a reference names, by id or by Soul name.
 *
 * Naming nothing is the request that selected no Agent, which is normal chat on the default
 * harness. Naming something the Soul does not have is different in kind and answers `undefined`:
 * every Agent used to hold the same wide Role, so falling back was harmless, but a caller-supplied
 * reference that resolves to nothing must never borrow the default assistant's authority once
 * Roles differ per Agent. Callers must refuse, not substitute.
 */
export function resolveAgent(
  soulLoader: SoulLoader | undefined,
  agentId?: string
): SoulAgent | undefined {
  if (!agentId) return DEFAULT_ASSISTANT;
  if (agentId === DEFAULT_ASSISTANT_ID || agentId === DEFAULT_ASSISTANT.name) {
    return DEFAULT_ASSISTANT;
  }
  return soulLoader === undefined ? undefined : resolveAgentRef(soulLoader.agents, agentId);
}

/** The registry view contains only user-created Soul Agents. */
export function listAgents(soulLoader: SoulLoader | undefined): SoulAgent[] {
  return soulLoader ? Array.from(soulLoader.agents.values()) : [];
}

/**
 * Look up one user-created Soul Agent for the detail view, by id or by Soul name.
 *
 * The name is still what URLs and `@mentions` carry, so both must resolve; this is the edge that
 * turns either into the Agent whose permanent id everything downstream then uses.
 */
export function getAgent(soulLoader: SoulLoader | undefined, ref: string): SoulAgent | undefined {
  return soulLoader === undefined ? undefined : resolveAgentRef(soulLoader.agents, ref);
}
