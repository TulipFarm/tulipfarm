import type { SoulLoader } from "@tulipfarm/soul";
import { evaluateRules } from "./rules";

/*
 * Pure derivation for the "Getting started" onboarding checklist (ONBOARDING ONB-V1). The checklist
 * surface shows the core build blocks a fresh instance should create, with each step's done-state
 * derived from REAL soul/knowledge state (never a stored checkmark) so it can never desync. Routines
 * and integrations have no build flow yet, so they render "coming-soon" (non-actionable). The
 * contextual "recommended next" items come from the deterministic rule set in ./rules.
 *
 * Typed against a minimal soul slice (resources/skills/agents maps) so it is trivially testable with
 * a stub — mirrors suggestions.ts. The built-in platform assistant
 * live in listAgents(), NOT in soulLoader.agents, so `agents.size > 0` correctly counts only
 * user-created soul agents.
 */

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
export type SoulSlice = Pick<SoulLoader, "resources" | "skills" | "agents">;

export interface ChecklistSignals {
  hasResource: boolean;
  hasSkill: boolean;
  hasAgent: boolean;
  hasKnowledge: boolean;
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
    firstResourceName: resourceNames[0],
    businessName,
  };
}

/**
 * Build the six core steps in fixed order. `todo` steps carry the prompt; done/coming-soon do not.
 * Prompt text is `${base}${forBiz}.` — the trailing period is added here so the base strings stay
 * suffix-free and the no-businessName output is byte-identical to the original generic prompts.
 */
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
    { id: "integration", label: "Connect an integration", status: "coming-soon" },
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
