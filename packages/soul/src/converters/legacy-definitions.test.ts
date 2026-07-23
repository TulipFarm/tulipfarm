import { describe, expect, it } from "vitest";
import type { SoulAgent, SoulSkill } from "../types";
import { convertLegacyDefinitions } from "./legacy-definitions";

describe("convertLegacyDefinitions (batch)", () => {
  it("aggregates files and warnings across agents and skills", () => {
    const agents: SoulAgent[] = [
      {
        name: "Support Bot",
        frontmatter: {
          owner: "team-support",
          modelProfile: "gpt-tier-1",
          autonomy: "propose_actions",
          trustTier: "business_authored",
        },
        body: "agent body",
      },
    ];
    const skills: SoulSkill[] = [
      {
        name: "PDF Summarizer",
        frontmatter: { trustTier: "first_party" },
        body: "skill body",
      },
    ];

    const result = convertLegacyDefinitions({ agents, skills });

    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "agents/support-bot/agent.yaml",
      "agents/support-bot/instructions.md",
      "skills/pdf-summarizer/SKILL.md",
      "skills/pdf-summarizer/skill.yaml",
    ]);
  });

  it("returns nothing for an empty batch", () => {
    expect(convertLegacyDefinitions({})).toEqual({ files: [], warnings: [] });
  });
});
