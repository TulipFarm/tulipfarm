import { ajv } from "@tulipfarm/schema";
import { generateObject, jsonSchema } from "ai";
import type { BuiltInAgentModel, BuiltInAgentSpec } from "../../agent";
import { AUDIT_SYSTEM_PROMPT, auditPrompt } from "./prompt";
import {
  SKILL_AUDIT_MODEL_REPORT_SCHEMA,
  SKILL_AUDIT_REPORT_SCHEMA,
  type SkillAuditModelReport,
  type SkillAuditReport,
  type SkillAuditScan,
} from "./schema";

/**
 * Reviews a Skill before anyone is asked to trust it.
 *
 * A Skill is a natural-language instruction file an autonomous Agent will follow with its full
 * Tool authority, and one can arrive from a stranger's Git repository. SkillAudit reads that file
 * and reports what it would steer an Agent toward.
 *
 * It is advisory: a natural-language Skill is not a sandboxable boundary, and this report is
 * evidence for the person deciding, not a gate that holds by itself. The gate is the two-step one
 * around it — `skill_create` writes a Skill marked pending, and only `skill_activate` switches it
 * on.
 *
 * Of every BuiltInAgent this is the one whose input is *presumed* hostile: the file it reads is
 * the file it exists to be suspicious of. See `./prompt.ts` for how that file and the scanner's
 * findings are fenced apart.
 */
export const SKILL_AUDIT: BuiltInAgentSpec = {
  id: "skill_audit",
  purpose: "Review an untrusted Skill file and report the reach and risk it would give an Agent.",
  // The one BuiltInAgent worth a real model: it is reading adversarial prose for intent, and a
  // cheap miss here is a Skill somebody installs on the strength of a clean report.
  rung: "balanced",
  // Room for a summary and a full findings list, not for reproducing the Skill it read.
  maxOutputTokens: 1_500,
  // This runs inside an HTTP request. Without a deadline a stalled provider holds the connection
  // open until something else gives up first; the route answers 502 and the caller can retry.
  timeoutMs: 45_000,
};

const validateModelReport = ajv.compile(SKILL_AUDIT_MODEL_REPORT_SCHEMA);
const validateReport = ajv.compile(SKILL_AUDIT_REPORT_SCHEMA);

/** Runs SkillAudit and returns a schema-validated report. */
export async function buildAudit(
  model: BuiltInAgentModel,
  skill: { name: string; description?: string; body: string },
  deterministicScan: SkillAuditScan
): Promise<SkillAuditReport> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<SkillAuditModelReport>(SKILL_AUDIT_MODEL_REPORT_SCHEMA),
    system: AUDIT_SYSTEM_PROMPT,
    prompt: auditPrompt(skill, deterministicScan),
    maxOutputTokens: SKILL_AUDIT.maxOutputTokens,
    abortSignal: AbortSignal.timeout(SKILL_AUDIT.timeoutMs),
  });

  if (!validateModelReport(object)) {
    throw new Error(
      `SkillAudit produced an invalid report: ${ajv.errorsText(validateModelReport.errors)}`
    );
  }
  const report = { ...object, deterministicScan };
  if (!validateReport(report)) {
    throw new Error(
      `SkillAudit assembled an invalid report: ${ajv.errorsText(validateReport.errors)}`
    );
  }
  return report;
}

export { AUDIT_SYSTEM_PROMPT } from "./prompt";
export {
  SKILL_AUDIT_REPORT_SCHEMA,
  type SkillAuditFinding,
  type SkillAuditReport,
  type SkillAuditScan,
} from "./schema";
