import {
  AGENT_DEFINITION,
  type AgentAutonomyCeiling,
  DEFINITION_API_VERSION,
  deriveModelProfiles,
  isRecord,
  type LlmConfig,
  parseFrontmatter,
  resolveEffortPreset,
  SchemaRegistry,
  type VersionedSchemaDocument,
} from "@tulipfarm/schema";
import { deriveDefinitionId } from "./converters/shared";

/**
 * Runtime Agent definitions synthesized from a legacy `AGENT.md`.
 *
 * `AGENT.md` is the only Agent format the product writes, and it carries no canonical envelope, so
 * it contributed no definition to `readDefinitions`. Every consumer of that source therefore
 * behaved as if the Agent did not exist: a Routine `agentRef` could not resolve at write time, and
 * the compiled bundle held no Agent for the Worker to run — so no Agent reachable from Chat could
 * ever be named by a Routine.
 *
 * This mirrors {@link import("./model-profile-documents").modelProfileDocuments}: the authored file
 * stays authoritative and nothing is written back to the tree; the canonical view is derived on
 * read so validation and compilation see one definition set.
 */

const registry = new SchemaRegistry([AGENT_DEFINITION]);

/** Trust tier of anything the operator's own instance authored into its Soul. */
const SYNTHESIZED_TRUST_TIER = "business_authored";

/** `AGENT.md` states no owner, and the Soul it lives in belongs to the operator running it. */
const SYNTHESIZED_OWNER = "operator";

/**
 * Chat autonomy is a four-rung approval posture; the canonical ceiling is a four-rung effect
 * posture. They are different vocabularies over the same intent, so map rather than pass through —
 * an unmapped value would fail validation and quarantine an Agent that Chat considers valid.
 */
const AUTONOMY_CEILINGS: Readonly<Record<string, AgentAutonomyCeiling>> = {
  full: "execute_policy_authorized",
  supervised: "execute_low_risk",
  "approval-required": "propose_actions",
  manual: "answer_only",
};

/** Absent autonomy in Chat means "no configured ceiling"; the derived view must still name one. */
const DEFAULT_AUTONOMY: AgentAutonomyCeiling = "execute_low_risk";

/**
 * `spec.personality` is the only authored text a Routine Agent State puts in front of the model, so
 * the `AGENT.md` body goes there. The field is capped, and a body over the cap is still far better
 * evidence of the Agent's intent than none.
 */
const PERSONALITY_MAX = 8192;

/**
 * The ModelProfile a projected Agent names: the Soul's own default Effort Preset.
 *
 * `undefined` when the Soul configures no LLM, and the caller must then project no Agent at all.
 * `spec.modelProfile` is a required reference, so naming a profile the tree does not derive would
 * turn every Agent into an unresolved reference and fail publication of the whole tree — which is
 * exactly the state a freshly scaffolded Soul is in before its first LLM is configured.
 */
export function defaultModelProfile(config: LlmConfig | undefined): string | undefined {
  if (config === undefined) return undefined;
  const available = new Set(deriveModelProfiles(config).map((profile) => profile.profileId));
  if (available.size === 0) return undefined;
  return resolveEffortPreset("auto", config, (profileId) => available.has(profileId));
}

/**
 * The canonical view of one `AGENT.md`, or `undefined` when the file does not yield a valid Agent.
 *
 * Returning `undefined` rather than throwing is deliberate: an Agent that cannot be projected must
 * not fail the publication of every other definition in the tree.
 */
export function agentDocumentFromLegacy(
  slug: string,
  content: string,
  modelProfile: string,
  legacyPath: string
): VersionedSchemaDocument | undefined {
  const { frontmatter, body } = parseFrontmatter(content);
  const fields = isRecord(frontmatter) ? frontmatter : {};
  const autonomy = typeof fields.autonomy === "string" ? fields.autonomy : undefined;
  const label = typeof fields.label === "string" ? fields.label : undefined;
  const ownership = isRecord(fields.ownership) ? fields.ownership : undefined;
  const personality = body.trim();

  const document = {
    apiVersion: DEFINITION_API_VERSION,
    kind: "Agent",
    metadata: {
      id: deriveDefinitionId("Agent", slug),
      slug,
      displayName: label ?? slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      owner: SYNTHESIZED_OWNER,
      ...(ownership === undefined ? {} : { ownership }),
      instructions: { path: legacyPath },
      ...(personality.length === 0 ? {} : { personality: personality.slice(0, PERSONALITY_MAX) }),
      modelProfile,
      ...(isRecord(fields.modelPolicy) ? { modelPolicy: fields.modelPolicy } : {}),
      autonomy:
        (autonomy === undefined ? undefined : AUTONOMY_CEILINGS[autonomy]) ?? DEFAULT_AUTONOMY,
      trustTier: SYNTHESIZED_TRUST_TIER,
    },
  };

  try {
    return registry.validate(document).document;
  } catch {
    // A projection that does not validate is no projection; the Agent stays Chat-only.
    return undefined;
  }
}
