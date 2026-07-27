import type { SoulAgent } from "@tulipfarm/soul";
import { type AssembleContext, assembleSystemPrompt } from "../context/assemble";
import type { PlatformAgent } from "../soul/agents/platform-agents";
import type { SoulCatalogue } from "../soul/catalogue";
import type { BundledSkill } from "../soul/skills/bundled";
import type { AvailableSkill } from "../soul/skills/registry";

/**
 * Assemble one agent's system prompt from already-fetched durable inputs. This is the single source
 * of truth for the per-agent prompt: the chat turn (`registerChatRoutes`) wraps it in a closure that
 * is reused for the front desk and each handoff target, and the dev-only debug-context route calls it
 * to surface the exact prompt the LLM receives. The caller fetches memory / governance / skills once
 * and passes them in — assembly itself performs no IO, mirroring `assembleSystemPrompt` (AC-V1-001).
 */
export function assembleAgentSystemPrompt(args: {
  agent: SoulAgent;
  platformAgent: PlatformAgent | undefined;
  business?: AssembleContext["business"];
  memory: AssembleContext["memory"];
  governancePages: AssembleContext["governancePages"];
  availableSkills: AvailableSkill[];
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  eagerSkills: AssembleContext["eagerSkills"];
  taggedResources: AssembleContext["taggedResources"];
  soulCatalogue: SoulCatalogue;
  availableTools: AssembleContext["availableTools"];
  pinnedKnowledge?: AssembleContext["pinnedKnowledge"];
  knowledgeGrounding?: boolean;
}): string {
  const {
    agent,
    platformAgent,
    business,
    memory,
    governancePages,
    availableSkills,
    bundledSkills,
    disabledBundledSkills,
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
    pinnedKnowledge,
    knowledgeGrounding,
  } = args;
  // Resolve platform forge Skills against the boot-cached bundled map. Registry output normally
  // already contains them; the name-keyed merge below prevents duplicates while preserving access
  // for callers that intentionally pass a narrower available-Skill list.
  const forgeAvailable = (platformAgent?.forgeSkills ?? [])
    .filter((name) => !disabledBundledSkills?.has(name))
    .map((name) => bundledSkills?.get(name))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((skill) => ({
      name: skill.name,
      description:
        typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : "",
      category: skill.category,
      categoryDescription: skill.categoryDescription,
    }));
  const mergedAvailable = new Map(availableSkills.map((skill) => [skill.name, skill]));
  for (const skill of forgeAvailable) {
    if (!mergedAvailable.has(skill.name)) mergedAvailable.set(skill.name, skill);
  }
  return assembleSystemPrompt({
    agentId: agent.name,
    domain: typeof agent.frontmatter.domain === "string" ? agent.frontmatter.domain : null,
    tenantId: "default",
    business,
    personality: agent.body,
    memory,
    governancePages,
    availableSkills: [...mergedAvailable.values()],
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
    pinnedKnowledge,
    knowledgeGrounding,
  });
}
