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
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const GrantConditionSchema = Type.Object(
  {
    attribute: Type.String({ pattern: "^[a-z][A-Za-z0-9]*(?:\\.[a-z][A-Za-z0-9]*)*$" }),
    operator: Type.Union([
      Type.Literal("equals"),
      Type.Literal("notEquals"),
      Type.Literal("in"),
      Type.Literal("notIn"),
    ]),
    value: Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    ]),
  },
  { additionalProperties: false }
);

const ResourceSelectorSchema = Type.Object(
  {
    types: Type.Array(Type.String({ pattern: slugPattern }), { minItems: 1, uniqueItems: true }),
    recordIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
  },
  { additionalProperties: false }
);

export const RoleGrantSchema = Type.Object(
  {
    effect: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    actions: Type.Array(Type.String({ pattern: actionPattern }), {
      minItems: 1,
      uniqueItems: true,
    }),
    resource: Type.Optional(ResourceSelectorSchema),
    fields: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    dataClasses: Type.Optional(
      Type.Array(Type.String({ pattern: slugPattern }), { minItems: 1, uniqueItems: true })
    ),
    destinations: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    audiences: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    conditions: Type.Optional(Type.Array(GrantConditionSchema, { minItems: 1 })),
    expiresAt: Type.Optional(Type.String({ pattern: dateTimePattern })),
    delegable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const RoleSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Role"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        principalTypes: Type.Array(Type.Union([Type.Literal("user"), Type.Literal("agent")]), {
          minItems: 1,
          uniqueItems: true,
        }),
        inherits: Type.Optional(
          Type.Array(Type.String({ pattern: idPattern }), { minItems: 1, uniqueItems: true })
        ),
        grants: Type.Array(RoleGrantSchema),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Role`, additionalProperties: false }
);
export const ROLE_DEFINITION = definitionRegistration("Role", RoleSchema);

export type RoleDefinition = Static<typeof RoleSchema>;
export type RoleGrant = Static<typeof RoleGrantSchema>;
