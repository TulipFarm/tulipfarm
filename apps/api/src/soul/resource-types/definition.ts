import { randomUUID } from "node:crypto";
import {
  DEFINITION_API_VERSION,
  DEFINITION_REGISTRATIONS,
  type ResourceDefinition,
  SchemaRegistry,
} from "@tulipfarm/schema";
import type { SoulResource } from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";

export const RESOURCE_DOMAIN_RE = /^[a-z][a-z0-9_]*(?:[-_][a-z0-9_]+)*$/;

const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

/** Validate envelopes before writing because the loader rejects invalid envelopes. */
export function resourceEnvelopeError(yaml: string): string | undefined {
  try {
    definitionRegistry.validateYaml(yaml);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ResourceTypePayload {
  readonly name: string;
  readonly schema: string;
  readonly hasHooks: boolean;
  readonly domain?: string;
}

export function resourceTypePayload(resource: SoulResource): ResourceTypePayload {
  return {
    name: resource.name,
    schema: stringifyYaml(resource.schema),
    hasHooks: resource.hasHooks,
    ...(resource.domain === undefined ? {} : { domain: resource.domain }),
  };
}

export function resourceDefinitionYaml(input: {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly domain: string;
  readonly hooksEnabled?: boolean;
}): string {
  const definition: ResourceDefinition = {
    apiVersion: DEFINITION_API_VERSION,
    kind: "Resource",
    metadata: {
      id: randomUUID(),
      slug: input.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "draft",
    },
    spec: {
      domain: input.domain,
      recordSchema: input.schema as ResourceDefinition["spec"]["recordSchema"],
      ...(input.hooksEnabled === undefined ? {} : { hooks: { enabled: input.hooksEnabled } }),
    },
  };
  return stringifyYaml(definition);
}
