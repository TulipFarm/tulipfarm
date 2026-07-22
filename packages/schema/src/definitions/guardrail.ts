import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const slugPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const actionPattern = "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$";
const dateTimePattern =
  "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$";

const GuardrailConditionSchema = Type.Object(
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

const GuardrailScopeSchema = Type.Object(
  {
    resource: Type.Optional(
      Type.Object(
        {
          types: Type.Array(Type.String({ pattern: slugPattern }), {
            minItems: 1,
            uniqueItems: true,
          }),
          recordIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
          ),
          fields: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
          ),
        },
        { additionalProperties: false }
      )
    ),
    conditions: Type.Optional(Type.Array(GuardrailConditionSchema, { minItems: 1 })),
    expiresAt: Type.Optional(Type.String({ pattern: dateTimePattern })),
  },
  { additionalProperties: false }
);

const GuardrailConstraintsSchema = Type.Object(
  {
    maxRecords: Type.Optional(Type.Integer({ minimum: 1 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0.01 })),
    timeWindow: Type.Optional(
      Type.Object(
        {
          startsAt: Type.String({ pattern: dateTimePattern }),
          expiresAt: Type.String({ pattern: dateTimePattern }),
        },
        { additionalProperties: false }
      )
    ),
    network: Type.Optional(
      Type.Object(
        {
          allowedHosts: Type.Array(
            Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$" }),
            { minItems: 1, uniqueItems: true }
          ),
          allowPrivateNetworks: Type.Literal(false),
        },
        { additionalProperties: false }
      )
    ),
    executionEnvironments: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("sandbox"),
          Type.Literal("managedAdapter"),
          Type.Literal("externalProtocol"),
        ]),
        { minItems: 1, uniqueItems: true }
      )
    ),
  },
  { additionalProperties: false }
);

const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

const ScopedRuleSchema = Type.Object(
  {
    id: Type.String({ pattern: slugPattern }),
    type: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    actions: Type.Array(Type.String({ pattern: actionPattern }), {
      minItems: 1,
      uniqueItems: true,
    }),
    dataClasses: Type.Optional(
      Type.Array(Type.String({ pattern: slugPattern }), { minItems: 1, uniqueItems: true })
    ),
    destinations: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    audiences: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    scope: Type.Optional(GuardrailScopeSchema),
    constraints: Type.Optional(GuardrailConstraintsSchema),
  },
  { additionalProperties: false }
);

const ApprovalRuleSchema = Type.Object(
  {
    id: Type.String({ pattern: slugPattern }),
    type: Type.Literal("approval"),
    actions: Type.Array(Type.String({ pattern: actionPattern }), {
      minItems: 1,
      uniqueItems: true,
    }),
    category: Type.Union([
      Type.Literal("soulChange"),
      Type.Literal("highRiskAction"),
      Type.Literal("destructiveAction"),
      Type.Literal("protectedDataEgress"),
      Type.Literal("credentialUse"),
    ]),
    minimumApprovers: Type.Integer({ minimum: 1, maximum: 10 }),
    separationOfDuties: Type.Boolean(),
    scope: Type.Optional(GuardrailScopeSchema),
    constraints: Type.Optional(GuardrailConstraintsSchema),
  },
  { additionalProperties: false }
);

const DlpRuleSchema = Type.Object(
  {
    id: Type.String({ pattern: slugPattern }),
    type: Type.Literal("dlp"),
    detectors: Type.Array(
      Type.Union([
        Type.Object({ type: Type.Literal("secret") }, { additionalProperties: false }),
        Type.Object(
          {
            type: Type.Literal("dataClass"),
            values: Type.Array(Type.String({ pattern: slugPattern }), {
              minItems: 1,
              uniqueItems: true,
            }),
          },
          { additionalProperties: false }
        ),
        Type.Object(
          {
            type: Type.Literal("protectedField"),
            values: Type.Array(Type.String({ minLength: 1 }), {
              minItems: 1,
              uniqueItems: true,
            }),
          },
          { additionalProperties: false }
        ),
      ]),
      { minItems: 1 }
    ),
    action: Type.Union([
      Type.Literal("block"),
      Type.Literal("redact"),
      Type.Literal("requireApproval"),
    ]),
    destinations: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    audiences: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })
    ),
    scope: Type.Optional(GuardrailScopeSchema),
    constraints: Type.Optional(GuardrailConstraintsSchema),
  },
  { additionalProperties: false }
);

export const GuardrailSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Guardrail"),
    metadata: MetadataSchema,
    spec: Type.Object(
      {
        defaultDecision: Type.Literal("deny"),
        rules: Type.Array(Type.Union([ScopedRuleSchema, ApprovalRuleSchema, DlpRuleSchema]), {
          minItems: 1,
        }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Guardrail`, additionalProperties: false }
);
export const GUARDRAIL_DEFINITION = definitionRegistration("Guardrail", GuardrailSchema);

export type GuardrailDefinition = Static<typeof GuardrailSchema>;
