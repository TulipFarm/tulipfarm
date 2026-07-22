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
const actionPattern = "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$";
const secretReferencePattern =
  "^secret://[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*$";
const httpsEndpointPattern =
  "^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$";
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const ManagedExecutionSchema = Type.Object(
  {
    mode: Type.Literal("managed"),
    adapter: Type.String({ pattern: slugPattern }),
  },
  { additionalProperties: false }
);

const ExternalExecutionSchema = Type.Object(
  {
    mode: Type.Literal("externalProtocol"),
    endpoint: Type.String({ pattern: httpsEndpointPattern }),
    protocolVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const IntegrationAdapterSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("IntegrationAdapter"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        provider: Type.String({ pattern: slugPattern }),
        execution: Type.Union([ManagedExecutionSchema, ExternalExecutionSchema]),
        authTypes: Type.Array(
          Type.Union([
            Type.Literal("none"),
            Type.Literal("oauth2"),
            Type.Literal("token"),
            Type.Literal("app"),
            Type.Literal("password"),
          ]),
          { minItems: 1, uniqueItems: true }
        ),
        operations: Type.Array(Type.String({ pattern: actionPattern }), {
          minItems: 1,
          uniqueItems: true,
        }),
        events: Type.Array(Type.String({ pattern: actionPattern }), { uniqueItems: true }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/IntegrationAdapter`, additionalProperties: false }
);

export const AppSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("App"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        adapterId: Type.String({ pattern: idPattern }),
        externalAppId: Type.String({ minLength: 1 }),
        credentialRefs: Type.Array(Type.String({ pattern: secretReferencePattern }), {
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/App`, additionalProperties: false }
);

export const IntegrationSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Integration"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        appId: Type.String({ pattern: idPattern }),
        externalAccount: Type.Object(
          {
            tenantId: Type.String({ minLength: 1 }),
            accountId: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false }
        ),
        credentialRef: Type.Optional(Type.String({ pattern: secretReferencePattern })),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Integration`, additionalProperties: false }
);

const PrincipalReferenceSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("role")]),
    id: Type.String({ pattern: idPattern }),
  },
  { additionalProperties: false }
);

const ExternalTargetSchema = Type.Object(
  {
    type: Type.String({ pattern: slugPattern }),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false }
);

export const AccessGrantSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("AccessGrant"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        integrationId: Type.String({ pattern: idPattern }),
        principals: Type.Array(PrincipalReferenceSchema, { minItems: 1 }),
        actions: Type.Array(Type.String({ pattern: actionPattern }), {
          minItems: 1,
          uniqueItems: true,
        }),
        externalTargets: Type.Array(ExternalTargetSchema, { minItems: 1 }),
        expiresAt: Type.Optional(Type.String({ pattern: dateTimePattern })),
        delegable: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/AccessGrant`, additionalProperties: false }
);

export const INTEGRATION_ADAPTER_DEFINITION = definitionRegistration(
  "IntegrationAdapter",
  IntegrationAdapterSchema
);
export const APP_DEFINITION = definitionRegistration("App", AppSchema);
export const INTEGRATION_DEFINITION = definitionRegistration("Integration", IntegrationSchema);
export const ACCESS_GRANT_DEFINITION = definitionRegistration("AccessGrant", AccessGrantSchema);

export type IntegrationAdapterDefinition = Static<typeof IntegrationAdapterSchema>;
export type AppDefinition = Static<typeof AppSchema>;
export type IntegrationDefinition = Static<typeof IntegrationSchema>;
export type AccessGrantDefinition = Static<typeof AccessGrantSchema>;
