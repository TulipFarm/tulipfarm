import type { GuardResult, SkillTrustLevel } from "@tulipfarm/soul";

/**
 * The report shape, in two layers.
 *
 * The model is only ever shown {@link SKILL_AUDIT_MODEL_REPORT_SCHEMA}. The deterministic
 * scanner's own result is attached afterwards, so a Skill under review cannot talk the model into
 * rewriting the scanner's verdict on itself.
 */

export interface SkillAuditFinding {
  severity: "info" | "warning" | "critical";
  category: string;
  detail: string;
}

export interface SkillAuditScan extends GuardResult {
  trustLevel: SkillTrustLevel;
}

export interface SkillAuditReport {
  riskRating: "low" | "medium" | "high";
  summary: string;
  toolsReach: string[];
  findings: SkillAuditFinding[];
  deterministicScan: GuardResult & { trustLevel: SkillTrustLevel };
}

/** What the model itself returns, before the scanner's verdict is attached. */
export interface SkillAuditModelReport {
  riskRating: "low" | "medium" | "high";
  summary: string;
  toolsReach: string[];
  findings: SkillAuditFinding[];
}

export const SKILL_AUDIT_MODEL_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["riskRating", "summary", "toolsReach", "findings"],
  properties: {
    riskRating: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    toolsReach: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "detail"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          category: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

const GUARD_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["patternId", "severity", "category", "file", "line", "match", "description"],
  properties: {
    patternId: { type: "string" },
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    category: {
      type: "string",
      enum: ["exfiltration", "injection", "destructive", "obfuscation", "network", "persistence"],
    },
    file: { type: "string" },
    line: { type: "number" },
    match: { type: "string" },
    description: { type: "string" },
  },
} as const;

export const SKILL_AUDIT_REPORT_SCHEMA = {
  ...SKILL_AUDIT_MODEL_REPORT_SCHEMA,
  required: [...SKILL_AUDIT_MODEL_REPORT_SCHEMA.required, "deterministicScan"],
  properties: {
    ...SKILL_AUDIT_MODEL_REPORT_SCHEMA.properties,
    deterministicScan: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "trustLevel", "findings"],
      properties: {
        verdict: { type: "string", enum: ["safe", "caution", "dangerous"] },
        trustLevel: { type: "string", enum: ["builtin", "trusted", "community"] },
        findings: { type: "array", items: GUARD_FINDING_SCHEMA },
      },
    },
  },
} as const;
