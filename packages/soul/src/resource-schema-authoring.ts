import { existsSync } from "node:fs";
import { join } from "node:path";
import { ajv, TulipFarmValidationError, validateResourceSchema } from "@tulipfarm/schema";
import { parse as parseYaml } from "yaml";
import type { CommitActor } from "./commit-signing";
import type { SoulWriteResult, SoulWriter } from "./writer";

export class ResourceSchemaAuthoringError extends Error {}

export interface AuthorLegacyResourceTypeInput {
  readonly name: string;
  readonly schemaYaml: string;
  readonly soulRoot: string;
  readonly writer: SoulWriter;
  readonly actor: CommitActor;
  readonly businessId: string;
  readonly reload: () => Promise<unknown>;
  readonly reconcile?: () => Promise<unknown>;
}

export async function authorLegacyResourceType(
  input: AuthorLegacyResourceTypeInput
): Promise<{ readonly schema: Record<string, unknown>; readonly write: SoulWriteResult }> {
  if (!/^[a-z][a-z0-9-]*$/.test(input.name)) {
    throw new ResourceSchemaAuthoringError("invalid resource type name");
  }
  if (existsSync(join(input.soulRoot, "resources", input.name))) {
    throw new ResourceSchemaAuthoringError("resource type already exists");
  }
  const schema = validateResourceSchemaYaml(input.schemaYaml);
  const write = await input.writer.apply({
    subject: `soul: add resource type ${input.name}`,
    source: "agent",
    actor: input.actor,
    businessId: input.businessId,
    changes: [
      {
        op: "put",
        target: { kind: "Resource", slug: input.name, definitionMode: "legacy" },
        content: input.schemaYaml,
      },
    ],
  });
  await input.reload();
  await input.reconcile?.();
  return { schema, write };
}

export function validateResourceSchemaYaml(schemaYaml: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(schemaYaml);
  } catch (error) {
    throw new ResourceSchemaAuthoringError(
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ResourceSchemaAuthoringError("schema must be a YAML object (JSON Schema)");
  }
  if (!ajv.validateSchema(parsed)) {
    const error = ajv.errors?.[0];
    throw new ResourceSchemaAuthoringError(
      `${error?.instancePath || "(root)"} ${error?.message ?? "invalid JSON Schema"}`.trim()
    );
  }
  try {
    validateResourceSchema(parsed as Record<string, unknown>);
  } catch (error) {
    if (error instanceof TulipFarmValidationError) {
      throw new ResourceSchemaAuthoringError(error.message);
    }
    throw error;
  }
  return parsed as Record<string, unknown>;
}
