import { type Static, Type } from "@sinclair/typebox";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../principals";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const idPattern =
  "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-HJKMNP-TV-Z]{26})$";
// Admits `_` as well as `-`: grants are written against Tool vocabulary, and those strings carry
// snake_case segments (`soul.resource_type`) plus vocabulary imported verbatim from third-party
// OpenAPI operations. No separator canonicalization happens when grants are compared, so authors
// must copy the Tool's exact action/resource string; `soul.resource_type` and `soul.resource-type`
// are intentionally distinct.
const slugPattern = "^[a-z][a-z0-9_]*(?:[-_][a-z0-9_]+)*$";
/**
 * Grant vocabulary. Two distinct rules govern the axes below — keep them apart, they pull opposite
 * ways:
 *
 * 1. **No unbounded authority.** An authored Role must not be able to express `actions: ["*"]` or
 *    `resource.types: ["*"]`. This is deliberate (see the `rejects wildcard authority` contract
 *    test): authored roles enumerate, so least privilege is the default and HR/engineering
 *    separation is expressed explicitly. The built-in deployment catalog in
 *    `apps/api/src/identity/roles.ts` *is* coarse — 35 of its grants use `actions: ["*"]` — but that
 *    is reviewed code, not user input, and it is not required to round-trip through this schema.
 *    Rejection here fails **loudly** at authoring time, so it is safe.
 *
 * 2. **No dead grants.** `grantMatches` (`packages/authz/src/grants.ts`) honours a bare `*` only for
 *    `action`, `resourceType`, `recordSelector` and `domain`; every other axis is compared
 *    literally, and on those axes *absence* already means "covers anything". So `record.*`,
 *    `tool.*`, `fields: ["*"]` and `destinations: ["*"]` would each match nothing at all. Under
 *    default-deny that is a grant an admin believes they authored which silently denies every call —
 *    the dangerous case, because it is invisible. These must fail loudly too.
 *
 * Deliberately NOT the same as `ACTION_NAME_PATTERN` / `RESOURCE_NAME_PATTERN` in
 * `packages/tool-broker/src/define.ts`. Those validate what a *Tool declares it touches*; these name
 * *what a grant covers*.
 */
const actionPattern = "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$";
// Rejects a literal `*` on axes the matcher compares literally. Absence is how "any" is expressed.
const notWildcardPattern = "^(?!\\*$).+$";
/**
 * Both rules above land on this one axis, in opposite directions:
 *
 *   - `*` is REJECTED under rule 1. It is the only wildcard `grantMatches` honours, which is
 *     precisely why an authored Role may not use it — `{ type: "*" }` is unbounded authority. The
 *     built-in catalog does use it, but that is reviewed code and never round-trips through here.
 *   - `record.*` / `tool.*` are REJECTED under rule 2. The matcher compares them literally against
 *     a type that can never exist, so the grant silently matches nothing. If prefix wildcards are
 *     ever wanted, `grantMatches` must implement them first and this pattern relaxed with it.
 *
 * So the axis admits exactly one thing: a concrete one- or two-segment resource name.
 */
const resourcePattern = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)?$";
const domainPattern = `^(?:\\*|${slugPattern.slice(1, -1)})$`;
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);
const PrincipalKindSchema = Type.Unsafe<PrincipalKind>({
  type: "string",
  enum: [...PRINCIPAL_KINDS],
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
    /**
     * Required, and deliberately so. `resource.types: ["*"]` is rejected by `resourcePattern`
     * because an unbounded grant must fail loudly rather than be authored by accident. Making the
     * whole block optional reopened exactly that hole through a quieter door: the compiler
     * substitutes `["*"]` for an absent selector, and `grantMatches` honours `*` on the
     * resourceType axis as a true wildcard — so omitting `resource` produced a grant row
     * byte-identical to the one the pattern refuses. An author must now name what a grant is over.
     */
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
        principalTypes: Type.Array(PrincipalKindSchema, {
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
