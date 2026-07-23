import { describe, expect, it } from "vitest";
import { evaluateGuardrail, type GuardrailContext, type GuardrailRule } from "./engine";

const READ: GuardrailContext = {
  action: "record.read",
  resourceType: "invoice",
  autonomy: "interactive",
  taint: "trusted",
};

const allowRead: GuardrailRule = {
  id: "allow-read",
  effect: "allow",
  action: "record.read",
  resourceType: "invoice",
};
const allowAll: GuardrailRule = {
  id: "allow-all",
  effect: "allow",
  action: "*",
  resourceType: "*",
};
const denyRead: GuardrailRule = {
  id: "deny-read",
  effect: "deny",
  action: "record.read",
  resourceType: "invoice",
};

describe("evaluateGuardrail — default deny", () => {
  it("denies with no rules at all", () => {
    expect(evaluateGuardrail([], READ)).toEqual({
      effect: "deny",
      reason: "no_matching_rule",
    });
  });

  it("denies when no rule matches the action or Resource type", () => {
    const decision = evaluateGuardrail([allowRead], { ...READ, action: "record.write" });
    expect(decision).toEqual({ effect: "deny", reason: "no_matching_rule" });
  });

  it("allows on a fully matching allow rule, citing the rule", () => {
    expect(evaluateGuardrail([allowRead], READ)).toEqual({
      effect: "allow",
      reason: "allowed",
      ruleId: "allow-read",
    });
  });

  it("lets an explicit deny win over every matching allow, regardless of order", () => {
    for (const rules of [
      [allowAll, denyRead],
      [denyRead, allowAll],
    ]) {
      expect(evaluateGuardrail(rules, READ)).toEqual({
        effect: "deny",
        reason: "explicit_deny",
        ruleId: "deny-read",
      });
    }
  });
});

describe("evaluateGuardrail — scoped selectors fail closed", () => {
  it("never matches a Record-scoped rule when the Context omits the Record", () => {
    const scoped: GuardrailRule = { ...allowRead, id: "rec", recordSelector: "inv-1" };
    expect(evaluateGuardrail([scoped], READ)).toEqual({
      effect: "deny",
      reason: "no_matching_rule",
    });
    expect(evaluateGuardrail([scoped], { ...READ, recordId: "inv-1" }).effect).toBe("allow");
    expect(evaluateGuardrail([scoped], { ...READ, recordId: "inv-2" }).effect).toBe("deny");
  });

  it("never matches a field-scoped rule when the Context omits the field", () => {
    const scoped: GuardrailRule = { ...allowRead, id: "field", fieldSelector: ["amount"] };
    expect(evaluateGuardrail([scoped], READ).effect).toBe("deny");
    expect(evaluateGuardrail([scoped], { ...READ, field: "amount" }).effect).toBe("allow");
    expect(evaluateGuardrail([scoped], { ...READ, field: "ssn" }).effect).toBe("deny");
  });

  it("scopes data class, destination, and audience the same way", () => {
    const scoped: GuardrailRule = {
      ...allowRead,
      id: "scoped",
      dataClass: "internal",
      destination: "slack",
      audience: "team",
    };
    expect(evaluateGuardrail([scoped], READ).effect).toBe("deny");
    const full = { ...READ, dataClass: "internal", destination: "slack", audience: "team" };
    expect(evaluateGuardrail([scoped], full).effect).toBe("allow");
    expect(evaluateGuardrail([scoped], { ...full, audience: "public" }).effect).toBe("deny");
  });

  it("applies deny-rule scoping identically, so a deny cannot silently widen", () => {
    const scopedDeny: GuardrailRule = { ...denyRead, id: "deny-rec", recordSelector: "inv-1" };
    expect(evaluateGuardrail([allowRead, scopedDeny], { ...READ, recordId: "inv-2" }).effect).toBe(
      "allow"
    );
    expect(evaluateGuardrail([allowRead, scopedDeny], { ...READ, recordId: "inv-1" })).toEqual({
      effect: "deny",
      reason: "explicit_deny",
      ruleId: "deny-rec",
    });
  });
});

describe("evaluateGuardrail — volume, taint, autonomy ceilings", () => {
  it("denies when the volume ceiling is exceeded", () => {
    const capped: GuardrailRule = { ...allowRead, id: "cap", maxRecordCount: 10 };
    expect(evaluateGuardrail([capped], { ...READ, recordCount: 11 })).toEqual({
      effect: "deny",
      reason: "volume_exceeded",
      ruleId: "cap",
      dimension: "recordCount",
    });
    expect(evaluateGuardrail([capped], { ...READ, recordCount: 10 }).effect).toBe("allow");
  });

  it("denies a volume-capped rule when the Context has no record count (unverifiable)", () => {
    const capped: GuardrailRule = { ...allowRead, id: "cap", maxRecordCount: 10 };
    expect(evaluateGuardrail([capped], READ)).toEqual({
      effect: "deny",
      reason: "missing_context",
      ruleId: "cap",
      dimension: "recordCount",
    });
  });

  it("denies untrusted taint above the ceiling and missing taint alike", () => {
    const trustedOnly: GuardrailRule = { ...allowRead, id: "taint", maxTaint: "trusted" };
    expect(evaluateGuardrail([trustedOnly], { ...READ, taint: "untrusted" })).toEqual({
      effect: "deny",
      reason: "taint_exceeded",
      ruleId: "taint",
      dimension: "taint",
    });
    const { taint: _taint, ...noTaint } = READ;
    expect(evaluateGuardrail([trustedOnly], noTaint)).toEqual({
      effect: "deny",
      reason: "missing_context",
      ruleId: "taint",
      dimension: "taint",
    });
  });

  it("denies autonomy above the ceiling and missing autonomy alike", () => {
    const supervised: GuardrailRule = { ...allowRead, id: "auto", maxAutonomy: "approved" };
    expect(evaluateGuardrail([supervised], { ...READ, autonomy: "autonomous" })).toEqual({
      effect: "deny",
      reason: "autonomy_exceeded",
      ruleId: "auto",
      dimension: "autonomy",
    });
    expect(evaluateGuardrail([supervised], { ...READ, autonomy: "approved" }).effect).toBe("allow");
    const { autonomy: _autonomy, ...noAutonomy } = READ;
    expect(evaluateGuardrail([supervised], noAutonomy)).toEqual({
      effect: "deny",
      reason: "missing_context",
      ruleId: "auto",
      dimension: "autonomy",
    });
  });
});

describe("evaluateGuardrail — approval and precedence", () => {
  it("prefers require_approval over a plain allow when both fully match (stricter wins)", () => {
    const approval: GuardrailRule = {
      id: "approve",
      effect: "require_approval",
      action: "record.read",
      resourceType: "invoice",
    };
    expect(evaluateGuardrail([allowRead, approval], READ)).toEqual({
      effect: "require_approval",
      reason: "approval_required",
      ruleId: "approve",
    });
  });

  it("escalates to approval when autonomy exceeds the allow ceiling", () => {
    const interactiveAllow: GuardrailRule = { ...allowRead, id: "ia", maxAutonomy: "interactive" };
    const approval: GuardrailRule = {
      id: "approve",
      effect: "require_approval",
      action: "record.read",
      resourceType: "invoice",
    };
    const autonomous = { ...READ, autonomy: "autonomous" as const };
    expect(evaluateGuardrail([interactiveAllow, approval], autonomous)).toEqual({
      effect: "require_approval",
      reason: "approval_required",
      ruleId: "approve",
    });
    expect(evaluateGuardrail([interactiveAllow], autonomous)).toEqual({
      effect: "deny",
      reason: "autonomy_exceeded",
      ruleId: "ia",
      dimension: "autonomy",
    });
  });

  it("explicit deny beats require_approval", () => {
    const approval: GuardrailRule = {
      id: "approve",
      effect: "require_approval",
      action: "record.read",
      resourceType: "invoice",
    };
    expect(evaluateGuardrail([approval, denyRead], READ).effect).toBe("deny");
  });
});

describe("evaluateGuardrail — determinism and safe evidence", () => {
  it("returns an identical decision for identical inputs", () => {
    const rules: readonly GuardrailRule[] = [
      { ...allowRead, id: "cap", maxRecordCount: 5 },
      denyRead,
      allowAll,
    ];
    const first = evaluateGuardrail(rules, READ);
    const second = evaluateGuardrail(rules, READ);
    expect(second).toEqual(first);
  });

  it("emits only reason evidence — never Context values", () => {
    const scoped: GuardrailRule = { ...allowRead, id: "rec", recordSelector: "inv-secret" };
    const context = { ...READ, recordId: "PROTECTED-record-id", destination: "PROTECTED-dest" };
    const decision = evaluateGuardrail([scoped, denyRead], context);
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("PROTECTED");
    expect(
      Object.keys(decision).every((k) => ["effect", "reason", "ruleId", "dimension"].includes(k))
    ).toBe(true);
  });
});
