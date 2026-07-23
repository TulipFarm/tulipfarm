import { describe, expect, it } from "vitest";
import { checkDlpBoundary, type DlpCrossing, type DlpRule } from "./dlp";

const piiToSlack: DlpRule = {
  dataClass: "pii",
  allowedDestinations: ["slack"],
  allowedAudiences: ["team"],
};
const internalAnywhere: DlpRule = { dataClass: "internal" };

const okCrossing: DlpCrossing = {
  dataClasses: ["pii"],
  destination: "slack",
  audience: "team",
};

describe("checkDlpBoundary — default deny", () => {
  it("denies unclassified data (empty data classes are unverifiable)", () => {
    const decision = checkDlpBoundary([piiToSlack], { ...okCrossing, dataClasses: [] });
    expect(decision).toEqual({ effect: "deny", reason: "unclassified_data" });
  });

  it("denies a data class with no DLP rule, naming only the class", () => {
    const decision = checkDlpBoundary([piiToSlack], {
      ...okCrossing,
      dataClasses: ["pii", "financial"],
    });
    expect(decision).toEqual({
      effect: "deny",
      reason: "no_dlp_rule",
      dataClass: "financial",
    });
  });

  it("denies a detected secret before anything else", () => {
    const decision = checkDlpBoundary([piiToSlack], { ...okCrossing, secretDetected: true });
    expect(decision).toEqual({ effect: "deny", reason: "secret_detected" });
  });

  it("allows only when every crossing class has a permitting rule", () => {
    const decision = checkDlpBoundary([piiToSlack, internalAnywhere], {
      ...okCrossing,
      dataClasses: ["pii", "internal"],
    });
    expect(decision).toEqual({ effect: "allow", reason: "allowed" });
  });
});

describe("checkDlpBoundary — destination and audience scoping", () => {
  it("denies a destination outside the rule's allowlist", () => {
    const decision = checkDlpBoundary([piiToSlack], { ...okCrossing, destination: "email" });
    expect(decision).toEqual({
      effect: "deny",
      reason: "destination_not_allowed",
      dataClass: "pii",
    });
  });

  it("denies when the crossing omits a destination the rule scopes (fail closed)", () => {
    const { destination: _destination, ...noDest } = okCrossing;
    expect(checkDlpBoundary([piiToSlack], noDest)).toEqual({
      effect: "deny",
      reason: "destination_not_allowed",
      dataClass: "pii",
    });
  });

  it("denies an audience outside the rule's allowlist, and a missing audience alike", () => {
    expect(checkDlpBoundary([piiToSlack], { ...okCrossing, audience: "public" })).toEqual({
      effect: "deny",
      reason: "audience_not_allowed",
      dataClass: "pii",
    });
    const { audience: _audience, ...noAudience } = okCrossing;
    expect(checkDlpBoundary([piiToSlack], noAudience)).toEqual({
      effect: "deny",
      reason: "audience_not_allowed",
      dataClass: "pii",
    });
  });

  it("leaves destination and audience unconstrained when the rule does not scope them", () => {
    const decision = checkDlpBoundary([internalAnywhere], {
      dataClasses: ["internal"],
      destination: "anywhere",
    });
    expect(decision).toEqual({ effect: "allow", reason: "allowed" });
  });
});

describe("checkDlpBoundary — safe evidence", () => {
  it("never echoes destination or audience values in the decision", () => {
    const decision = checkDlpBoundary([piiToSlack], {
      dataClasses: ["pii"],
      destination: "PROTECTED-dest",
      audience: "PROTECTED-aud",
    });
    expect(decision.effect).toBe("deny");
    expect(JSON.stringify(decision)).not.toContain("PROTECTED");
  });

  it("is deterministic for identical inputs", () => {
    const crossing: DlpCrossing = { dataClasses: ["pii", "internal"], destination: "email" };
    const rules = [piiToSlack, internalAnywhere];
    expect(checkDlpBoundary(rules, crossing)).toEqual(checkDlpBoundary(rules, crossing));
  });
});
