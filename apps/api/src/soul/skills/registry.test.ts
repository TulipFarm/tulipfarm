import type { SoulLoader, SoulSkill } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { type AvailableSkill, listAvailableSkills } from "./registry";

function skill(name: string, frontmatter: Record<string, unknown> = {}, body = ""): SoulSkill {
  return { name, frontmatter, body };
}

function makeSoulLoader(skills: SoulSkill[] = []): SoulLoader {
  return { skills: new Map(skills.map((s) => [s.name, s])) } as unknown as SoulLoader;
}

describe("listAvailableSkills", () => {
  it("projects each soul skill to its L1 name + description", () => {
    const out = listAvailableSkills(
      makeSoulLoader([skill("code-review", { description: "Review code for bugs." })])
    );
    expect(out).toEqual<AvailableSkill[]>([
      { name: "code-review", description: "Review code for bugs." },
    ]);
  });

  it("falls back to an empty description when frontmatter has none or it is not a string", () => {
    const out = listAvailableSkills(
      makeSoulLoader([skill("no-desc"), skill("bad-desc", { description: 42 })])
    );
    expect(out).toEqual<AvailableSkill[]>([
      { name: "bad-desc", description: "" },
      { name: "no-desc", description: "" },
    ]);
  });

  it("sorts by name for a deterministic prompt-cache prefix (AC-V1-001)", () => {
    const out = listAvailableSkills(
      makeSoulLoader([skill("zebra"), skill("alpha"), skill("mango")])
    );
    expect(out.map((s) => s.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("returns [] when the soul loader is absent", () => {
    expect(listAvailableSkills(undefined)).toEqual([]);
  });

  it("returns [] when there are no skills", () => {
    expect(listAvailableSkills(makeSoulLoader([]))).toEqual([]);
  });
});
