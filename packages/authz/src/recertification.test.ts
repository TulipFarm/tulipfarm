import { describe, expect, it } from "vitest";
import {
  assertRecertificationCurrent,
  assertRecertificationReviewer,
  RecertificationDeniedError,
  type RecertificationRecord,
} from "./recertification";

const NOW = new Date("2026-07-23T12:00:00Z");

function record(overrides: Partial<RecertificationRecord> = {}): RecertificationRecord {
  return {
    principalId: "principal-1",
    businessId: "business-1",
    grantId: "grant-1",
    dueAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

describe("assertRecertificationCurrent", () => {
  it("allows a record not yet due", () => {
    expect(() => assertRecertificationCurrent(record(), NOW)).not.toThrow();
  });

  it("allows a record reviewed at or after its due date's issuance window", () => {
    const due = new Date(NOW.getTime() - 60_000);
    const reviewed = record({ dueAt: due, reviewedAt: due });
    expect(() => assertRecertificationCurrent(reviewed, NOW)).not.toThrow();
  });

  it("denies an overdue record with no review recorded", () => {
    const overdue = record({ dueAt: new Date(NOW.getTime() - 1_000) });
    try {
      assertRecertificationCurrent(overdue, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RecertificationDeniedError);
      expect((error as RecertificationDeniedError).reason).toBe("overdue");
    }
  });

  it("denies an overdue record whose only review predates the deadline", () => {
    const dueAt = new Date(NOW.getTime() - 1_000);
    const staleReview = record({ dueAt, reviewedAt: new Date(dueAt.getTime() - 60_000) });
    expect(() => assertRecertificationCurrent(staleReview, NOW)).toThrow(
      RecertificationDeniedError
    );
  });
});

describe("assertRecertificationReviewer", () => {
  it("allows a different in-business reviewer", () => {
    expect(() => assertRecertificationReviewer(record(), "reviewer-1", "business-1")).not.toThrow();
  });

  it("denies self-review", () => {
    try {
      assertRecertificationReviewer(record(), "principal-1", "business-1");
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RecertificationDeniedError);
      expect((error as RecertificationDeniedError).reason).toBe("self_review");
    }
  });

  it("denies a reviewer from a different business", () => {
    try {
      assertRecertificationReviewer(record(), "reviewer-1", "business-2");
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RecertificationDeniedError);
      expect((error as RecertificationDeniedError).reason).toBe("business_mismatch");
    }
  });
});
