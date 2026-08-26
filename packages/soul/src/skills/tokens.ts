import { expandSkillAuditTaxonomy } from "./audit-taxonomy";
import { expandForgeExecutionContract } from "./forge-execution-contract";

/**
 * Expand every token a bundled SKILL.md may carry, in one pass.
 *
 * Both places that read the shipped tree — the boot-time loader and the Soul seeder — go through
 * here, so a Skill cannot reach a model or the Soul repo with a raw token in it. Adding a token
 * means editing this function, which is the point: the alternative is remembering two call sites.
 */
export function expandBundledSkillTokens(content: string): string {
  return expandSkillAuditTaxonomy(expandForgeExecutionContract(content));
}
