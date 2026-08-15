import { type AssembleContext, assembleSystemPrompt } from "@tulipfarm/agent-runtime";
import type {
  AvailableSkill,
  BundledSkill,
  PlatformAgent,
  SoulAgent,
  SoulCatalogue,
} from "@tulipfarm/soul";

export function assembleAgentSystemPrompt(args: {
  agent: SoulAgent;
  platformAgent: PlatformAgent | undefined;
  business?: AssembleContext["business"];
  customInstructions?: AssembleContext["customInstructions"];
  memory: AssembleContext["memory"];
  recalledMemory?: AssembleContext["recalledMemory"];
  governancePages: AssembleContext["governancePages"];
  availableSkills: AvailableSkill[];
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: ReadonlySet<string>;
  eagerSkills: AssembleContext["eagerSkills"];
  taggedResources: AssembleContext["taggedResources"];
  soulCatalogue: SoulCatalogue;
  availableTools: AssembleContext["availableTools"];
  surfaceCatalog?: string;
  pinnedKnowledge?: AssembleContext["pinnedKnowledge"];
  knowledgeGrounding?: boolean;
  temporal?: AssembleContext["temporal"];
}): string {
  const {
    agent,
    platformAgent,
    business,
    customInstructions,
    memory,
    recalledMemory,
    governancePages,
    availableSkills,
    bundledSkills,
    disabledBundledSkills,
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
    surfaceCatalog,
    pinnedKnowledge,
    knowledgeGrounding,
    temporal,
  } = args;
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
    customInstructions,
    memory,
    recalledMemory,
    governancePages,
    availableSkills: [...mergedAvailable.values()],
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
    surfaceCatalog,
    pinnedKnowledge,
    knowledgeGrounding,
    temporal,
  });
}
