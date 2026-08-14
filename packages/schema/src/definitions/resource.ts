import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const domainPattern = "^[a-z][a-z0-9_]*(?:[-_][a-z0-9_]+)*$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

/** Open authored record schema; `validateResourceSchema` owns the closed `x-*` vocabulary. */
const RecordSchemaSchema = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Object({}, { additionalProperties: true }),
    required: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  },
  { additionalProperties: true }
);

/** Hooks code lives in companion `hooks.ts`; this only declares whether hooks run. */
const HooksSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });

export const ResourceSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Resource"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        domain: Type.Optional(Type.String({ pattern: domainPattern })),
        recordSchema: RecordSchemaSchema,
        hooks: Type.Optional(HooksSchema),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Resource`, additionalProperties: false }
);

export const RESOURCE_DEFINITION = definitionRegistration("Resource", ResourceSchema);

export type ResourceDefinition = Static<typeof ResourceSchema>;
export type ResourceSpec = ResourceDefinition["spec"];
