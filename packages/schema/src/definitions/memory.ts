import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
  MEMORY_SCOPES,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const EnabledInferredMemorySchema = Type.Object(
  {
    enabled: Type.Literal(true),
    confirmationRequired: Type.Literal(true),
  },
  { additionalProperties: false }
);

const DisabledInferredMemorySchema = Type.Object(
  { enabled: Type.Literal(false) },
  { additionalProperties: false }
);

export const MemorySettingsSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("MemorySettings"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        scopes: Type.Array(
          Type.Unsafe<(typeof MEMORY_SCOPES)[number]>({
            type: "string",
            enum: [...MEMORY_SCOPES],
          }),
          { minItems: 1, uniqueItems: true }
        ),
        inferredDurableMemory: Type.Union([
          EnabledInferredMemorySchema,
          DisabledInferredMemorySchema,
        ]),
        defaultExpiryDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/MemorySettings`, additionalProperties: false }
);
export const MEMORY_SETTINGS_DEFINITION = definitionRegistration(
  "MemorySettings",
  MemorySettingsSchema
);

export type MemorySettingsDefinition = Static<typeof MemorySettingsSchema>;
