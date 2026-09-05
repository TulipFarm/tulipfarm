import { type Static, Type } from "@sinclair/typebox";
import { ROLE_ASSIGNMENT_TARGET_KINDS, type RoleAssignmentTargetKind } from "../teams";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const idPattern =
  "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-HJKMNP-TV-Z]{26})$";
// Grants match Tool vocabulary exactly; `_` and `-` are distinct and both allowed.
const slugPattern = "^[a-z][a-z0-9_]*(?:[-_][a-z0-9_]+)*$";
/** Grant vocabulary rejects unbounded authority and dead wildcards; not Tool IO vocabulary. */
const actionPattern = "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$";
// Rejects a literal `*` on axes the matcher compares literally. Absence is how "any" is expressed.
const notWildcardPattern = "^(?!\\*$).+$";
/** Resource types must be concrete one- or two-segment names; no bare or prefix wildcards. */
const resourcePattern = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)?$";
const domainPattern = `^(?:\\*|${slugPattern.slice(1, -1)})$`;
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);
const RoleAssignmentTargetKindSchema = Type.Unsafe<RoleAssignmentTargetKind>({
  type: "string",
  enum: [...ROLE_ASSIGNMENT_TARGET_KINDS],
});

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
    types: Type.Array(Type.String({ pattern: resourcePattern }), {
      minItems: 1,
      uniqueItems: true,
    }),
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
    /** Required so authors name grant scope; omission would compile to wildcard authority. */
    resource: ResourceSelectorSchema,
    fields: Type.Optional(
      Type.Array(Type.String({ minLength: 1, pattern: notWildcardPattern }), {
        minItems: 1,
        uniqueItems: true,
      })
    ),
    dataClasses: Type.Optional(
      Type.Array(Type.String({ pattern: slugPattern }), { minItems: 1, uniqueItems: true })
    ),
    domains: Type.Optional(
      Type.Array(Type.String({ pattern: domainPattern }), { minItems: 1, uniqueItems: true })
    ),
    destinations: Type.Optional(
      Type.Array(Type.String({ minLength: 1, pattern: notWildcardPattern }), {
        minItems: 1,
        uniqueItems: true,
      })
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
        principalTypes: Type.Array(RoleAssignmentTargetKindSchema, {
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
