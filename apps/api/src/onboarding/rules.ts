import type { ChecklistSignals, Recommendation } from "./checklist";

/* Deterministic, no-LLM onboarding recommendations; adding a rule is one array entry. */

interface Rule {
  id: string;
  /** True when this recommendation should surface for the given signals. */
  when: (s: ChecklistSignals) => boolean;
  /** Build the user-facing label + seeded prompt (may name a resource type). */
  build: (s: ChecklistSignals) => { label: string; prompt: string };
}

export const RULES: Rule[] = [
  {
    // A resource type exists but no agent works it — recommend an agent for it.
    id: "agent-for-resource",
    when: (s) => s.hasResource && !s.hasAgent,
    build: (s) => ({
      label: `Create an agent for "${s.firstResourceName}"`,
      prompt: `Help me create an agent to manage my ${s.firstResourceName} resource.`,
    }),
  },
  {
    // An agent exists but has no reference material — recommend knowledge.
    id: "knowledge-for-agent",
    when: (s) => s.hasAgent && !s.hasKnowledge,
    build: () => ({
      label: "Add a knowledge page for your agent",
      prompt: "Help me add a knowledge page so my agent has reference material.",
    }),
  },
  {
    // An agent exists but no skill — recommend a skill to extend it.
    id: "skill-after-agent",
    when: (s) => s.hasAgent && !s.hasSkill,
    build: () => ({
      label: "Add a skill to extend your agent",
      prompt: "Help me add a skill my agent can use.",
    }),
  },
];

export function evaluateRules(s: ChecklistSignals): Recommendation[] {
  return RULES.filter((r) => r.when(s)).map((r) => ({ id: r.id, ...r.build(s) }));
}
