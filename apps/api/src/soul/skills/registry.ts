import type { SoulLoader } from "@tulipfarm/soul";

/**
 * One skill projected to its L1 surface — `name` + `description` — for the `<available-skills>`
 * prompt block (specs/CONTEXT-ENGINE.md §1, SKILLS.md). The body (L2) and reference files (L3) are
 * NOT included here; the agent pulls them on demand via the `load_skill` / `load_skill_reference`
 * platform tools.
 */
export interface AvailableSkill {
  name: string;
  description: string;
}

/**
 * The SkillRegistry (Skills milestone). Projects every soul skill into its lazy L1 surface for the
 * `<available-skills>` block. V1 is shared + lazy only: no per-agent filtering (flat ALLOW_ALL —
 * there is no skill-level ACL in V1, GAP-SKL-001) and no eager `<skills>` election (deferred).
 *
 * Sorted by name so the assembled prompt prefix is byte-stable across restarts — `SoulLoader.skills`
 * is keyed in OS `readdir` order, which sorting normalizes (AC-V1-001). `description` comes from the
 * SKILL.md frontmatter; a missing or non-string value renders as an empty description.
 */
export function listAvailableSkills(soulLoader: SoulLoader | undefined): AvailableSkill[] {
  if (!soulLoader) return [];
  return Array.from(soulLoader.skills.values())
    .map((skill) => ({
      name: skill.name,
      description:
        typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : "",
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
