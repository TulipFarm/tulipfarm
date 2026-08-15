import { describe, expect, it } from "vitest";
import type { SoulLoader } from "../published-loader";
import type { SoulSkill } from "../types";
import type { BundledSkill } from "./bundled";
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

function bundled(name: string, frontmatter: Record<string, unknown> = {}, body = ""): BundledSkill {
  return {
    name,
    frontmatter,
    body,
    category: "core",
    categoryDescription: "Core bundled Skills.",
    directory: `/bundled/core/${name}`,
    references: [],
  };
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

  it("sorts by name for a deterministic prompt-cache prefix", () => {
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

  it("merges bundled Skills and lets a Soul Skill override a name collision", () => {
    const bundledSkills = new Map([
      ["alpha", bundled("alpha", { name: "alpha", description: "Bundled." }, "bundled body")],
      ["beta", bundled("beta", { name: "beta", description: "Bundled beta." })],
    ]);
    const out = listAvailableSkills(
      makeSoulLoader([
        skill(
          "alpha",
          { name: "alpha", description: "Soul override.", category: "custom" },
          "soul body"
        ),
      ]),
      bundledSkills
    );

    expect(out).toEqual<AvailableSkill[]>([
      {
        name: "alpha",
        description: "Soul override.",
        category: "custom",
        categoryDescription: "",
      },
      {
        name: "beta",
        description: "Bundled beta.",
        category: "core",
        categoryDescription: "Core bundled Skills.",
      },
    ]);
  });

  it("filters disabled bundled names without hiding a Soul override", () => {
    const bundledSkills = new Map([
      ["alpha", bundled("alpha", { description: "Bundled alpha." })],
      ["beta", bundled("beta", { description: "Bundled beta." })],
    ]);
    const disabled = new Set(["alpha", "beta"]);

    expect(
      listAvailableSkills(
        makeSoulLoader([skill("alpha", { description: "Soul alpha." })]),
        bundledSkills,
        disabled
      )
    ).toEqual<AvailableSkill[]>([{ name: "alpha", description: "Soul alpha." }]);
  });

  it("keeps global name sorting stable across Soul and bundled inputs", () => {
    const out = listAvailableSkills(
      makeSoulLoader([skill("zebra"), skill("bravo")]),
      new Map([
        ["mango", bundled("mango")],
        ["alpha", bundled("alpha")],
      ])
    );
    expect(out.map((entry) => entry.name)).toEqual(["alpha", "bravo", "mango", "zebra"]);
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

  it("sorts by name for a deterministic prompt-cache prefix", () => {
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

  it("applies Soul precedence before eager filtering", () => {
    const bundledSkills = new Map([
      ["alpha", bundled("alpha", { eager: true }, "bundled eager")],
      ["beta", bundled("beta", { eager: true }, "bundled beta")],
    ]);
    const out = listEagerSkills(
      makeSoulLoader([skill("alpha", { eager: false }, "soul lazy")]),
      bundledSkills
    );

    expect(out).toEqual<EagerSkill[]>([{ name: "beta", body: "bundled beta" }]);
  });
});
