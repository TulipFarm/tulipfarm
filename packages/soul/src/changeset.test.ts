import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  type SoulChangeset,
  type SoulChangesetSource,
  SoulChangesetValidationError,
  validateSoulChangeset,
} from "./index";

const baseCommit = "a".repeat(40);

const agent = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Agent",
  metadata: {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "general-assistant",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "draft",
  },
  spec: {
    owner: "user_01",
    instructions: { path: "instructions.md" },
    modelProfile: "sol-high",
    autonomy: "answer_only",
    trustTier: "first_party",
  },
};

function changeset(overrides: Partial<SoulChangeset> = {}): SoulChangeset {
  return {
    id: "changeset_01",
    businessId: "business_01",
    principalId: "user_01",
    source: "api",
    expectedBaseCommit: baseCommit,
    files: [
      {
        operation: "upsert",
        path: "agents/general-assistant/agent.yaml",
        content: stringify(agent),
      },
      {
        operation: "upsert",
        path: "agents/general-assistant/instructions.md",
        content: "Be helpful and precise.\n",
      },
    ],
    ...overrides,
  };
}

describe("validateSoulChangeset", () => {
  it.each<SoulChangesetSource>([
    "ui",
    "api",
    "import",
    "migration",
    "agent",
    "discovery",
  ])("accepts a valid %s changeset through the same public validator", (source) => {
    const result = validateSoulChangeset(changeset({ source }), baseCommit);

    expect(result).toMatchObject({
      id: "changeset_01",
      businessId: "business_01",
      principalId: "user_01",
      source,
      expectedBaseCommit: baseCommit,
      evidence: { outcome: "validated", fileCount: 2 },
    });
    expect(result.files).toEqual([
      expect.objectContaining({
        operation: "upsert",
        path: "agents/general-assistant/agent.yaml",
        kind: "Agent",
      }),
      expect.objectContaining({
        operation: "upsert",
        path: "agents/general-assistant/instructions.md",
      }),
    ]);
    expect(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.hash))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Be helpful and precise");
  });

  it("rejects the whole set when one file fails strict schema validation", () => {
    const invalid = { ...agent, spec: { ...agent.spec, authority: "superuser" } };
    const input = changeset({
      files: [
        ...changeset().files,
        {
          operation: "upsert",
          path: "agents/unsafe/agent.yaml",
          content: stringify(invalid),
        },
      ],
    });

    expect(() => validateSoulChangeset(input, baseCommit)).toThrowError(
      expect.objectContaining({
        code: "FILE_VALIDATION_FAILED",
        issues: [
          expect.objectContaining({
            code: "SCHEMA_VALIDATION_FAILED",
            path: "agents/unsafe/agent.yaml",
          }),
        ],
      })
    );
  });

  it("aggregates deterministic safe diagnostics without file contents", () => {
    const secret = "protected-payload-do-not-log";
    const input = changeset({
      files: [
        { operation: "upsert", path: "tools/z.yaml", content: secret },
        { operation: "upsert", path: "tools/a.yaml", content: "kind: ToolContract" },
      ],
    });

    try {
      validateSoulChangeset(input, baseCommit);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SoulChangesetValidationError);
      const validationError = error as SoulChangesetValidationError;
      expect(validationError.issues.map((issue) => issue.path)).toEqual([
        "tools/a.yaml",
        "tools/z.yaml",
      ]);
      expect(JSON.stringify(validationError)).not.toContain(secret);
      expect(validationError.message).not.toContain(secret);
    }
  });

  it("rejects a stale expected base before validating protected contents", () => {
    const secret = "protected-payload-do-not-log";
    const input = changeset({
      expectedBaseCommit: "b".repeat(40),
      files: [{ operation: "upsert", path: "tools/private.yaml", content: secret }],
    });

    expect(() => validateSoulChangeset(input, baseCommit)).toThrowError(
      expect.objectContaining({ code: "BASE_MISMATCH", issues: [] })
    );
  });

  it.each<readonly [string, Partial<SoulChangeset>, string]>([
    ["empty set", { files: [] }, "EMPTY_CHANGESET"],
    [
      "duplicate path",
      {
        files: [
          { operation: "delete", path: "agents/a/agent.yaml" },
          { operation: "delete", path: "agents/a/agent.yaml" },
        ],
      },
      "DUPLICATE_PATH",
    ],
    [
      "path traversal",
      { files: [{ operation: "delete", path: "../agents/a/agent.yaml" }] },
      "INVALID_PATH",
    ],
  ])("rejects the %s boundary", (_name, overrides, issueCode) => {
    expect(() => validateSoulChangeset(changeset(overrides), baseCommit)).toThrowError(
      expect.objectContaining({
        code: "INVALID_CHANGESET",
        issues: [expect.objectContaining({ code: issueCode })],
      })
    );
  });

  it("validates deletions without requiring removed content", () => {
    const result = validateSoulChangeset(
      changeset({ files: [{ operation: "delete", path: "agents/old/agent.yaml" }] }),
      baseCommit
    );

    expect(result.files).toEqual([
      { operation: "delete", path: "agents/old/agent.yaml", hash: expect.any(String) },
    ]);
  });

  it("denies deletion outside the canonical Soul layout", () => {
    const input = changeset({ files: [{ operation: "delete", path: ".git/config" }] });

    expect(() => validateSoulChangeset(input, baseCommit)).toThrowError(
      expect.objectContaining({
        code: "FILE_VALIDATION_FAILED",
        issues: [expect.objectContaining({ code: "UNSUPPORTED_SOUL_PATH" })],
      })
    );
  });

  it("is deterministic across retries and validator reconstruction", () => {
    const first = validateSoulChangeset(changeset(), baseCommit);
    const retried = validateSoulChangeset(changeset(), baseCommit);

    expect(retried).toEqual(first);
  });

  it("rejects a definition whose kind does not match its canonical path", () => {
    const input = changeset({
      files: [
        {
          operation: "upsert",
          path: "skills/general-assistant/skill.yaml",
          content: stringify(agent),
        },
      ],
    });

    expect(() => validateSoulChangeset(input, baseCommit)).toThrowError(
      expect.objectContaining({
        code: "FILE_VALIDATION_FAILED",
        issues: [expect.objectContaining({ code: "KIND_PATH_MISMATCH" })],
      })
    );
  });
});
