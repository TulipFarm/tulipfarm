import { deriveDefinitionId } from "../converters/shared";
import type { SoulAgent } from "../types";

/**
 * An Agent's permanent id.
 *
 * `frontmatter.id` is the authored value, minted once by `agent_create` and carried forward by
 * every later write. An Agent authored before that field existed has none, so the id is derived
 * from the name instead — which is exactly what every Agent identifier in the database already is,
 * so the fallback changes nothing while it lasts. The next write to that Agent persists the derived
 * value into its frontmatter, and from then on the id no longer follows the name.
 */
export function agentIdOf(name: string, frontmatter: Record<string, unknown>): string {
  const authored = frontmatter.id;
  return typeof authored === "string" && authored.length > 0
    ? authored
    : deriveDefinitionId("Agent", name);
}

/**
 * The Agent an external reference names, by id or by Soul slug.
 *
 * Both are accepted because the two identifiers coexist for as long as any stored reference
 * predates the id: URLs, @-mentions and delegation all still carry the name. The id is tried first
 * so a name that has since been taken by a *different* Agent cannot shadow the one actually meant.
 */
export function resolveAgentRef(
  agents: ReadonlyMap<string, SoulAgent>,
  ref: string
): SoulAgent | undefined {
  for (const agent of agents.values()) if (agent.id === ref) return agent;
  return agents.get(ref);
}
