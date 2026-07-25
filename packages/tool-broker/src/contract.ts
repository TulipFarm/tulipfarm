import type { ToolContractDefinition, ToolContractSpec } from "@tulipfarm/schema";

export interface PublishedToolContract
  extends Omit<
    ToolContractSpec,
    "requiredActions" | "requiredResources" | "dataClasses" | "allowedDestinations"
  > {
  readonly definitionId: string;
  readonly authoredVersion: number;
  readonly publishedDigest: string;
  readonly requiredActions: readonly string[];
  readonly requiredResources: readonly string[];
  readonly dataClasses: readonly string[];
  readonly allowedDestinations: readonly string[];
}

export type ToolContractRef = `${string}@${string}`;

export function toolContractRef(toolId: string, toolVersion: string): ToolContractRef {
  return `${toolId}@${toolVersion}`;
}

function freezeSchema(schema: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(structuredClone(schema));
}

export function publishToolContract(definition: ToolContractDefinition): PublishedToolContract {
  const digest = definition.metadata.publishedDigest;
  const ref = toolContractRef(definition.spec.toolId, definition.spec.toolVersion);
  if (
    digest === undefined ||
    (definition.metadata.lifecycle !== "published" && definition.metadata.lifecycle !== "active")
  ) {
    throw new Error(`contract_not_published:${ref}`);
  }

  const spec = definition.spec;
  return Object.freeze({
    ...spec,
    definitionId: definition.metadata.id,
    authoredVersion: definition.metadata.authoredVersion,
    publishedDigest: digest,
    inputSchema: freezeSchema(spec.inputSchema),
    outputSchema: freezeSchema(spec.outputSchema),
    errorSchema: spec.errorSchema === undefined ? undefined : freezeSchema(spec.errorSchema),
    requiredActions: Object.freeze([...(spec.requiredActions ?? [])]),
    requiredResources: Object.freeze([...(spec.requiredResources ?? [])]),
    dataClasses: Object.freeze([...(spec.dataClasses ?? [])]),
    allowedDestinations: Object.freeze([...(spec.allowedDestinations ?? [])]),
    idempotency: Object.freeze({ ...spec.idempotency }),
    timeout: spec.timeout === undefined ? undefined : Object.freeze({ ...spec.timeout }),
    retry: spec.retry === undefined ? undefined : Object.freeze({ ...spec.retry }),
    compensation:
      spec.compensation === undefined ? undefined : Object.freeze({ ...spec.compensation }),
    adapter: Object.freeze({ ...spec.adapter }),
  });
}
