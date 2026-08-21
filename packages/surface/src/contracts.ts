import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const TSP_PROTOCOL_VERSION = "1.0" as const;

export const SurfaceTargetSchema = Type.Union([
  Type.Object(
    { channel: Type.Literal("web"), surface: Type.Literal("chat") },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      channel: Type.Literal("slack"),
      surface: Type.Union([Type.Literal("message"), Type.Literal("modal")]),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      channel: Type.Literal("github"),
      surface: Type.Union([Type.Literal("comment"), Type.Literal("check-run")]),
    },
    { additionalProperties: false }
  ),
]);

export type SurfaceTarget = Static<typeof SurfaceTargetSchema>;
export type SurfaceChannel = SurfaceTarget["channel"];

export const SurfaceClassificationSchema = Type.Union([
  Type.Literal("public"),
  Type.Literal("internal"),
  Type.Literal("confidential"),
  Type.Literal("restricted"),
]);

export type SurfaceClassification = Static<typeof SurfaceClassificationSchema>;

export const SurfaceActionSchema = Type.Object(
  {
    event: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" }),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    disabled: Type.Optional(Type.Boolean()),
    stepUp: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type SurfaceAction = Static<typeof SurfaceActionSchema>;

export interface SurfaceEventDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
}

export interface SurfaceComponentDefinition<PropsSchema extends TSchema = TSchema> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly propsSchema: PropsSchema;
  readonly events: readonly SurfaceEventDefinition[];
  readonly examples: readonly unknown[];
}

export function defineSurfaceComponent<const PropsSchema extends TSchema>(
  definition: SurfaceComponentDefinition<PropsSchema>
): SurfaceComponentDefinition<PropsSchema> {
  for (const example of definition.examples) {
    if (!Value.Check(definition.propsSchema, example)) {
      const issue = [...Value.Errors(definition.propsSchema, example)][0];
      throw new Error(
        `Invalid ${definition.name}@${definition.version} example at ${issue?.path || "/"}`
      );
    }
  }
  return Object.freeze({
    ...definition,
    events: Object.freeze([...definition.events]),
    examples: Object.freeze([...definition.examples]),
  });
}

export const SurfaceArtifactSchema = Type.Object(
  {
    protocol: Type.Literal("tsp"),
    protocolVersion: Type.Literal(TSP_PROTOCOL_VERSION),
    id: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    component: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        version: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
    props: Type.Record(Type.String(), Type.Unknown()),
    target: SurfaceTargetSchema,
    catalogRevision: Type.String({ minLength: 1 }),
    audience: Type.Readonly(Type.Array(Type.String({ minLength: 1 }))),
    classification: SurfaceClassificationSchema,
    lineage: Type.Readonly(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);

type SurfaceArtifactWire = Static<typeof SurfaceArtifactSchema>;

export type SurfaceArtifact = Omit<SurfaceArtifactWire, "audience" | "lineage"> & {
  readonly audience: readonly string[];
  readonly lineage: readonly string[];
};

export interface SurfaceRenderIssue {
  readonly code: "artifact_invalid" | "component_unsupported" | "provider_limit" | "props_invalid";
  readonly path: string;
  readonly message: string;
}

export interface SurfaceRenderContext {
  readonly destination: string;
  readonly principal?: string;
  readonly actionHandleFor?: (action: SurfaceAction) => string;
}

export interface SurfaceRendererManifest {
  readonly renderer: string;
  readonly targets: readonly SurfaceTarget[];
  readonly components: Readonly<Record<string, readonly string[]>>;
  readonly providerLimits: Readonly<Record<string, number>>;
  readonly interactionCapabilities: readonly string[];
}

export interface SurfaceComponentSupport {
  supports(
    target: SurfaceTarget,
    component: { readonly name: string; readonly version: string }
  ): boolean;
}

export interface SurfaceRenderer<Output> {
  readonly target: SurfaceTarget;
  readonly manifest: SurfaceRendererManifest;
  preflight(artifact: SurfaceArtifact): readonly SurfaceRenderIssue[];
  render(artifact: SurfaceArtifact, context: SurfaceRenderContext): Output;
  update(previous: Output, artifact: SurfaceArtifact, context: SurfaceRenderContext): Output;
}

export interface PresentationContext {
  readonly target: SurfaceTarget;
  readonly destination: string;
  readonly rendererCapabilities: readonly string[];
}

const ISO_DATE_TIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

export const SurfaceInteractionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    artifactId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    event: Type.String({ minLength: 1 }),
    input: Type.Record(Type.String(), Type.Unknown()),
    principal: Type.String({ minLength: 1 }),
    target: SurfaceTargetSchema,
    destination: Type.String({ minLength: 1 }),
    occurredAt: Type.String({ pattern: ISO_DATE_TIME_PATTERN }),
  },
  { additionalProperties: false }
);

export type SurfaceInteraction = Static<typeof SurfaceInteractionSchema>;

export function targetKey(target: SurfaceTarget): string {
  return `${target.channel}/${target.surface}`;
}

export function sameTarget(left: SurfaceTarget, right: SurfaceTarget): boolean {
  return left.channel === right.channel && left.surface === right.surface;
}
