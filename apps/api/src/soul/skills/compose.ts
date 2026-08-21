import type { LlmService } from "@tulipfarm/llm";
import type { BundledSkill, GitSyncService, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { createSkillMarketplaceFlow } from "./routes";
import type { SkillToolContext } from "./tools";

export function composeSkillTools(
  gitSync: GitSyncService,
  soulWriter: SoulWriter,
  soulLoader: SoulLoader,
  llmService: LlmService,
  bundledSkills: ReadonlyMap<string, BundledSkill>,
  disabledBundledSkills: Set<string>
) {
  const marketplace = createSkillMarketplaceFlow({
    gitSync,
    soulWriter,
    soulLoader,
    llmService,
    bundledSkills,
    disabledBundledSkills,
  });
  const skillTools: SkillToolContext = {
    gitSync,
    soulWriter,
    soulLoader,
    llmService,
    bundledSkills,
    disabledBundledSkills,
    marketplace,
  };
  return { marketplace, skillTools };
}
