/** Extraction/OCR inherit source Guardrails; denied text is not indexed. */

import { evaluateGuardrail, type GuardrailDecision, type GuardrailRule } from "@tulipfarm/authz";
import { strongestClassification } from "../knowledge/source";

export interface DriveExtractionRequest {
  readonly classification: readonly string[];
  readonly requiresOcr: boolean;
}

export type DriveExtractionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly guardrail: GuardrailDecision };

/** OCR is checked separately because it derives text export cannot reach. */
export function decideDriveExtraction(
  rules: readonly GuardrailRule[],
  request: DriveExtractionRequest
): DriveExtractionDecision {
  const dataClass = strongestClassification(request.classification);
  const extraction = evaluateGuardrail(rules, {
    action: "knowledge.extract",
    resourceType: "knowledge_source",
    dataClass,
    destination: "knowledge_index",
  });
  if (extraction.effect !== "allow") return { allowed: false, guardrail: extraction };
  if (!request.requiresOcr) return { allowed: true };

  const ocr = evaluateGuardrail(rules, {
    action: "knowledge.ocr",
    resourceType: "knowledge_source",
    dataClass,
    destination: "knowledge_index",
  });
  return ocr.effect === "allow" ? { allowed: true } : { allowed: false, guardrail: ocr };
}
