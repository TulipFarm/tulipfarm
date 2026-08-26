import { describe, expect, it } from "vitest";
import { SoulChangesetValidationError } from "./changeset";
import { soulWriteHttpError } from "./write-errors";
import { SoulWriteError } from "./writer";

describe("soulWriteHttpError", () => {
  it("names the rejected target instead of answering with a bare code", () => {
    const error = new SoulWriteError(
      "INVALID_TARGET",
      "Soul write: skills/demo/SKILL.md is a definition file, not a companion"
    );

    expect(soulWriteHttpError(error)).toEqual({
      status: 400,
      body: {
        error:
          "invalid soul write target: skills/demo/SKILL.md is a definition file, not a companion",
      },
    });
  });

  it("names the offending path, code and field of an invalid definition", () => {
    const error = new SoulWriteError("VALIDATION_FAILED", "Soul changeset validation failed", {
      issues: [{ code: "REQUIRED_FIELD", path: "skills/demo/SKILL.md", field: "/description" }],
    });

    expect(soulWriteHttpError(error).body.error).toBe(
      "invalid soul definition: skills/demo/SKILL.md REQUIRED_FIELD at /description"
    );
  });
});

describe("SoulChangesetValidationError", () => {
  it("carries the offending path and code in its message, not just a count", () => {
    const error = new SoulChangesetValidationError("FILE_VALIDATION_FAILED", [
      { code: "SCHEMA_VALIDATION_FAILED", path: "skills/demo/SKILL.md", field: "/name" },
    ]);

    expect(error.message).toBe(
      "Soul changeset validation failed (1 issue): skills/demo/SKILL.md SCHEMA_VALIDATION_FAILED at /name"
    );
  });
});
