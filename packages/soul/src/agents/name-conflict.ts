import type { SoulAgent } from "../types";

/** What the caller decided about an Agent that already occupies the requested name. */
export const AGENT_EXISTING_DECISIONS = ["keep", "update"] as const;
export type AgentExistingDecision = (typeof AGENT_EXISTING_DECISIONS)[number];

/** What `agent_create` should do, once the Soul has been consulted. */
export type AgentNamePlan =
  | { readonly outcome: "create" }
  | { readonly outcome: "keep"; readonly agent: SoulAgent }
  | { readonly outcome: "replace"; readonly agent: SoulAgent }
  | { readonly outcome: "refuse"; readonly message: string };

function labelKey(frontmatter: Record<string, unknown> | undefined): string | undefined {
  const label = frontmatter?.label;
  if (typeof label !== "string") return undefined;
  const key = label.trim().toLowerCase();
  return key.length === 0 ? undefined : key;
}

/**
 * The Agent already answering to this name, by Soul slug or by display label.
 *
 * The write gateway guards only the slug, so two Agents sharing a `label` — the name @-mention,
 * delegation and every list render on — are indistinguishable to a human while being perfectly
 * legal on disk. Both have to be checked, and before the write, or the Tool has nothing to offer.
 */
function occupant(
  agents: ReadonlyMap<string, SoulAgent>,
  name: string,
  frontmatter: Record<string, unknown> | undefined
): { agent: SoulAgent; kind: "slug" | "label" } | undefined {
  const bySlug = agents.get(name);
  if (bySlug) return { agent: bySlug, kind: "slug" };
  const wanted = labelKey(frontmatter);
  if (wanted === undefined) return undefined;
  for (const agent of agents.values())
    if (labelKey(agent.frontmatter) === wanted) return { agent, kind: "label" };
  return undefined;
}

/**
 * Decide the name collision before anything is written.
 *
 * `decision` is where the user's answer lands. Without somewhere to put it the Tool can only refuse
 * again, so the answer gets narrated back and the next Turn re-derives the same clarification from
 * the same Tool result — reworded each time, because it is regenerated rather than replayed.
 */
export function resolveAgentName(
  agents: ReadonlyMap<string, SoulAgent>,
  name: string,
  frontmatter: Record<string, unknown> | undefined,
  decision: AgentExistingDecision | undefined
): AgentNamePlan {
  const taken = occupant(agents, name, frontmatter);
  if (taken === undefined) return { outcome: "create" };
  if (decision === "keep") return { outcome: "keep", agent: taken.agent };
  if (decision === "update") return { outcome: "replace", agent: taken.agent };
  const collision =
    taken.kind === "slug"
      ? `Agent "${taken.agent.name}" already exists`
      : `Agent "${taken.agent.name}" already uses that label`;
  return {
    outcome: "refuse",
    message:
      `${collision}, so creating "${name}" would leave two Agents users cannot tell apart. Ask ` +
      `the user once, then re-call agent_create with onExisting="keep" to leave ` +
      `"${taken.agent.name}" exactly as it is, or onExisting="update" to replace its body and ` +
      "frontmatter. Choose a different name and label to have both.",
  };
}
