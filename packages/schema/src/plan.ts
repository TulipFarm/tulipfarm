import { type Static, Type } from "@sinclair/typebox";
import { DEFINITION_API_VERSION, SLUG_PATTERN } from "./definitions/enums";
import { SchemaRegistry, type ValidatedSchemaDocument } from "./registry";

export const YAML_PLAN_MAX_BYTES = 128 * 1024;
export const YAML_PLAN_MAX_STEPS = 64;

const nonEmptyString = Type.String({ minLength: 1 });
const stepId = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" });
const reference = Type.Object(
  { name: nonEmptyString, version: nonEmptyString },
  { additionalProperties: false }
);
const sharedStep = {
  id: stepId,
  label: Type.Optional(nonEmptyString),
  needs: Type.Optional(Type.Array(stepId, { uniqueItems: true, maxItems: YAML_PLAN_MAX_STEPS })),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { additionalProperties: false })),
};

export const PlanStepSchema = Type.Union([
  Type.Object({ ...sharedStep, tool: nonEmptyString }, { additionalProperties: false }),
  Type.Object(
    {
      ...sharedStep,
      agent: reference,
      prompt: nonEmptyString,
      requiredToolCalls: Type.Optional(Type.Array(nonEmptyString, { minItems: 1 })),
      output: Type.Optional(Type.Unknown({ type: "object", additionalProperties: true })),
    },
    { additionalProperties: false }
  ),
  Type.Object({ ...sharedStep, routine: reference }, { additionalProperties: false }),
]);

export const PlanDefinitionSchema = Type.Object(
  {
    apiVersion: Type.Literal(DEFINITION_API_VERSION),
    kind: Type.Literal("Plan"),
    name: Type.String({ pattern: SLUG_PATTERN, maxLength: 128 }),
    version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    steps: Type.Array(PlanStepSchema, { minItems: 1, maxItems: YAML_PLAN_MAX_STEPS }),
  },
  { $id: `${DEFINITION_API_VERSION}/Plan`, additionalProperties: false }
);

export type PlanDefinition = Static<typeof PlanDefinitionSchema>;
export type PlanStep = Static<typeof PlanStepSchema>;
export interface ValidatedPlanDocument extends ValidatedSchemaDocument {
  document: Readonly<PlanDefinition>;
}

export const PlanSchemaRegistration = {
  apiVersion: DEFINITION_API_VERSION,
  kind: "Plan",
  schema: PlanDefinitionSchema,
};

let registry: SchemaRegistry | undefined;

/** Validates the closed Plan shape; the Run kernel proves dependency and expression semantics. */
export function validatePlanDefinition(document: unknown): ValidatedPlanDocument {
  registry ??= new SchemaRegistry([PlanSchemaRegistration]);
  return registry.validate(document) as ValidatedPlanDocument;
}
