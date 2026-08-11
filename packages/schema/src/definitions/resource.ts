import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

/**
 * The authored JSON Schema describing one business Record.
 *
 * Deliberately open (`additionalProperties: true`): it carries the `x-*` authoring vocabulary
 * (`x-id-strategy`, `x-normalize`, `x-computed`, `x-links`) whose keys are checked against closed
 * sets by `validateResourceSchema`. Pinning the *structure* here and the *vocabulary* there keeps
 * one owner per concern — widening the vocabulary must not require touching this envelope.
 */
const RecordSchemaSchema = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Object({}, { additionalProperties: true }),
    required: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  },
  { additionalProperties: true }
);

/**
 * Record-lifecycle hooks live in a companion `hooks.ts` beside this definition. The definition
 * only declares *whether* they run; the code itself is content-addressed by the write gateway and
 * reviewed as executable content, never validated as configuration.
 */
const HooksSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });

export const ResourceSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Resource"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
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
