import { canonicalHash } from "@tulipfarm/schema";
import { type A2UISpec, validateA2UISpec } from "./schema";

export type A2UIClassification = "public" | "internal" | "confidential" | "restricted";
export type A2UIRedactionState = "unredacted" | "redacted";

export interface CreateA2UIArtifactInput {
  readonly id: string;
  readonly businessId: string;
  readonly createdBy: string;
  readonly classification: A2UIClassification;
  readonly audience: readonly string[];
  readonly retention: string;
  readonly lineage: readonly string[];
  readonly redactionState?: A2UIRedactionState;
  readonly spec: unknown;
}

export interface A2UIArtifact {
  readonly id: string;
  readonly type: "a2ui_surface";
  readonly version: "1";
  readonly businessId: string;
  readonly createdBy: string;
  readonly classification: A2UIClassification;
  readonly audience: readonly string[];
  readonly retention: string;
  readonly lineage: readonly string[];
  readonly redactionState: A2UIRedactionState;
  readonly hash: string;
  readonly spec: A2UISpec;
}

function freezeArray(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

/** Validate before publishing; the Artifact contains data only and is immutable after creation. */
export function createA2UIArtifact(input: CreateA2UIArtifactInput): A2UIArtifact {
  const spec = structuredClone(validateA2UISpec(input.spec));
  const hash = canonicalHash({ type: "a2ui_surface", version: "1", spec });
  Object.freeze(spec);
  return Object.freeze({
    id: input.id,
    type: "a2ui_surface",
    version: "1",
    businessId: input.businessId,
    createdBy: input.createdBy,
    classification: input.classification,
    audience: freezeArray(input.audience),
    retention: input.retention,
    lineage: freezeArray(input.lineage),
    redactionState: input.redactionState ?? "unredacted",
    hash,
    spec,
  });
}
