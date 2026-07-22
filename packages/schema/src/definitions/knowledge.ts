import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const idPattern =
  "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-HJKMNP-TV-Z]{26})$";
const slugPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";
const digestPattern = "^[a-f0-9]{64}$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const LiveAccessControlSchema = Type.Object(
  {
    mode: Type.Literal("live"),
    maximumAgeSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  },
  { additionalProperties: false }
);

const SnapshotAccessControlSchema = Type.Object(
  {
    mode: Type.Literal("snapshot"),
    aclArtifactId: Type.String({ pattern: idPattern }),
    aclRevision: Type.String({ minLength: 1 }),
    maximumAgeSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  },
  { additionalProperties: false }
);

export const KnowledgeSourceSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("KnowledgeSource"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        integrationId: Type.String({ pattern: idPattern }),
        source: Type.Object(
          {
            provider: Type.String({ pattern: slugPattern }),
            externalId: Type.String({ minLength: 1 }),
            externalTenantId: Type.String({ minLength: 1 }),
            ownerExternalId: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false }
        ),
        accessControl: Type.Union([LiveAccessControlSchema, SnapshotAccessControlSchema]),
        classification: Type.Array(Type.String({ pattern: slugPattern }), {
          minItems: 1,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/KnowledgeSource`, additionalProperties: false }
);
export const KNOWLEDGE_SOURCE_DEFINITION = definitionRegistration(
  "KnowledgeSource",
  KnowledgeSourceSchema
);

export type KnowledgeSourceDefinition = Static<typeof KnowledgeSourceSchema>;

export const KnowledgeCaptureSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("KnowledgeCapture"),
    knowledgeSourceId: Type.String({ pattern: idPattern }),
    sourceRevision: Type.String({ minLength: 1 }),
    capturedAt: Type.String({ pattern: dateTimePattern }),
    contentHash: Type.String({ pattern: digestPattern }),
    aclRevision: Type.String({ minLength: 1 }),
  },
  { $id: `${apiVersion}/KnowledgeCapture`, additionalProperties: false }
);

export type KnowledgeCapture = Static<typeof KnowledgeCaptureSchema>;
