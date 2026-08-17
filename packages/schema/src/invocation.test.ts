import { describe, expect, it } from "vitest";
import { ajv } from "./ajv";
import {
  CURATOR_REQUEST_SCHEMA,
  type CuratorBusinessRequest,
  type CuratorUserRequest,
  INVOCATION_REQUEST_SCHEMAS,
} from "./invocation";

const validateCurator = ajv.compile(CURATOR_REQUEST_SCHEMA);

const DIGEST = "a".repeat(64);

const userPayload: CuratorUserRequest = {
  jobId: "job-1",
  scope: "user",
  subjectUserId: "user-1",
  reasons: ["turn_completed"],
  turnIds: ["turn-1"],
  memoryRevisionId: "rev-1",
  memoryRevisionHash: DIGEST,
  inputDigest: DIGEST,
};

const businessPayload: CuratorBusinessRequest = {
  jobId: "job-2",
  scope: "business",
  soulDigest: DIGEST,
  candidateIds: ["cand-1"],
  inputDigest: DIGEST,
};

describe("invocation request registry", () => {
  it("registers unique refs and compiles every schema", () => {
    const refs = INVOCATION_REQUEST_SCHEMAS.map((entry) => entry.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const entry of INVOCATION_REQUEST_SCHEMAS) {
      expect(() => ajv.compile(entry.schema)).not.toThrow();
    }
  });
});

describe("curator request schema", () => {
  it("accepts both scopes", () => {
    expect(validateCurator(userPayload)).toBe(true);
    expect(validateCurator(businessPayload)).toBe(true);
  });

  // I-20: business reasoning aggregates several people, so it must not carry an audience.
  it("rejects a business payload naming a user", () => {
    expect(validateCurator({ ...businessPayload, subjectUserId: "user-1" })).toBe(false);
  });

  it("rejects a user payload without a subject or a reason", () => {
    const { subjectUserId: _subject, ...noSubject } = userPayload;
    expect(validateCurator(noSubject)).toBe(false);
    expect(validateCurator({ ...userPayload, reasons: [] })).toBe(false);
  });

  it("rejects an unknown work reason", () => {
    expect(validateCurator({ ...userPayload, reasons: ["invented_reason"] })).toBe(false);
  });

  // The request Artifact is append-only and never expires, so content must not reach it.
  it("rejects content-bearing keys", () => {
    expect(validateCurator({ ...userPayload, transcript: "hello" })).toBe(false);
    expect(validateCurator({ ...userPayload, memoryDocument: "## Identity" })).toBe(false);
  });

  it("requires hashes to be sha256 hex", () => {
    expect(validateCurator({ ...userPayload, inputDigest: "not-a-digest" })).toBe(false);
    expect(validateCurator({ ...userPayload, memoryRevisionHash: DIGEST.toUpperCase() })).toBe(
      false
    );
  });
});
