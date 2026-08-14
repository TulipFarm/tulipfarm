import type { SoulLoader } from "@tulipfarm/soul";
import { buildSteps, deriveSignals } from "./checklist";
import type { Suggestion } from "./suggestions";

/* Quest tiers: 1 = hardcoded gate (no LLM), 2 = deterministic checklist, 3 = AI profile gaps.
   Tier 2 and 3 stay locked until Tier 1 is fully answered. Tier 1 is only the provider key and
   the business name — the business description is asked right after the gate opens but does not
   block it, since nothing downstream strictly needs it to function (personalize.ts falls back to
   static suggestions when it is still empty). */

export type QuestAction =
  | { kind: "form"; field: "name" | "description" }
  | { kind: "link"; href: string }
  | { kind: "chat"; prompt: string };

export interface Quest {
  id: string;
  tier: 1 | 2 | 3;
  label: string;
  hint?: string;
  action: QuestAction;
}

export type SoulSlice = Pick<SoulLoader, "resources" | "skills" | "agents" | "integrations">;

export interface BuildQuestsInput {
  soul: SoulSlice;
  hasKnowledge: boolean;
  hasProviderKey: boolean;
  businessName?: string;
  businessDescription?: string;
  /** Tier 3 items, LLM-personalized when available; empty when there is nothing to unlock yet. */
  profileGaps?: Suggestion[];
  /** Quest ids the current user already dismissed — filtered out before returning. */
  dismissed: ReadonlySet<string>;
}

export const TIER1_PROVIDER_KEY = "provider-key";
export const TIER1_BUSINESS_NAME = "business-name";
export const TIER1_BUSINESS_DESCRIPTION = "business-description";

function tier1Quests(input: BuildQuestsInput): Quest[] {
  const quests: Quest[] = [];
  if (!input.hasProviderKey) {
    quests.push({
      id: TIER1_PROVIDER_KEY,
      tier: 1,
      label: "Plant your model key",
      hint: "Agents need one provider connected before they can do anything.",
      action: { kind: "link", href: "/settings/secrets" },
    });
  }
  if (!input.businessName) {
    quests.push({
      id: TIER1_BUSINESS_NAME,
      tier: 1,
      label: "What's your business called?",
      action: { kind: "form", field: "name" },
    });
  }
  return quests;
}

/* Not gating — asked right after Tier 1 opens, but skippable/dismissable like any other quest. */
function businessDescriptionQuest(businessDescription?: string): Quest[] {
  if (businessDescription) return [];
  return [
    {
      id: TIER1_BUSINESS_DESCRIPTION,
      tier: 2,
      label: "What does your business do?",
      hint: "Two or three sentences is plenty — every Agent reads this.",
      action: { kind: "form", field: "description" },
    },
  ];
}

function tier2Quests(soul: SoulSlice, hasKnowledge: boolean, businessName?: string): Quest[] {
  const signals = deriveSignals(soul, hasKnowledge, businessName);
  return buildSteps(signals)
    .filter((s): s is typeof s & { status: "todo"; prompt: string } => s.status === "todo")
    .map((s) => ({
      id: `checklist-${s.id}`,
      tier: 2 as const,
      label: s.label,
      action: { kind: "chat" as const, prompt: s.prompt },
    }));
}

function tier3Quests(profileGaps: Suggestion[]): Quest[] {
  return profileGaps.map((g) => ({
    id: `profile-${g.id}`,
    tier: 3 as const,
    label: g.label,
    action: { kind: "chat" as const, prompt: g.prompt },
  }));
}

export function buildQuests(input: BuildQuestsInput): Quest[] {
  const tier1 = tier1Quests(input);
  const gateOpen = tier1.length === 0;
  const all = gateOpen
    ? [
        ...businessDescriptionQuest(input.businessDescription),
        ...tier2Quests(input.soul, input.hasKnowledge, input.businessName),
        ...tier3Quests(input.profileGaps ?? []),
      ]
    : tier1;
  return all.filter((q) => !input.dismissed.has(q.id));
}
