import { DEFINITION_API_VERSION } from "@tulipfarm/schema";
import { stringify } from "yaml";
import type { SoulFileChange } from "../changeset";
import type { SoulAgent } from "../types";
import { type ConversionResult, deriveDefinitionId, mapAllowlistedFields, slugify } from "./shared";

const KIND = "Agent";

/** `AgentSpec` fields sourced from legacy frontmatter (`instructions` is always derived, never copied). */
const AGENT_FRONTMATTER_ALLOWLIST = [
  "owner",
  "maintainers",
  "personality",
  "roles",
  "permissionCeiling",
  "modelProfile",
  "skills",
  "allowedTools",
  "autonomy",
  "limits",
  "guardrails",
  "memoryScopes",
  "knowledgeScopes",
  "trustTier",
  "evaluationSuite",
] as const;

const AGENT_REQUIRED_FIELDS = ["owner", "modelProfile", "autonomy", "trustTier"] as const;

/** Convert legacy Agent files into proposed canonical files; never writes or publishes. */
export function convertLegacyAgent(agent: SoulAgent): ConversionResult {
  const slug = slugify(agent.name);
  const { mapped, warnings } = mapAllowlistedFields(agent.frontmatter, AGENT_FRONTMATTER_ALLOWLIST);

  const missing = AGENT_REQUIRED_FIELDS.filter((field) => mapped[field] === undefined);
  if (missing.length > 0) {
    return {
      files: [],
      warnings: [
        ...warnings,
        ...missing.map((field) => ({ code: "MISSING_REQUIRED_FIELD" as const, field })),
      ],
    };
  }

  const spec: Record<string, unknown> = { owner: mapped.owner };
  if (mapped.maintainers !== undefined) spec.maintainers = mapped.maintainers;
  spec.instructions = { path: "instructions.md" };
  if (mapped.personality !== undefined) spec.personality = mapped.personality;
  if (mapped.roles !== undefined) spec.roles = mapped.roles;
  if (mapped.permissionCeiling !== undefined) spec.permissionCeiling = mapped.permissionCeiling;
  spec.modelProfile = mapped.modelProfile;
  if (mapped.skills !== undefined) spec.skills = mapped.skills;
  if (mapped.allowedTools !== undefined) spec.allowedTools = mapped.allowedTools;
  spec.autonomy = mapped.autonomy;
  if (mapped.limits !== undefined) spec.limits = mapped.limits;
  if (mapped.guardrails !== undefined) spec.guardrails = mapped.guardrails;
  if (mapped.memoryScopes !== undefined) spec.memoryScopes = mapped.memoryScopes;
  if (mapped.knowledgeScopes !== undefined) spec.knowledgeScopes = mapped.knowledgeScopes;
  spec.trustTier = mapped.trustTier;
  if (mapped.evaluationSuite !== undefined) spec.evaluationSuite = mapped.evaluationSuite;

  const document = {
    apiVersion: DEFINITION_API_VERSION,
    kind: KIND,
    metadata: {
      id: deriveDefinitionId(KIND, agent.name),
      slug,
      displayName: agent.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "draft",
    },
    spec,
  };

  const files: SoulFileChange[] = [
    {
      operation: "upsert",
      path: `agents/${slug}/agent.yaml`,
      content: stringify(document),
    },
    {
      operation: "upsert",
      path: `agents/${slug}/instructions.md`,
      content: agent.body,
    },
  ];

  return { files, warnings };
}
