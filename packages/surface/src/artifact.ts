import { Value } from "@sinclair/typebox/value";
import { canonicalHash } from "@tulipfarm/schema/canonicalize";
import { SHIPPED_CATALOG_REVISION, surfaceComponentFor } from "./catalog";
import {
  type SurfaceAction,
  SurfaceActionSchema,
  type SurfaceArtifact,
  SurfaceArtifactSchema,
  type SurfaceClassification,
  type SurfaceComponentDefinition,
  type SurfaceRendererManifest,
  type SurfaceRenderIssue,
  type SurfaceTarget,
  sameTarget,
} from "./contracts";
import { surfaceSchemaIssues } from "./schema";

export interface CreateSurfaceArtifactInput {
  readonly id: string;
  readonly revision?: number;
  readonly component: { readonly name: string; readonly version: string };
  readonly props: Readonly<Record<string, unknown>>;
  readonly target: SurfaceTarget;
  readonly catalogRevision?: string;
  readonly audience: readonly string[];
  readonly classification: SurfaceClassification;
  readonly lineage?: readonly string[];
  readonly catalog?: readonly SurfaceComponentDefinition[];
  readonly rendererManifest?: SurfaceRendererManifest;
}

export class SurfaceValidationError extends Error {
  readonly name = "SurfaceValidationError";

  constructor(readonly issues: readonly SurfaceRenderIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
}

function definitionFor(input: CreateSurfaceArtifactInput): SurfaceComponentDefinition | undefined {
  const shipped = surfaceComponentFor(input.component.name, input.component.version);
  if (shipped) return shipped;
  return input.catalog?.find(
    (definition) =>
      definition.name === input.component.name && definition.version === input.component.version
  );
}

export function validateSurfaceArtifact(
  artifact: SurfaceArtifact,
  catalog: readonly SurfaceComponentDefinition[] = [],
  rendererManifest?: SurfaceRendererManifest
): readonly SurfaceRenderIssue[] {
  const issues: SurfaceRenderIssue[] = [];
  if (!Value.Check(SurfaceArtifactSchema, artifact)) {
    for (const error of Value.Errors(SurfaceArtifactSchema, artifact)) {
      issues.push({
        code: "artifact_invalid",
        path: error.path || "/",
        message: error.message,
      });
    }
    return issues;
  }
  const definition =
    surfaceComponentFor(artifact.component.name, artifact.component.version) ??
    catalog.find(
      (candidate) =>
        candidate.name === artifact.component.name &&
        candidate.version === artifact.component.version
    );
  if (!definition) {
    issues.push({
      code: "component_unsupported",
      path: "/component",
      message: `Unknown component ${artifact.component.name}@${artifact.component.version}.`,
    });
    return issues;
  }
  const shipped = surfaceComponentFor(definition.name, definition.version) !== undefined;
  const targetMatches =
    rendererManifest?.targets.some((target) => sameTarget(target, artifact.target)) ?? true;
  const rendererSupports =
    !shipped ||
    rendererManifest === undefined ||
    rendererManifest.components[definition.name]?.includes(definition.version) === true;
  if (!targetMatches || !rendererSupports) {
    issues.push({
      code: "component_unsupported",
      path: "/target",
      message: `${definition.name}@${definition.version} does not support this target.`,
    });
  }
  for (const error of surfaceSchemaIssues(definition.propsSchema, artifact.props)) {
    issues.push({
      code: "props_invalid",
      path: `/props${error.path}`,
      message: error.message,
    });
  }
  return issues;
}

export function createSurfaceArtifact(input: CreateSurfaceArtifactInput): SurfaceArtifact {
  const definition = definitionFor(input);
  if (!definition) {
    throw new SurfaceValidationError([
      {
        code: "component_unsupported",
        path: "/component",
        message: `Unknown component ${input.component.name}@${input.component.version}.`,
      },
    ]);
  }
  const artifact = structuredClone({
    protocol: "tsp" as const,
    protocolVersion: "1.0" as const,
    id: input.id,
    revision: input.revision ?? 1,
    component: input.component,
    props: input.props,
    target: input.target,
    catalogRevision: input.catalogRevision ?? SHIPPED_CATALOG_REVISION,
    audience: input.audience,
    classification: input.classification,
    lineage: input.lineage ?? [],
  });
  const issues = validateSurfaceArtifact(artifact, input.catalog, input.rendererManifest);
  if (issues.length > 0) throw new SurfaceValidationError(issues);
  return Object.freeze(artifact);
}

export function updateSurfaceArtifact(
  previous: SurfaceArtifact,
  expectedRevision: number,
  props: Readonly<Record<string, unknown>>,
  catalog: readonly SurfaceComponentDefinition[] = [],
  rendererManifest?: SurfaceRendererManifest
): SurfaceArtifact {
  if (previous.revision !== expectedRevision) {
    throw new SurfaceValidationError([
      {
        code: "artifact_invalid",
        path: "/expectedRevision",
        message: `Expected revision ${expectedRevision}, found ${previous.revision}.`,
      },
    ]);
  }
  return createSurfaceArtifact({
    ...previous,
    revision: previous.revision + 1,
    props,
    catalog,
    rendererManifest,
    lineage: [...previous.lineage, `${previous.id}@${previous.revision}`],
  });
}

export function surfaceArtifactHash(artifact: SurfaceArtifact): string {
  return canonicalHash(artifact);
}

export function surfaceActionKey(action: SurfaceAction): string {
  return canonicalHash({
    event: action.event,
    payload: action.payload ?? {},
    stepUp: action.stepUp ?? false,
  });
}

export function surfaceActionsForArtifact(artifact: SurfaceArtifact): readonly SurfaceAction[] {
  const props = artifact.props as Record<string, unknown>;
  if (artifact.component.name === "Choices") {
    const action = props.action;
    const choices = props.choices;
    if (!Value.Check(SurfaceActionSchema, action) || !Array.isArray(choices)) return [];
    return [
      action,
      ...choices.flatMap((choice) => {
        if (typeof choice !== "object" || choice === null || !("value" in choice)) return [];
        return [{ ...action, payload: { ...action.payload, value: choice.value } }];
      }),
    ];
  }

  const actions: SurfaceAction[] = [];
  const visit = (value: unknown): void => {
    if (Value.Check(SurfaceActionSchema, value)) {
      actions.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    Object.values(value).forEach(visit);
  };
  visit(props);
  return actions;
}
