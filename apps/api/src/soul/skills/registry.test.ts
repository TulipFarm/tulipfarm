import type { SoulLoader, SoulSkill } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  type AvailableSkill,
  type EagerSkill,
  listAvailableSkills,
  listEagerSkills,
} from "./registry";

function skill(name: string, frontmatter: Record<string, unknown> = {}, body = ""): SoulSkill {
  return { name, frontmatter, body };
}

function makeSoulLoader(skills: SoulSkill[] = []): SoulLoader {
  return { skills: new Map(skills.map((s) => [s.name, s])) } as unknown as SoulLoader;
}

describe("listAvailableSkills", () => {
  it("projects each non-eager soul skill to its L1 name + description", () => {
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

  it("excludes skills with eager: true (they appear in <skills> instead)", () => {
    const out = listAvailableSkills(
      makeSoulLoader([
        skill("lazy-skill", { description: "Lazy." }),
        skill("eager-skill", { eager: true, description: "Eager." }),
      ])
    );
    expect(out).toEqual<AvailableSkill[]>([{ name: "lazy-skill", description: "Lazy." }]);
  });

  it("excludes skills with _pendingAudit: true (not yet activated by operator)", () => {
    const out = listAvailableSkills(
      makeSoulLoader([
        skill("active-skill", { description: "Active." }),
        skill("pending-skill", { _pendingAudit: true, description: "Pending." }),
      ])
    );
    expect(out).toEqual<AvailableSkill[]>([{ name: "active-skill", description: "Active." }]);
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

describe("listEagerSkills", () => {
  it("returns only skills with eager: true, projecting name + body", () => {
    const out = listEagerSkills(
      makeSoulLoader([
        skill("lazy", { description: "I'm lazy." }, "lazy body"),
        skill("alpha-eager", { eager: true }, "eager body"),
      ])
    );
    expect(out).toEqual<EagerSkill[]>([{ name: "alpha-eager", body: "eager body" }]);
  });

  it("sorts by name for a deterministic prompt-cache prefix (AC-V1-001)", () => {
    const out = listEagerSkills(
      makeSoulLoader([
        skill("zebra", { eager: true }, "z"),
        skill("alpha", { eager: true }, "a"),
        skill("mango", { eager: true }, "m"),
      ])
    );
    expect(out.map((s) => s.name)).toEqual(["alpha", "mango", "zebra"]);
  });

  it("returns [] when no skills are eager", () => {
    expect(listEagerSkills(makeSoulLoader([skill("lazy", { description: "x" })]))).toEqual([]);
  });

  it("excludes eager skills with _pendingAudit: true", () => {
    const out = listEagerSkills(
      makeSoulLoader([
        skill("active-eager", { eager: true }, "active body"),
        skill("pending-eager", { eager: true, _pendingAudit: true }, "pending body"),
      ])
    );
    expect(out).toEqual<EagerSkill[]>([{ name: "active-eager", body: "active body" }]);
  });

  it("returns [] when the soul loader is absent", () => {
    expect(listEagerSkills(undefined)).toEqual([]);
  });

  it("returns [] when there are no skills", () => {
    expect(listEagerSkills(makeSoulLoader([]))).toEqual([]);
  });
});
