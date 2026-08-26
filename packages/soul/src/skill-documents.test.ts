import { describe, expect, it } from "vitest";
import { skillDocumentFromMarkdown } from "./skill-documents";

function markdown(frontmatter: string, body = "Do the thing.\n"): string {
  return `---\n${frontmatter}---\n${body}`;
}

describe("skillDocumentFromMarkdown", () => {
  it("projects a canonical Skill definition from SKILL.md frontmatter", () => {
    const document = skillDocumentFromMarkdown(
      "packing",
      markdown("name: packing\ndescription: Packs bulbs.\ntrustTier: first_party\n"),
      "SKILL.md"
    );

    expect(document).toMatchObject({
      kind: "Skill",
      metadata: { slug: "packing", displayName: "packing" },
      spec: { instructions: { path: "SKILL.md" }, trustTier: "first_party" },
    });
  });

  it("carries commands through so a Skill can contribute a sandbox Tool", () => {
    const document = skillDocumentFromMarkdown(
      "reporting",
      markdown(
        [
          "name: reporting",
          "description: Reports.",
          "trustTier: first_party",
          "scripts:",
          "  - scripts/report.py",
          "commands:",
          "  - name: generate",
          "    toolRef: report.generate",
          "    runtimeProfile: shell-ts-python-v1",
          "    entrypoint: scripts/report.py",
          "",
        ].join("\n")
      ),
      "SKILL.md"
    );

    expect(document?.spec).toMatchObject({
      scripts: ["scripts/report.py"],
      commands: [{ name: "generate", toolRef: "report.generate" }],
    });
  });

  it("defaults an undeclared trust tier to the least-trusted tier", () => {
    const document = skillDocumentFromMarkdown(
      "packing",
      markdown("name: packing\ndescription: Packs bulbs.\n"),
      "SKILL.md"
    );

    expect(document?.spec).toMatchObject({ trustTier: "third_party" });
  });

  it("projects nothing from a SKILL.md that carries no frontmatter", () => {
    expect(skillDocumentFromMarkdown("packing", "# Packing\n", "SKILL.md")).toBeUndefined();
  });

  it("drops a secret-shaped field rather than copying its value into the definition", () => {
    const document = skillDocumentFromMarkdown(
      "packing",
      markdown("name: packing\ndescription: Packs bulbs.\napiKey: sk-live-1234\n"),
      "SKILL.md"
    );

    expect(document?.spec).not.toHaveProperty("apiKey");
  });

  // A projection that does not validate must not throw: it would fail publication of every other
  // definition in the tree over one bad Skill.
  it("projects nothing when the frontmatter does not satisfy the Skill schema", () => {
    const document = skillDocumentFromMarkdown(
      "packing",
      markdown("name: packing\ndescription: Packs bulbs.\ntrustTier: not_a_tier\n"),
      "SKILL.md"
    );

    expect(document).toBeUndefined();
  });
});
