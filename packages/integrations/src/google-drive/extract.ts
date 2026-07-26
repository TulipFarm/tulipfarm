/**
 * Extraction and OCR inherit the source's Guardrails (SPEC §14.1: "embeddings, OCR, extracted
 * text, summaries, caches, and model calls inherit the source classification, residency,
 * retention, and provider restrictions").
 *
 * Extraction is a *derivation* of protected content, so it is decided by the same default-deny
 * Guardrail engine as any other read, scoped by the file's strongest classification. With no
 * matching allow rule nothing is extracted and nothing is indexed — the source still lands, so it
 * remains citable and invalidatable, it simply has no searchable text.
 */

import { evaluateGuardrail, type GuardrailDecision, type GuardrailRule } from "@tulipfarm/authz";
import { strongestClassification } from "../knowledge/source";

export interface DriveExtractionRequest {
  readonly classification: readonly string[];
  readonly requiresOcr: boolean;
}

export type DriveExtractionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly guardrail: GuardrailDecision };

/**
 * Decide whether this file's text may be extracted. OCR is a separate action because it derives
 * text a plain export could not reach, so a policy can permit extraction while refusing OCR.
 */
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
