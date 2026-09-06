import { ajv } from "@tulipfarm/schema";
import { generateObject, jsonSchema } from "ai";
import type { BuiltInAgentModel, BuiltInAgentSpec } from "../../agent";
import { SOUL_REPAIR_SYSTEM_PROMPT, type SoulRepairRequest, soulRepairPrompt } from "./prompt";
import { SOUL_REPAIR_PROPOSAL_SCHEMA, type SoulRepairProposal } from "./schema";

/**
 * Repairs one broken Soul artifact from one proved defect.
 *
 * It is a single-shot call and not an Agent Run on purpose: it gets one file and one finding, no
 * Tools, and no way to reach the rest of the instance. What it returns is not trusted — the Doctor
 * re-lints the proposal and gates it before anything is published — so the model's job is to
 * propose, never to decide.
 */
export const SOUL_REPAIR: BuiltInAgentSpec = {
  id: "soul_repair",
  purpose: "Rewrite one broken Soul artifact so a named defect in it no longer holds.",
  // Its output is published, sometimes without a person in the loop, so the cheap rung's habit of
  // rewriting more than it was asked to would land as a diff nobody reviewed.
  rung: "balanced",
  // A whole Routine document plus a one-line summary. Larger than the other agents because the
  // reply is a file, not a verdict.
  maxOutputTokens: 8_000,
  // Runs on a background sweep, not in a request, so it can wait longer than the audit — but not
  // past the five-minute tick that would otherwise overlap the next sweep.
  timeoutMs: 120_000,
};

const validateProposal = ajv.compile(SOUL_REPAIR_PROPOSAL_SCHEMA);

/** Runs SoulRepair and returns a schema-validated proposal. Never publishes anything. */
export async function proposeSoulRepair(
  model: BuiltInAgentModel,
  request: SoulRepairRequest
): Promise<SoulRepairProposal> {
  const { object } = await generateObject({
    model,
    schema: jsonSchema<SoulRepairProposal>(SOUL_REPAIR_PROPOSAL_SCHEMA),
    system: SOUL_REPAIR_SYSTEM_PROMPT,
    prompt: soulRepairPrompt(request),
    maxOutputTokens: SOUL_REPAIR.maxOutputTokens,
    abortSignal: AbortSignal.timeout(SOUL_REPAIR.timeoutMs),
  });
  if (!validateProposal(object)) {
    throw new Error(
      `SoulRepair produced an invalid proposal: ${ajv.errorsText(validateProposal.errors)}`
    );
  }
  return object;
}

export { SOUL_REPAIR_SYSTEM_PROMPT, type SoulRepairRequest, soulRepairPrompt } from "./prompt";
export { SOUL_REPAIR_PROPOSAL_SCHEMA, type SoulRepairProposal } from "./schema";
