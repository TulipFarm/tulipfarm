import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoDir } from "../repo-dir";
import { SKILL_AUDIT_TAXONOMY, SKILL_AUDIT_TAXONOMY_TOKEN } from "./audit-taxonomy";
import { expandBundledSkillTokens } from "./tokens";

const SKILL_PATH = join(repoDir("skills"), "forge", "skill-forge", "SKILL.md");

/**
 * The rubric ships in two places and must be one thing.
 *
 * `skill_audit` imports {@link SKILL_AUDIT_TAXONOMY} into its system prompt, which is what gates
 * every create and install; `skill-forge` carries the token and is expanded from the same constant
 * at boot. If these drift, the forge authors Skills against rules the guard does not enforce.
 */
describe("skill audit taxonomy", () => {
  it("is carried by skill-forge as a token, not a copy", async () => {
    const content = await readFile(SKILL_PATH, "utf8");
    expect(content).toContain(SKILL_AUDIT_TAXONOMY_TOKEN);
    // A pasted copy would satisfy the expansion test below while drifting freely afterwards.
    expect(content).not.toContain(SKILL_AUDIT_TAXONOMY);
  });

  it("expands into skill-forge, leaving no raw token", async () => {
    const expanded = expandBundledSkillTokens(await readFile(SKILL_PATH, "utf8"));
    expect(expanded).toContain(SKILL_AUDIT_TAXONOMY);
    expect(expanded).not.toContain(SKILL_AUDIT_TAXONOMY_TOKEN);
    expect(expanded).not.toContain("{{FORGE_EXECUTION_CONTRACT}}");
  });

  it("names every family the audit claims to cover", () => {
    for (const family of [
      "Frontmatter and honesty",
      "Dependency management",
      "Dynamic content loading",
      "Ingestion surfaces and indirect prompt injection",
      "Boundary markers",
      "Sanitization",
      "Credential management",
      "Exfiltration",
      "Obfuscation and hidden code",
      "Tool and trust exploitation",
      "Excessive autonomy",
      "Reconnaissance",
      "Resource use",
      "Harmful capability",
    ]) {
      expect(SKILL_AUDIT_TAXONOMY).toContain(family);
    }
  });

  it("carries the two rules that override the severity rubric", () => {
    expect(SKILL_AUDIT_TAXONOMY).toContain("Concealment is intent");
    expect(SKILL_AUDIT_TAXONOMY).toContain("silence is not safety");
  });
});
