import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors";
import { EVENT_VERIFICATION_STATUSES, type EventEnvelope, validateEventEnvelope } from "./event";

function validEnvelope(): Record<string, unknown> {
  return {
    eventId: "evt_1",
    type: "github.issue.created",
    version: 1,
    occurredAt: "2026-07-22T00:00:00.000Z",
    receivedAt: "2026-07-22T00:00:01.000Z",
    businessId: "biz_1",
    source: { provider: "github", integrationId: "int_1", deliveryId: "del_1" },
    principal: { kind: "external", externalId: "gh_42" },
    record: { type: "issue", id: "100", version: "1" },
    deduplicationKey: "github:del_1",
    classification: ["public"],
    data: { number: 100 },
    verification: { status: "verified", method: "hmac_sha256" },
  };
}

describe("EventEnvelope schema", () => {
  it("accepts a fully specified verified envelope and returns a typed value", () => {
    const result: EventEnvelope = validateEventEnvelope(validEnvelope());
    expect(result.type).toBe("github.issue.created");
    expect(result.verification.status).toBe("verified");
  });

  it("accepts an unverified envelope with no method", () => {
    const envelope = validEnvelope();
    envelope.verification = { status: "unverified" };
    expect(() => validateEventEnvelope(envelope)).not.toThrow();
  });

  it("rejects raw-provider masquerading: verified status without a verification method", () => {
    const envelope = validEnvelope();
    envelope.verification = { status: "verified" };
    expect(() => validateEventEnvelope(envelope)).toThrow(SchemaValidationError);
  });

  it("rejects raw-provider masquerading: verified status with an empty method", () => {
    const envelope = validEnvelope();
    envelope.verification = { status: "verified", method: "" };
    expect(() => validateEventEnvelope(envelope)).toThrow(SchemaValidationError);
  });

  it("rejects an unknown verification status", () => {
    const envelope = validEnvelope();
    envelope.verification = { status: "trusted", method: "hmac_sha256" };
    expect(() => validateEventEnvelope(envelope)).toThrow(SchemaValidationError);
    expect(EVENT_VERIFICATION_STATUSES).toEqual(["verified", "unverified", "failed"]);
  });

  it("rejects unknown top-level and nested properties", () => {
    const extra = validEnvelope();
    extra.injected = true;
    expect(() => validateEventEnvelope(extra)).toThrow(SchemaValidationError);

    const nested = validEnvelope();
    nested.source = { provider: "github", spoofed: "x" };
    expect(() => validateEventEnvelope(nested)).toThrow(SchemaValidationError);
  });

  it("requires non-empty core provenance and dedup fields", () => {
    for (const field of ["eventId", "type", "businessId", "deduplicationKey"]) {
      const envelope = validEnvelope();
      envelope[field] = "";
      expect(() => validateEventEnvelope(envelope)).toThrow(SchemaValidationError);
    }
    const missingData = validEnvelope();
    delete missingData.data;
    expect(() => validateEventEnvelope(missingData)).toThrow(SchemaValidationError);
  });

  it("requires version to be a positive integer, not a string", () => {
    const stringVersion = validEnvelope();
    stringVersion.version = "1";
    expect(() => validateEventEnvelope(stringVersion)).toThrow(SchemaValidationError);

    const zeroVersion = validEnvelope();
    zeroVersion.version = 0;
    expect(() => validateEventEnvelope(zeroVersion)).toThrow(SchemaValidationError);
  });

  it("rejects timestamps that are not ISO-8601 date-times", () => {
    const envelope = validEnvelope();
    envelope.occurredAt = "yesterday";
    expect(() => validateEventEnvelope(envelope)).toThrow(SchemaValidationError);
  });

  it("does not leak protected payload values in error messages", () => {
    const envelope = validEnvelope();
    envelope.classification = ["secret", "protected-value-xyz"];
    envelope.version = "1";
    try {
      validateEventEnvelope(envelope);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as Error).message).not.toContain("protected-value-xyz");
    }
  });
});
