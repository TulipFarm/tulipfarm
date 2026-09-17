import { describe, expect, it } from "vitest";
import { settleIntegrationReply } from "./integration-reply";

describe("settleIntegrationReply", () => {
  it("retains the completed Turn outcome only after delivery succeeds", () => {
    expect(settleIntegrationReply({ status: "succeeded" }, { delivered: true })).toEqual({
      status: "succeeded",
    });
    expect(settleIntegrationReply({ status: "failed" }, { delivered: true })).toEqual({
      status: "failed",
    });
  });

  it("waits only when the broker supplied a durable retry wait", () => {
    expect(
      settleIntegrationReply(
        { status: "succeeded" },
        {
          delivered: false,
          outcome: "retryable",
          code: "provider_retry_wait",
          waitId: "wait-1",
        }
      )
    ).toEqual({ status: "waiting", errorEvidenceRef: "delivery:retryable" });
    expect(
      settleIntegrationReply(
        { status: "succeeded" },
        {
          delivered: false,
          outcome: "retryable",
          code: "unavailable",
        }
      )
    ).toEqual({ status: "needs_reconciliation", errorEvidenceRef: "delivery:retryable" });
  });

  it("never automatically retries an ambiguous provider effect", () => {
    expect(
      settleIntegrationReply(
        { status: "succeeded" },
        {
          delivered: false,
          outcome: "ambiguous",
          code: "indeterminate",
        }
      )
    ).toEqual({ status: "needs_reconciliation", errorEvidenceRef: "delivery:ambiguous" });
  });
});
