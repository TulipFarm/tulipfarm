import type { SoulLoader } from "@tulipfarm/soul";

/**
 * One skill projected to its L1 surface — `name` + `description` — for the `<available-skills>`
 * prompt block (specs/CONTEXT-ENGINE.md §1, SKILLS.md). The body (L2) and reference files (L3) are
 * NOT included here; the agent pulls them on demand via the `load_skill` / `load_skill_reference`
 * platform tools. Skills with `eager: true` in frontmatter are excluded — they appear in `<skills>`
 * instead.
 */
export interface AvailableSkill {
  name: string;
  description: string;
}

/**
 * One skill projected to its eager surface — `name` + `body` — for the `<skills>` prompt block.
 * A skill opts in by setting `eager: true` in its SKILL.md frontmatter; the full body is included
 * so the agent can apply it without a `load_skill` call.
 */
export interface EagerSkill {
  name: string;
  body: string;
}

/**
 * Projects skills with `eager: true` frontmatter into the eager surface. Sorted by name for a
 * byte-stable prompt prefix (AC-V1-001).
 */
export function listEagerSkills(soulLoader: SoulLoader | undefined): EagerSkill[] {
  if (!soulLoader) return [];
  return Array.from(soulLoader.skills.values())
    .filter((skill) => skill.frontmatter.eager === true && !skill.frontmatter._pendingAudit)
    .map((skill) => ({ name: skill.name, body: skill.body }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Projects non-eager skills into their lazy L1 surface for `<available-skills>`. Skills with
 * `eager: true` are excluded because they already appear in `<skills>`. Sorted by name
 * (AC-V1-001). `description` comes from frontmatter; missing or non-string renders as "".
 */
export function listAvailableSkills(soulLoader: SoulLoader | undefined): AvailableSkill[] {
  if (!soulLoader) return [];
  return Array.from(soulLoader.skills.values())
    .filter((skill) => skill.frontmatter.eager !== true && !skill.frontmatter._pendingAudit)
    .map((skill) => ({
      name: skill.name,
      description:
        typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : "",
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
