import { createHash } from "node:crypto";
import {
  DEFINITION_API_VERSION,
  type DerivedModelProfile,
  deriveModelProfiles,
  type LlmConfig,
  MODEL_PROFILE_DEFINITION,
  SchemaRegistry,
  type VersionedSchemaDocument,
} from "@tulipfarm/schema";

const registry = new SchemaRegistry([MODEL_PROFILE_DEFINITION]);

/** Stable identity keeps the same Soul Config pinned to the same ModelProfile references. */
export function derivedModelProfileId(slug: string): string {
  const hex = createHash("sha256").update(`ModelProfile:${slug}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function documentFor(
  profile: DerivedModelProfile,
  lifecycle: "draft" | "published"
): VersionedSchemaDocument {
  const { profileId, spec, ...profileSpec } = profile;
  const document = {
    apiVersion: DEFINITION_API_VERSION,
    kind: "ModelProfile",
    metadata: {
      id: derivedModelProfileId(profileId),
      slug: profileId,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle,
    },
    spec: profileSpec,
  };
  return registry.validate(document).document;
}

/** Runtime ModelProfiles synthesized from the sole authored source: `soul.yaml#llm`. */
export function modelProfileDocuments(config: LlmConfig): readonly VersionedSchemaDocument[] {
  return deriveModelProfiles(config).map((profile) => documentFor(profile, "published"));
}

/** Fingerprint used only to identify files written by the retired v1 migration. */
export function isGeneratedModelProfile(document: unknown, slug: string): boolean {
  let validated: VersionedSchemaDocument;
  try {
    validated = registry.validate(document).document;
  } catch {
    // A document that fails validation is not a generated model profile.
    return false;
  }
  const metadata = validated.metadata as Record<string, unknown> | undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false;
  return (
    validated.kind === "ModelProfile" &&
    metadata.id === derivedModelProfileId(slug) &&
    metadata.slug === slug &&
    metadata.schemaVersion === 1 &&
    metadata.authoredVersion === 1 &&
    metadata.lifecycle === "draft"
  );
}
