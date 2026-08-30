import { describe, expect, test } from "vitest";
import {
  formatBytes,
  groupByCategory,
  groupPackageFiles,
  isReadableSkillFile,
  matchesSkillQuery,
  shouldGroupByCategory,
  skillFacts,
  skillFileKind,
  UNCATEGORISED,
} from "~/lib/skill-facts";
import type { SkillSummary } from "~/lib/skills";

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: "demo",
    description: "A demo skill.",
    provenance: "local",
    ...overrides,
  } as SkillSummary;
}

describe("skillFacts", () => {
  // The reach scale is a ladder, not a set: a Skill leasing a secret also reaches the network, so
  // the badge has to name the furthest rung rather than the first one that matched.
  test("reach names the furthest rung the Skill reaches", () => {
    expect(skillFacts(skill()).reach).toBe("instructions-only");
    expect(skillFacts(skill({ allowedCommands: ["rg"] })).reach).toBe("runs-code");
    expect(skillFacts(skill({ allowedDomains: ["api.slack.com"] })).reach).toBe("reaches-network");
    expect(
      skillFacts(skill({ allowedDomains: ["api.slack.com"], allowedCommands: ["curl"] })).reach
    ).toBe("reaches-network");
    expect(
      skillFacts(
        skill({
          requiredSecrets: ["SLACK_TOKEN"],
          allowedDomains: ["api.slack.com"],
          allowedCommands: ["curl"],
        })
      ).reach
    ).toBe("needs-secrets");
  });

  test("a single host is named, several are counted", () => {
    expect(skillFacts(skill({ allowedDomains: ["skills.sh"] })).headline).toBe(
      "Can reach skills.sh."
    );
    expect(
      skillFacts(skill({ allowedDomains: ["skills.sh", "raw.githubusercontent.com"] })).headline
    ).toBe("Can reach 2 hosts.");
  });

  // Tools alone must not move the reach: a Skill listing `read_file` runs under the authority of
  // whichever agent loaded it and widens nothing. Reading that as "runs code" would overstate it.
  test("declared tools do not raise reach, but do count as declaring something", () => {
    const facts = skillFacts(skill({ tools: ["read_file", "grep"] }));
    expect(facts.reach).toBe("instructions-only");
    expect(facts.declaresNothing).toBe(false);
    expect(facts.tools).toEqual(["read_file", "grep"]);
  });

  test("a Skill that declares nothing says so and still answers every field", () => {
    const facts = skillFacts(skill());
    expect(facts.declaresNothing).toBe(true);
    expect(facts.headline).toBe("Nothing but instructions for the agent that loads it.");
    expect([facts.tools, facts.domains, facts.commands, facts.secrets]).toEqual([[], [], [], []]);
  });

  test("returned lists are copies, so a caller sorting them cannot mutate the Skill", () => {
    const tools = ["b", "a"];
    const facts = skillFacts(skill({ tools }));
    facts.tools.sort();
    expect(tools).toEqual(["b", "a"]);
  });
});

describe("groupByCategory", () => {
  test("uncategorised sorts last however it collates", () => {
    const groups = groupByCategory([
      skill({ name: "one" }),
      skill({ name: "two", category: "writing" }),
      skill({ name: "three", category: "automation" }),
    ]);
    expect(groups.map(([category]) => category)).toEqual(["automation", "writing", UNCATEGORISED]);
  });

  test("members are sorted by name within a group", () => {
    const groups = groupByCategory([
      skill({ name: "zeta", category: "writing" }),
      skill({ name: "alpha", category: "writing" }),
    ]);
    expect(groups[0][1].map((member) => member.name)).toEqual(["alpha", "zeta"]);
  });

  test("headings are only worth rendering once they separate something", () => {
    expect(shouldGroupByCategory(groupByCategory([skill({ category: "writing" })]))).toBe(false);
    expect(
      shouldGroupByCategory(
        groupByCategory([skill({ name: "a", category: "writing" }), skill({ name: "b" })])
      )
    ).toBe(true);
  });
});

describe("matchesSkillQuery", () => {
  // "Which of my Skills touch Slack" is asked by typing `slack`. A name-and-description search
  // answers it wrongly for a Skill whose prose never mentions Slack but whose tools do.
  test("matches a tool name and a host, not only the name and description", () => {
    const slack = skill({
      name: "standup",
      description: "Posts the daily update.",
      tools: ["slack_post_message"],
      allowedDomains: ["api.slack.com"],
    });
    expect(matchesSkillQuery(slack, "slack")).toBe(true);
    expect(matchesSkillQuery(slack, "api.slack.com")).toBe(true);
    expect(matchesSkillQuery(slack, "jira")).toBe(false);
  });

  test("matching is case- and whitespace-insensitive, and an empty query matches everything", () => {
    expect(matchesSkillQuery(skill({ name: "Standup" }), "  STAND ")).toBe(true);
    expect(matchesSkillQuery(skill(), "   ")).toBe(true);
  });
});

describe("skillFileKind", () => {
  test("classifies by role, with SKILL.md the manifest rather than another reference", () => {
    expect(skillFileKind("SKILL.md")).toBe("manifest");
    expect(skillFileKind("references/authoring-a-skill.md")).toBe("reference");
    expect(skillFileKind("NOTES.md")).toBe("reference");
    expect(skillFileKind("scripts/sync.sh")).toBe("script");
    expect(skillFileKind("scripts/sync.py")).toBe("script");
    expect(skillFileKind("assets/logo.png")).toBe("asset");
    expect(skillFileKind("Makefile")).toBe("asset");
  });

  // A .md under references/ is a reference, but so is a .py under references/ a script: what the
  // file *is* outranks where it sits, because the risk question is "does this execute".
  test("an executable under references/ is still a script", () => {
    expect(skillFileKind("references/helper.py")).toBe("script");
  });
});

describe("isReadableSkillFile", () => {
  test("offers text and scripts, refuses binaries and extensionless files", () => {
    expect(isReadableSkillFile("references/guide.md")).toBe(true);
    expect(isReadableSkillFile("scripts/sync.sh")).toBe(true);
    expect(isReadableSkillFile("config.yaml")).toBe(true);
    expect(isReadableSkillFile("assets/logo.png")).toBe(false);
    expect(isReadableSkillFile("LICENSE")).toBe(false);
  });
});

describe("groupPackageFiles", () => {
  test("returns kinds in reading order, drops empty kinds and sorts within a kind", () => {
    const groups = groupPackageFiles([
      { path: "assets/logo.png", size: 10 },
      { path: "references/zeta.md", size: 10 },
      { path: "references/alpha.md", size: 10 },
      { path: "SKILL.md", size: 10 },
    ]);
    expect(groups.map(([kind]) => kind)).toEqual(["manifest", "reference", "asset"]);
    expect(groups[1][1].map((file) => file.path)).toEqual([
      "references/alpha.md",
      "references/zeta.md",
    ]);
  });
});

describe("formatBytes", () => {
  test("reads as a size rather than a raw integer, keeping a digit only where it informs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4601)).toBe("4.5 KB");
    expect(formatBytes(102400)).toBe("100 KB");
    expect(formatBytes(1572864)).toBe("1.5 MB");
  });
});
