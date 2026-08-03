import type { GuardrailDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { checkDlpBoundary } from "./dlp";
import { evaluateGuardrail } from "./engine";
import { compileGuardrailPolicy, GuardrailPolicyError } from "./policy";

type AuthoredRule = GuardrailDefinition["spec"]["rules"][number];

function guardrail(...rules: AuthoredRule[]): GuardrailDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Guardrail",
    metadata: {
      id: "01J0000000000000000000GUAR",
      slug: "triage",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { defaultDecision: "deny", rules },
  } as GuardrailDefinition;
}

const allowComment: AuthoredRule = {
  id: "allow-comment",
  type: "allow",
  actions: ["issue.comment"],
  dataClasses: ["source-content"],
  destinations: ["github"],
} as AuthoredRule;

describe("compileGuardrailPolicy", () => {
  it("compiles a scoped allow into a rule that permits exactly what it names", () => {
    const { rules } = compileGuardrailPolicy([guardrail(allowComment)]);

    expect(
      evaluateGuardrail(rules, {
        action: "issue.comment",
        resourceType: "github.issue",
        dataClass: "source-content",
        destination: "github",
      })
    ).toEqual({ effect: "allow", reason: "allowed", ruleId: "allow-comment" });
  });

  it("does not let a scoped allow decide a Context that omits the scoped dimension", () => {
    const { rules } = compileGuardrailPolicy([guardrail(allowComment)]);

    expect(
      evaluateGuardrail(rules, { action: "issue.comment", resourceType: "github.issue" })
    ).toEqual({ effect: "deny", reason: "no_matching_rule" });
  });

  it("expands every authored dimension, so each combination is its own rule", () => {
    const { rules } = compileGuardrailPolicy([
      guardrail({
        id: "allow-two",
        type: "allow",
        actions: ["issue.comment", "issue.label"],
        destinations: ["github", "jira"],
        scope: { resource: { types: ["github.issue"] } },
      } as AuthoredRule),
    ]);

    expect(rules).toHaveLength(4);
    expect(rules.every((rule) => rule.resourceType === "github.issue")).toBe(true);
  });

  it("turns an authored allow's data classes into the DLP permits they describe", () => {
    const { dlpRules } = compileGuardrailPolicy([guardrail(allowComment)]);

    expect(
      checkDlpBoundary(dlpRules, { dataClasses: ["source-content"], destination: "github" })
    ).toEqual({ effect: "allow", reason: "allowed" });
    expect(
      checkDlpBoundary(dlpRules, { dataClasses: ["source-content"], destination: "slack" })
    ).toMatchObject({ effect: "deny", reason: "destination_not_allowed" });
  });

  it("keeps an explicit deny winning over an allow for the same action", () => {
    const { rules } = compileGuardrailPolicy([
      guardrail(allowComment, {
        id: "deny-comment",
        type: "deny",
        actions: ["issue.comment"],
      } as AuthoredRule),
    ]);

    expect(
      evaluateGuardrail(rules, {
        action: "issue.comment",
        resourceType: "github.issue",
        dataClass: "source-content",
        destination: "github",
      })
    ).toEqual({ effect: "deny", reason: "explicit_deny", ruleId: "deny-comment" });
  });

  it("compiles an approval rule into the stricter require_approval effect", () => {
    const { rules } = compileGuardrailPolicy([
      guardrail(allowComment, {
        id: "approve-comment",
        type: "approval",
        actions: ["issue.comment"],
        category: "highRiskAction",
        minimumApprovers: 1,
        separationOfDuties: false,
      } as AuthoredRule),
    ]);

    expect(
      evaluateGuardrail(rules, {
        action: "issue.comment",
        resourceType: "github.issue",
        dataClass: "source-content",
        destination: "github",
      })
    ).toMatchObject({ effect: "require_approval", ruleId: "approve-comment" });
  });

  it("compiles a blocking DLP rule into a deny on the classes it detects", () => {
    const { rules } = compileGuardrailPolicy([
      guardrail(allowComment, {
        id: "block-pii",
        type: "dlp",
        detectors: [{ type: "dataClass", values: ["pii"] }],
        action: "block",
      } as AuthoredRule),
    ]);

    expect(
      evaluateGuardrail(rules, {
        action: "issue.comment",
        resourceType: "github.issue",
        dataClass: "pii",
      })
    ).toEqual({ effect: "deny", reason: "explicit_deny", ruleId: "block-pii" });
  });

  it("leaves a secret detector to the DLP boundary's own default", () => {
    const { rules, dlpRules } = compileGuardrailPolicy([
      guardrail({
        id: "block-secrets",
        type: "dlp",
        detectors: [{ type: "secret" }],
        action: "block",
      } as AuthoredRule),
    ]);

    expect(rules).toHaveLength(0);
    expect(
      checkDlpBoundary(dlpRules, { dataClasses: ["source-content"], secretDetected: true })
    ).toEqual({ effect: "deny", reason: "secret_detected" });
  });

  it.each([
    [
      "a condition it cannot evaluate",
      { scope: { conditions: [{ attribute: "issue.state", operator: "equals", value: "open" }] } },
      "unsupported_condition",
    ],
    [
      "an expiry it cannot check",
      { scope: { expiresAt: "2026-01-01T00:00:00Z" } },
      "unsupported_expiry",
    ],
    [
      "a constraint enforced elsewhere",
      { constraints: { maxBytes: 1024 } },
      "unsupported_constraint",
    ],
  ])("refuses an allow carrying %s", (_case, extra, code) => {
    expect(() =>
      compileGuardrailPolicy([guardrail({ ...allowComment, ...extra } as AuthoredRule)])
    ).toThrow(new GuardrailPolicyError(code as never, "allow-comment"));
  });

  it("refuses a redacting DLP rule rather than compiling it into a decision", () => {
    expect(() =>
      compileGuardrailPolicy([
        guardrail({
          id: "redact-pii",
          type: "dlp",
          detectors: [{ type: "dataClass", values: ["pii"] }],
          action: "redact",
        } as AuthoredRule),
      ])
    ).toThrow(new GuardrailPolicyError("unsupported_dlp_action", "redact-pii"));
  });

  it("carries an authored record ceiling onto the allow that declares it", () => {
    const { rules } = compileGuardrailPolicy([
      guardrail({ ...allowComment, constraints: { maxRecords: 2 } } as AuthoredRule),
    ]);
    const context = {
      action: "issue.comment",
      resourceType: "github.issue",
      dataClass: "source-content",
      destination: "github",
    };

    expect(evaluateGuardrail(rules, { ...context, recordCount: 2 })).toMatchObject({
      effect: "allow",
    });
    expect(evaluateGuardrail(rules, { ...context, recordCount: 3 })).toMatchObject({
      effect: "deny",
      reason: "volume_exceeded",
    });
  });

  it("compiles nothing from no definitions, which the engine reads as a denial", () => {
    const { rules, dlpRules } = compileGuardrailPolicy([]);

    expect(dlpRules).toHaveLength(0);
    expect(evaluateGuardrail(rules, { action: "issue.comment", resourceType: "*" })).toEqual({
      effect: "deny",
      reason: "no_matching_rule",
    });
  });
});
