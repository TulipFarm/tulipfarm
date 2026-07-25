import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, FORGE_SKILL_NAMES } from "./builtin-skills";

describe("builtin forge skills", () => {
  it("carries the execution contract through every creation workflow", () => {
    for (const name of FORGE_SKILL_NAMES) {
      const skill = BUILTIN_SKILLS.get(name);
      expect(skill?.body).toContain("## Execution Contract");
      expect(skill?.body).toContain("Do not stop at a plan, draft, or preview.");
      expect(skill?.body).toContain("Verify it with the relevant read");
      expect(skill?.body).toContain("specific blocker; never claim");
      expect(skill?.body).toContain("inspect before changing");
    }
  });
});
