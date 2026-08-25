import { describe, expect, it } from "vitest";
import type { SoulAgent } from "../types";
import { convertLegacyDefinitions } from "./legacy-definitions";

describe("convertLegacyDefinitions (batch)", () => {
  it("aggregates files and warnings across agents", () => {
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
    const result = convertLegacyDefinitions({ agents });

    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "agents/support-bot/agent.yaml",
      "agents/support-bot/instructions.md",
    ]);
  });

  it("returns nothing for an empty batch", () => {
    expect(convertLegacyDefinitions({})).toEqual({ files: [], warnings: [] });
  });
});
