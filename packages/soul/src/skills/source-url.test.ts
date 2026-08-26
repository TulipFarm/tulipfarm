import { describe, expect, it } from "vitest";
import { resolveSkillSource } from "./source-url";

describe("resolveSkillSource", () => {
  it("maps a skills.sh page onto the repository that backs it", () => {
    expect(resolveSkillSource("https://www.skills.sh/mattpocock/skills/grill-me")).toEqual({
      source: "https://github.com/mattpocock/skills.git",
      skillHint: "grill-me",
    });
  });

  it("accepts skills.sh without the www prefix and without a Skill segment", () => {
    expect(resolveSkillSource("https://skills.sh/anthropics/skills")).toEqual({
      source: "https://github.com/anthropics/skills.git",
      skillHint: undefined,
    });
  });

  it("maps a GitHub repository URL, with or without the .git suffix", () => {
    expect(resolveSkillSource("https://github.com/mattpocock/skills")).toEqual({
      source: "https://github.com/mattpocock/skills.git",
    });
    expect(resolveSkillSource("https://github.com/mattpocock/skills.git")).toEqual({
      source: "https://github.com/mattpocock/skills.git",
    });
  });

  it("takes the ref and the Skill directory from a tree URL", () => {
    expect(
      resolveSkillSource("https://github.com/mattpocock/skills/tree/main/packages/grill-me")
    ).toEqual({
      source: "https://github.com/mattpocock/skills.git#main",
      skillHint: "grill-me",
    });
  });

  it("names the parent package when a blob URL points at the SKILL.md itself", () => {
    expect(resolveSkillSource("https://github.com/o/r/blob/v2/skills/triage/SKILL.md")).toEqual({
      source: "https://github.com/o/r.git#v2",
      skillHint: "triage",
    });
  });

  it("lets an explicit ref suffix win over the one in the URL", () => {
    expect(resolveSkillSource("https://github.com/o/r/tree/main/skills/triage#release")).toEqual({
      source: "https://github.com/o/r.git#release",
      skillHint: "triage",
    });
  });

  it("passes a slug and an unrecognised host through for the clone gate to rule on", () => {
    expect(resolveSkillSource("mattpocock/skills")).toEqual({ source: "mattpocock/skills" });
    expect(resolveSkillSource("https://git.corp.example/team/skills.git")).toEqual({
      source: "https://git.corp.example/team/skills.git",
    });
  });

  it("refuses to rewrite a source whose owner or repo is not a plain segment", () => {
    // Without this the traversal would be laundered into a well-formed github.com URL.
    expect(resolveSkillSource("https://www.skills.sh/..%2F..%2Fetc/skills/x").source).toBe(
      "https://www.skills.sh/..%2F..%2Fetc/skills/x"
    );
  });

  it("leaves a non-https URL alone rather than upgrading it", () => {
    expect(resolveSkillSource("http://www.skills.sh/o/r/s")).toEqual({
      source: "http://www.skills.sh/o/r/s",
    });
  });
});
