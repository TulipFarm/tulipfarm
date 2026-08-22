import { describe, expect, it } from "vitest";
import { SKILL_FORBIDDEN_GRANT_KEYS } from "./definitions/skill";
import { serializeSkill, validateSkill } from "./skill-frontmatter";

const VALID_FRONTMATTER = {
  name: "code-review",
  description: "Review code for correctness.",
};

function validate(
  frontmatter: Record<string, unknown> = VALID_FRONTMATTER,
  body = "Follow the review procedure.",
  content = serializeSkill(frontmatter, body),
  name = "code-review"
) {
  return validateSkill({ name, frontmatter, body, content });
}

describe("validateSkill", () => {
  it.each([
    ["uppercase", "Foo"],
    ["leading hyphen", "-bad"],
    ["65 characters", "a".repeat(65)],
  ])("rejects an invalid name: %s", (_label, name) => {
    expect(validate({ ...VALID_FRONTMATTER, name }, "Body.", undefined, name)).toMatchObject({
      valid: false,
    });
  });

  it("accepts the name length and character boundaries", () => {
    const name = `1.${"a".repeat(61)}_`;
    expect(name).toHaveLength(64);
    expect(validate({ ...VALID_FRONTMATTER, name }, "Body.", undefined, name)).toMatchObject({
      valid: true,
    });
  });

  it("accepts a 1024-character description and rejects 1025 characters", () => {
    expect(validate({ ...VALID_FRONTMATTER, description: "d".repeat(1024) })).toMatchObject({
      valid: true,
    });
    expect(validate({ ...VALID_FRONTMATTER, description: "d".repeat(1025) })).toMatchObject({
      valid: false,
    });
  });

  it("rejects an empty or whitespace-only body", () => {
    expect(validate(VALID_FRONTMATTER, " \n\t")).toEqual({
      valid: false,
      error: "SKILL.md body must not be empty",
    });
  });

  it("accepts exactly 100,000 characters and rejects 100,001", () => {
    expect(validate(VALID_FRONTMATTER, "Body.", "x".repeat(100_000))).toMatchObject({
      valid: true,
    });
    expect(validate(VALID_FRONTMATTER, "Body.", "x".repeat(100_001))).toEqual({
      valid: false,
      error: "SKILL.md content exceeds 100,000 characters",
    });
  });

  it("rejects a frontmatter name that differs from the directory name", () => {
    expect(validate({ ...VALID_FRONTMATTER, name: "other-skill" })).toEqual({
      valid: false,
      error: 'frontmatter.name must equal the Skill directory name "code-review"',
    });
  });

  it("rejects agent-supplied _pendingAudit and nested underscore-prefixed keys", () => {
    expect(validate({ ...VALID_FRONTMATTER, _pendingAudit: true })).toEqual({
      valid: false,
      error: "frontmatter._pendingAudit is reserved for server use",
    });
    expect(
      validate({
        ...VALID_FRONTMATTER,
        metadata: { settings: [{ _serverOnly: true }] },
      })
    ).toEqual({
      valid: false,
      error: "frontmatter.metadata.settings[0]._serverOnly is reserved for server use",
    });
  });

  // The server writes `_pendingAudit` itself, so re-reading a stored SKILL.md as author input
  // rejected the exact file the write gateway had just been handed.
  it("accepts the runtime's own _pendingAudit when the frontmatter came from the Soul", () => {
    const frontmatter = { ...VALID_FRONTMATTER, _pendingAudit: true };
    expect(
      validateSkill({
        name: "code-review",
        frontmatter,
        body: "Follow the review procedure.",
        content: serializeSkill(frontmatter, "Follow the review procedure."),
        origin: "stored",
      })
    ).toMatchObject({ valid: true });
  });

  it("still rejects other reserved keys in stored frontmatter", () => {
    const frontmatter = { ...VALID_FRONTMATTER, _grants: ["tool"] };
    expect(
      validateSkill({
        name: "code-review",
        frontmatter,
        body: "Follow the review procedure.",
        content: serializeSkill(frontmatter, "Follow the review procedure."),
        origin: "stored",
      })
    ).toMatchObject({ valid: false });
  });

  it.each(SKILL_FORBIDDEN_GRANT_KEYS)("rejects grant-shaped key %s", (key) => {
    expect(validate({ ...VALID_FRONTMATTER, [key]: ["tool"] })).toMatchObject({
      valid: false,
      error: expect.stringContaining(`frontmatter.${key}`),
    });
  });

  it("rejects nested grant-shaped keys", () => {
    expect(
      validate({
        ...VALID_FRONTMATTER,
        metadata: { authority: { permissions: ["write"] } },
      })
    ).toEqual({
      valid: false,
      error:
        "frontmatter.metadata.authority.permissions is forbidden because a Skill cannot grant authority",
    });
  });

  it("accepts unknown benign keys for forward compatibility", () => {
    const result = validate({
      ...VALID_FRONTMATTER,
      platforms: ["macos", "linux"],
      metadata: { tags: ["review"], config: [{ key: "review.depth", default: "normal" }] },
    });
    expect(result).toMatchObject({ valid: true });
  });

  it("accepts exact Secret requirements and domains", () => {
    expect(
      validate({
        ...VALID_FRONTMATTER,
        requiredSecrets: ["GITHUB_PAT"],
        allowedDomains: ["api.github.com"],
      })
    ).toMatchObject({ valid: true });
  });

  it.each([
    ["wildcard domain", { allowedDomains: ["*.example.com"] }],
    ["URL instead of domain", { allowedDomains: ["https://example.com"] }],
    ["invalid Secret key", { requiredSecrets: ["github-token"] }],
  ])("rejects a non-exact network declaration: %s", (_label, fields) => {
    expect(validate({ ...VALID_FRONTMATTER, ...fields })).toMatchObject({ valid: false });
  });
});
