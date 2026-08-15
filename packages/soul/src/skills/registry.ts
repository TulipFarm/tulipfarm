import type { SoulLoader } from "../published-loader";
import type { SoulSkill } from "../types";
import type { BundledSkill } from "./bundled";

/** Lazy L1 Skill projection for the `<available-skills>` prompt block. */
export interface AvailableSkill {
  name: string;
  description: string;
  category?: string;
  categoryDescription?: string;
}

/** Eager Skill projection for the `<skills>` prompt block. */
export interface EagerSkill {
  name: string;
  body: string;
}

/** Projects eager Skills sorted by name for byte-stable prompts. */
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

/** Projects non-eager Skills to the lazy L1 surface. */
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
