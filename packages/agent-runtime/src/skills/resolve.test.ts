import { describe, expect, it } from "vitest";
import {
  type ResolvableSkill,
  resolveSkills,
  type SkillCatalog,
  type SkillTrustPolicy,
} from "./resolve";

function skill(overrides: Partial<ResolvableSkill> = {}): ResolvableSkill {
  return {
    skillId: "triage",
    version: "1.0.0",
    digest: "sha256:triage-1",
    trustTier: "first_party",
    scan: { status: "clean", scannedDigest: "sha256:triage-1" },
    dependencies: [],
    requiredToolAbilities: ["github.issue.read"],
    contextTokens: 100,
    ...overrides,
  };
}

function catalog(...skills: readonly ResolvableSkill[]): SkillCatalog {
  const byRef = new Map(skills.map((entry) => [`${entry.skillId}@${entry.version}`, entry]));
  return { get: (skillId, version) => byRef.get(`${skillId}@${version}`) };
}

const trustPolicy: SkillTrustPolicy = {
  allowedTiers: ["first_party", "business_authored"],
  requireScanForTiers: ["business_authored", "third_party"],
};

const base = {
  trustPolicy,
  grantedToolAbilities: ["github.issue.read", "github.issue.comment"],
  contextBudgetTokens: 1_000,
};

describe("resolveSkills", () => {
  it("resolves multiple selections with exact versions, reasons, and context budget", () => {
    const resolution = resolveSkills({
      ...base,
      selections: [
        { skillId: "triage", version: "1.0.0" },
        { skillId: "reply", version: "2.1.0" },
      ],
      catalog: catalog(skill(), skill({ skillId: "reply", version: "2.1.0", contextTokens: 50 })),
    });

    if (resolution.outcome !== "resolved") throw new Error(resolution.reason);
    expect(
      resolution.skills.map((entry) => [entry.skillId, entry.version, entry.selectionReason])
    ).toEqual([
      ["triage", "1.0.0", "requested"],
      ["reply", "2.1.0", "requested"],
    ]);
    expect(resolution.contextTokens).toBe(150);
  });

  it("resolves exact dependency versions and records why each was selected", () => {
    const resolution = resolveSkills({
      ...base,
      selections: [{ skillId: "triage", version: "1.0.0" }],
      catalog: catalog(
        skill({ dependencies: [{ skillId: "shared", version: "0.3.0" }] }),
        skill({ skillId: "shared", version: "0.3.0", requiredToolAbilities: [] })
      ),
    });

    if (resolution.outcome !== "resolved") throw new Error(resolution.reason);
    expect(resolution.skills.map((entry) => [entry.skillId, entry.selectionReason])).toEqual([
      ["triage", "requested"],
      ["shared", "dependency"],
    ]);
    expect(resolution.skills[1]?.requiredBy).toEqual(["triage@1.0.0"]);
  });

  it("denies an unpublished Skill version rather than resolving a nearby one", () => {
    expect(
      resolveSkills({
        ...base,
        selections: [{ skillId: "triage", version: "9.9.9" }],
        catalog: catalog(skill()),
      })
    ).toMatchObject({ outcome: "denied", reason: "unknown_skill", skillRef: "triage@9.9.9" });
  });

  it("reports a conflict when two versions of one Skill are pulled in", () => {
    const resolution = resolveSkills({
      ...base,
      selections: [
        { skillId: "triage", version: "1.0.0" },
        { skillId: "reply", version: "2.1.0" },
      ],
      catalog: catalog(
        skill(),
        skill({
          skillId: "reply",
          version: "2.1.0",
          dependencies: [{ skillId: "triage", version: "1.1.0" }],
          requiredToolAbilities: [],
        }),
        skill({ version: "1.1.0", digest: "sha256:triage-2" })
      ),
    });

    expect(resolution).toMatchObject({
      outcome: "denied",
      reason: "version_conflict",
      skillRef: "triage@1.1.0",
    });
  });

  it("stops a dependency cycle instead of looping", () => {
    const resolution = resolveSkills({
      ...base,
      selections: [{ skillId: "triage", version: "1.0.0" }],
      catalog: catalog(
        skill({ dependencies: [{ skillId: "shared", version: "0.3.0" }] }),
        skill({
          skillId: "shared",
          version: "0.3.0",
          dependencies: [{ skillId: "triage", version: "1.0.0" }],
          requiredToolAbilities: [],
        })
      ),
    });

    if (resolution.outcome !== "resolved") throw new Error(resolution.reason);
    expect(resolution.skills).toHaveLength(2);
  });

  it("denies a trust tier the Guardrail does not allow", () => {
    expect(
      resolveSkills({
        ...base,
        selections: [{ skillId: "triage", version: "1.0.0" }],
        catalog: catalog(skill({ trustTier: "third_party" })),
      })
    ).toMatchObject({ outcome: "denied", reason: "trust_tier_forbidden" });
  });

  it("denies a scannable tier whose executable content has not passed scanning", () => {
    expect(
      resolveSkills({
        ...base,
        selections: [{ skillId: "triage", version: "1.0.0" }],
        catalog: catalog(skill({ trustTier: "business_authored", scan: { status: "pending" } })),
      })
    ).toMatchObject({ outcome: "denied", reason: "scan_required" });
  });

  it("denies when the scanned digest no longer matches the published content", () => {
    expect(
      resolveSkills({
        ...base,
        selections: [{ skillId: "triage", version: "1.0.0" }],
        catalog: catalog(
          skill({
            trustTier: "business_authored",
            scan: { status: "clean", scannedDigest: "sha256:stale" },
          })
        ),
      })
    ).toMatchObject({ outcome: "denied", reason: "scan_required" });
  });

  it("denies a Skill preflight that needs an ability the caller does not already hold", () => {
    expect(
      resolveSkills({
        ...base,
        selections: [{ skillId: "triage", version: "1.0.0" }],
        catalog: catalog(skill({ requiredToolAbilities: ["github.repo.delete"] })),
      })
    ).toMatchObject({
      outcome: "denied",
      reason: "missing_tool_ability",
      detail: "github.repo.delete",
    });
  });

  it("never widens abilities beyond what the caller already holds", () => {
    const resolution = resolveSkills({
      ...base,
      grantedToolAbilities: ["github.issue.read", "github.issue.comment"],
      selections: [{ skillId: "triage", version: "1.0.0" }],
      catalog: catalog(skill({ requiredToolAbilities: ["github.issue.read"] })),
    });

    if (resolution.outcome !== "resolved") throw new Error(resolution.reason);
    expect(resolution.abilities).toEqual(["github.issue.read"]);
    expect(resolution).not.toHaveProperty("grants");
  });

  it("denies when resolved Skills exceed the Context budget", () => {
    expect(
      resolveSkills({
        ...base,
        contextBudgetTokens: 120,
        selections: [
          { skillId: "triage", version: "1.0.0" },
          { skillId: "reply", version: "2.1.0" },
        ],
        catalog: catalog(
          skill(),
          skill({ skillId: "reply", version: "2.1.0", requiredToolAbilities: [] })
        ),
      })
    ).toMatchObject({ outcome: "denied", reason: "context_budget_exceeded" });
  });
});
