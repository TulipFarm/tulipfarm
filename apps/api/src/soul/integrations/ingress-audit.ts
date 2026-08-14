import type { LlmService } from "@tulipfarm/llm";
import { ajv } from "@tulipfarm/schema";
import { generateObject, jsonSchema } from "ai";
import { SKILL_AUDIT_REPORT_SCHEMA, type SkillAuditReport } from "../skills/audit";

/* IngressAudit reviews classifier abuse the sandbox cannot stop: misrouting and injection. */

export const INGRESS_AUDIT_SYSTEM_PROMPT = [
  "You are IngressAudit, a security reviewer for integration webhook classifiers.",
  "The code below runs in a strict isolated-vm sandbox (no network, no filesystem, no timers,",
  "no process access) and must be a pure function `classify(ctx)` that maps a verified webhook",
  "payload to one of: ignore, a chat turn (with sender/text/reply routing), or a typed event.",
  "",
  "Because the sandbox blocks I/O, focus on classification abuse:",
  "- chat decisions for messages NOT addressed to the assistant (turn flooding, cost abuse),",
  "- event decisions for high-volume payload types (event flooding),",
  "- prompt-injection: instructions embedded into the returned chat `text` beyond the sender's",
  "  own message content,",
  "- reply-routing abuse: reply vars derived from attacker-controlled fields that would send",
  "  answers somewhere other than the originating channel/thread,",
  "- sender spoofing: `sender` derived from a field the payload author controls arbitrarily,",
  "- obfuscated logic that hides any of the above.",
  "",
  "Be precise and skeptical, but do not invent risks that are not present. A classifier that",
  "only reacts to explicit mentions/DMs and echoes the sender's own message should rate low.",
  "Your report is advisory; the operator confirms the install.",
].join("\n");

const validateReport = ajv.compile(SKILL_AUDIT_REPORT_SCHEMA);

/** Same report shape as SkillAudit — the UI renders both identically. */
export type IngressAuditReport = SkillAuditReport;

/** Run IngressAudit and validate the model report schema. */
export async function buildIngressAudit(
  model: ReturnType<LlmService["effortModel"]>,
  integration: { name: string; handlerSource: string }
): Promise<IngressAuditReport> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<IngressAuditReport>(SKILL_AUDIT_REPORT_SCHEMA),
    system: INGRESS_AUDIT_SYSTEM_PROMPT,
    prompt: [
      `Integration: ${integration.name}`,
      "",
      "ingress.ts source:",
      integration.handlerSource,
    ].join("\n"),
  });

  if (!validateReport(object)) {
    throw new Error(
      `IngressAudit produced an invalid report: ${ajv.errorsText(validateReport.errors)}`
    );
  }
  return object;
}
