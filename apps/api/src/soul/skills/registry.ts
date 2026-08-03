import type { SoulLoader, SoulSkill } from "@tulipfarm/soul";
import type { BundledSkill } from "./bundled";

/**
 * One skill projected to its L1 surface — `name` + `description` — for the `<available-skills>`
 * prompt block. The body (L2) and reference files (L3) are
 * NOT included here; the agent pulls them on demand via the `load_skill` / `load_skill_reference`
 * platform tools. Skills with `eager: true` in frontmatter are excluded — they appear in `<skills>`
 * instead.
 */
export interface AvailableSkill {
  name: string;
  description: string;
  category?: string;
  categoryDescription?: string;
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
 * byte-stable prompt prefix.
 */
export function mergedSkills(
  soulLoader: SoulLoader | undefined,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
): Map<string, SoulSkill> {
  const merged = new Map<string, SoulSkill>();
  for (const [name, skill] of bundledSkills) {
    if (!disabledBundledSkills.has(name)) merged.set(name, skill);
  }
  if (soulLoader) {
    for (const [name, skill] of soulLoader.skills) merged.set(name, skill);
  }
  return merged;
}

export function resolveSkill(
  name: string,
  soulLoader: SoulLoader | undefined,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
) {
  return (
    soulLoader?.skills.get(name) ??
    (disabledBundledSkills.has(name) ? undefined : bundledSkills.get(name))
  );
}

export function listEagerSkills(
  soulLoader: SoulLoader | undefined,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
): EagerSkill[] {
  return Array.from(mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values())
    .filter((skill) => skill.frontmatter.eager === true && !skill.frontmatter._pendingAudit)
    .map((skill) => ({ name: skill.name, body: skill.body }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Projects non-eager skills into their lazy L1 surface for `<available-skills>`. Skills with
 * `eager: true` are excluded because they already appear in `<skills>`. Sorted by name.
 * `description` comes from frontmatter; missing or non-string renders as "".
 */
export function listAvailableSkills(
  soulLoader: SoulLoader | undefined,
  bundledSkills: ReadonlyMap<string, BundledSkill> = new Map(),
  disabledBundledSkills: ReadonlySet<string> = new Set()
): AvailableSkill[] {
  return Array.from(mergedSkills(soulLoader, bundledSkills, disabledBundledSkills).values())
    .filter((skill) => skill.frontmatter.eager !== true && !skill.frontmatter._pendingAudit)
    .map((skill) => {
      const bundled = bundledSkills.get(skill.name);
      return {
        name: skill.name,
        description:
          typeof skill.frontmatter.description === "string" ? skill.frontmatter.description : "",
        ...(bundled === skill
          ? {
              category: bundled.category,
              categoryDescription: bundled.categoryDescription,
            }
          : typeof skill.frontmatter.category === "string"
            ? {
                category: skill.frontmatter.category,
                categoryDescription:
                  [...bundledSkills.values()].find(
                    (candidate) => candidate.category === skill.frontmatter.category
                  )?.categoryDescription ?? "",
              }
            : {}),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
