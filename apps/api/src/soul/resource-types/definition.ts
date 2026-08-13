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

/**
 * Validates a `resource.yaml` envelope before it is written, returning the failure message or
 * `undefined`.
 *
 * The route/tool schema gate (`validateResourceSchema`) is laxer than the envelope's `recordSchema`,
 * which requires `type: "object"` *and* `properties`. That mismatch used to be survivable: the
 * loader swallowed an invalid envelope and fell back to treating the file as a bare record schema,
 * silently losing `spec.domain`. Now the loader fails loudly — correct, but it means writing an
 * envelope the loader rejects would break Soul boot for everyone. So writers check with the same
 * registry the loader uses: alignment by construction, not a copied re-implementation that drifts.
 */
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
