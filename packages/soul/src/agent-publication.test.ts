import { describe, expect, it } from "vitest";
import {
  AgentPublicationError,
  type AgentPublicationRequest,
  publishAgentVersion,
} from "./agent-publication";

function request(overrides: Partial<AgentPublicationRequest> = {}): AgentPublicationRequest {
  return {
    agentId: "triage-agent",
    version: "2.0.0",
    actionCapable: true,
    activation: { decision: "allowed" },
    evalReportDigest: "a".repeat(64),
    publishedBy: "user:admin-1",
    ...overrides,
  };
}

describe("publishAgentVersion", () => {
  it("publishes an action-capable Agent whose activation gate allowed it", () => {
    expect(publishAgentVersion(request())).toMatchObject({
      status: "published",
      agentId: "triage-agent",
      version: "2.0.0",
      evalReportDigest: "a".repeat(64),
    });
  });

  it("refuses to publish an action-capable Agent the gate blocked", () => {
    expect(() =>
      publishAgentVersion(
        request({
          activation: {
            decision: "blocked",
            reason: "eval_regression",
            regressedCaseIds: ["triage-1"],
            failedCaseIds: ["triage-1"],
          },
        })
      )
    ).toThrow(AgentPublicationError);
  });

  it("records the admin exception that carried a blocked run past the gate", () => {
    expect(
      publishAgentVersion(request({ activation: { decision: "allowed", exceptionId: "exc-1" } }))
    ).toMatchObject({ status: "published", exceptionId: "exc-1" });
  });

  it("requires eval evidence for an action-capable Agent", () => {
    expect(() => publishAgentVersion(request({ evalReportDigest: undefined }))).toThrow(
      AgentPublicationError
    );
  });

  it("publishes a read-only Agent without an eval report", () => {
    expect(
      publishAgentVersion(
        request({ actionCapable: false, evalReportDigest: undefined, activation: undefined })
      )
    ).toMatchObject({ status: "published" });
  });

  it("refuses an action-capable Agent with no activation verdict at all", () => {
    expect(() => publishAgentVersion(request({ activation: undefined }))).toThrow(
      AgentPublicationError
    );
  });

  it("carries the reason code without leaking case content", () => {
    try {
      publishAgentVersion(
        request({
          activation: {
            decision: "blocked",
            reason: "blocking_case_failed",
            regressedCaseIds: [],
            failedCaseIds: ["triage-1"],
          },
        })
      );
      throw new Error("expected publication to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentPublicationError);
      expect((error as AgentPublicationError).code).toBe("activation_blocked");
      expect((error as AgentPublicationError).message).toBe(
        "activation_blocked:blocking_case_failed"
      );
    }
  });
});
