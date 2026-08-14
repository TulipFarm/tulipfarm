import type { SoulLoader } from "@tulipfarm/soul";
import { evaluateRules } from "./rules";

/* Checklist status is derived from real Soul/Knowledge state; no stored checkmarks. */

export type StepStatus = "done" | "todo" | "coming-soon";

export interface ChecklistStep {
  /** Stable id used by the web for keys/icons. */
  id: "resource" | "skill" | "agent" | "knowledge" | "routine" | "integration";
  label: string;
  status: StepStatus;
  /** Present only on actionable (`todo`) steps — the message seeded into chat on tap. */
  prompt?: string;
}

export interface Recommendation {
  id: string;
  label: string;
  prompt: string;
}

export interface ChecklistState {
  steps: ChecklistStep[];
  recommendations: Recommendation[];
}

/** The minimal soul slice this module reads — keeps it stub-testable. */
export type SoulSlice = Pick<SoulLoader, "resources" | "skills" | "agents" | "integrations">;

export interface ChecklistSignals {
  hasResource: boolean;
  hasSkill: boolean;
  hasAgent: boolean;
  hasKnowledge: boolean;
  hasIntegration: boolean;
  /** First resource type name (sorted, for byte-stable recommendation text). */
  firstResourceName?: string;
  /** Business name from soul.yaml; interpolated into `todo` prompts when set. */
  businessName?: string;
}

export function deriveSignals(
  soul: SoulSlice,
  hasKnowledge: boolean,
  businessName?: string
): ChecklistSignals {
  const resourceNames = [...soul.resources.keys()].sort();
  return {
    hasResource: resourceNames.length > 0,
    hasSkill: soul.skills.size > 0,
    hasAgent: soul.agents.size > 0,
    hasKnowledge,
    hasIntegration: [...soul.integrations.values()].some((i) => i.connection?.enabled === true),
    firstResourceName: resourceNames[0],
    businessName,
  };
}

/** Build the six fixed steps; only `todo` steps carry prompts. */
export function buildSteps(sig: ChecklistSignals): ChecklistStep[] {
  const forBiz = sig.businessName ? ` for ${sig.businessName}` : "";
  const actionable = (
    id: ChecklistStep["id"],
    label: string,
    done: boolean,
    base: string
  ): ChecklistStep =>
    done
      ? { id, label, status: "done" }
      : { id, label, status: "todo", prompt: `${base}${forBiz}.` };

  return [
    actionable(
      "resource",
      "Create a resource type",
      sig.hasResource,
      "Help me create a resource type"
    ),
    actionable("skill", "Add a skill", sig.hasSkill, "Help me add a skill"),
    actionable("agent", "Create an agent", sig.hasAgent, "Help me create an agent"),
    actionable("knowledge", "Add knowledge", sig.hasKnowledge, "Help me add a knowledge page"),
    { id: "routine", label: "Set up a routine", status: "coming-soon" },
    actionable(
      "integration",
      "Connect an integration",
      sig.hasIntegration,
      "Help me connect an integration"
    ),
  ];
}

export function buildChecklist(
  soul: SoulSlice,
  hasKnowledge: boolean,
  businessName?: string
): ChecklistState {
  const sig = deriveSignals(soul, hasKnowledge, businessName);
  return { steps: buildSteps(sig), recommendations: evaluateRules(sig) };
}
