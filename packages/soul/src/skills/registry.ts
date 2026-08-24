import type { SoulLoader } from "../published-loader";
import type { SoulSkill } from "../types";
import type { BundledSkill } from "./bundled";

/** Soul Skills over bundled ones, minus any the caller hides. */
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
