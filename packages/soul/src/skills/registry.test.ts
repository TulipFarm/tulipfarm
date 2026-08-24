import { describe, expect, it } from "vitest";
import type { SoulLoader } from "../published-loader";
import type { SoulSkill } from "../types";
import type { BundledSkill } from "./bundled";
import { mergedSkills, resolveSkill } from "./registry";

function skill(name: string, frontmatter: Record<string, unknown> = {}, body = ""): SoulSkill {
  return { name, frontmatter, body };
}

function makeSoulLoader(skills: SoulSkill[] = []): SoulLoader {
  return { skills: new Map(skills.map((s) => [s.name, s])) } as unknown as SoulLoader;
}

function bundled(name: string, body = ""): BundledSkill {
  return {
    ...skill(name, {}, body),
    category: "core",
    categoryDescription: "Core",
    directory: `skills/core/${name}`,
    references: [],
  };
}

describe("mergedSkills", () => {
  it("lets a Soul Skill win over the bundled Skill of the same name", () => {
    const merged = mergedSkills(
      makeSoulLoader([skill("alpha", {}, "soul body")]),
      new Map([["alpha", bundled("alpha", "bundled body")]])
    );
    expect(merged.get("alpha")?.body).toBe("soul body");
  });

  it("drops a disabled bundled Skill", () => {
    const merged = mergedSkills(
      undefined,
      new Map([["alpha", bundled("alpha")]]),
      new Set(["alpha"])
    );
    expect(merged.has("alpha")).toBe(false);
  });

  it("keeps a Soul Skill whose name is a disabled bundled one, so a tombstone cannot bury it", () => {
    const merged = mergedSkills(
      makeSoulLoader([skill("alpha", {}, "soul body")]),
      new Map([["alpha", bundled("alpha")]]),
      new Set(["alpha"])
    );
    expect(merged.get("alpha")?.body).toBe("soul body");
  });

  it("is empty without a loader or bundled Skills", () => {
    expect(mergedSkills(undefined).size).toBe(0);
  });
});

describe("resolveSkill", () => {
  it("prefers the Soul Skill", () => {
    const found = resolveSkill(
      "alpha",
      makeSoulLoader([skill("alpha", {}, "soul body")]),
      new Map([["alpha", bundled("alpha", "bundled body")]])
    );
    expect(found?.body).toBe("soul body");
  });

  it("refuses a disabled bundled Skill", () => {
    expect(
      resolveSkill("alpha", undefined, new Map([["alpha", bundled("alpha")]]), new Set(["alpha"]))
    ).toBeUndefined();
  });

  it("returns undefined for a name nothing defines", () => {
    expect(resolveSkill("missing", makeSoulLoader([]))).toBeUndefined();
  });
});
