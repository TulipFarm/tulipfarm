import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { SchemaRegistry, type ValidatedSchemaDocument } from "../registry";
import {
  DEFINITION_API_VERSION,
  definitionMetadataSchema,
  definitionRegistration,
  refListSchema,
  secretReferenceSchema,
} from "./common";

/**
 * Routine definition meta-schema (SPEC §7.1, §9.1). A Routine is a versioned automation
 * definition with an input/output schema and a typed State graph. State outputs are
 * immutable typed values; there is no mutable global Routine Context (SPEC invariant 8).
 *
 * Bounds are enforced structurally so no authored Routine can express an unbounded
 * loop, fan-out, or retry (SPEC §9.1):
 * - `foreach` requires both a `maxItems` bound and a `maxConcurrency` cap.
 * - `repeat_until` requires both a `maxIterations` and a `maxDurationMs` bound.
 * - `parallel` requires a `maxConcurrency` cap over its branches.
 * - a retry policy requires a bounded `maxAttempts`.
 */

const apiVersion = DEFINITION_API_VERSION;
const kind = "Routine";

export const ROUTINE_STATE_TYPES = [
  "agent",
  "tool",
  "branch",
  "parallel",
  "foreach",
  "repeat_until",
  "wait",
  "approval",
  "human_task",
  "form",
  "child_routine",
  "compensate",
] as const;
export type RoutineStateType = (typeof ROUTINE_STATE_TYPES)[number];

export const ROUTINE_CONCURRENCY_POLICIES = [
  "serialize",
  "parallel",
  "queue",
  "coalesce",
  "reject",
  "supersede",
] as const;

const MAX_RETRY_ATTEMPTS = 100;

const RISK_CLASSES = ["low", "medium", "high"] as const;
const OBSERVABILITY_LEVELS = ["minimal", "standard", "detailed"] as const;
const PARALLEL_JOINS = ["all", "any", "quorum"] as const;
const WAIT_KINDS = ["timer", "event"] as const;
const WAIT_AGGREGATIONS = ["first", "all", "quorum", "window"] as const;
const CHILD_ROUTINE_MODES = ["wait", "detach"] as const;
const COMPENSATION_POLICIES = ["none", "explicit", "on_failure"] as const;

const nonEmptyString = Type.String({ minLength: 1 });
const positiveInteger = Type.Integer({ minimum: 1 });
const stateName = Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_]*$" });

// An authored JSON Schema fragment (opaque here; validated as a schema by later stages).
const jsonSchemaObject = Type.Unknown({ type: "object", additionalProperties: true });

const definitionRef = Type.Object(
  {
    id: Type.Optional(nonEmptyString),
    name: nonEmptyString,
    version: nonEmptyString,
  },
  { additionalProperties: false }
);

const retryPolicy = Type.Object(
  {
    maxAttempts: Type.Integer({ minimum: 1, maximum: MAX_RETRY_ATTEMPTS }),
    backoffMs: Type.Optional(Type.Integer({ minimum: 0 })),
    multiplier: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false }
);

const stateLimits = Type.Object(
  {
    wallClockMs: Type.Optional(positiveInteger),
    activeMs: Type.Optional(positiveInteger),
    tokens: Type.Optional(positiveInteger),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    iterations: Type.Optional(positiveInteger),
    fanOut: Type.Optional(positiveInteger),
    parallelism: Type.Optional(positiveInteger),
    artifactBytes: Type.Optional(positiveInteger),
    resultRows: Type.Optional(positiveInteger),
    networkBytes: Type.Optional(positiveInteger),
    sideEffects: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

const onErrorHandler = Type.Object(
  {
    errorRef: nonEmptyString,
    transition: Type.Optional(stateName),
    end: Type.Optional(Type.Boolean()),
    compensateWith: Type.Optional(nonEmptyString),
  },
  { additionalProperties: false }
);

// Fields shared by every typed State.
const sharedStateProps = {
  name: stateName,
  transition: Type.Optional(stateName),
  end: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Unknown({ type: "object", additionalProperties: true })),
  output: Type.Optional(jsonSchemaObject),
  onError: Type.Optional(Type.Array(onErrorHandler)),
  retry: Type.Optional(retryPolicy),
  limits: Type.Optional(stateLimits),
  concurrencyKey: Type.Optional(nonEmptyString),
  deadlineMs: Type.Optional(positiveInteger),
  wallClockMs: Type.Optional(positiveInteger),
  identity: Type.Optional(
    Type.Object(
      {
        principalKind: nonEmptyString,
        principalId: nonEmptyString,
      },
      { additionalProperties: false }
    )
  ),
  permissionCeiling: Type.Optional(
    Type.Object(
      {
        grants: Type.Optional(refListSchema),
        maxRiskClass: Type.Optional(
          Type.Unsafe<(typeof RISK_CLASSES)[number]>({ type: "string", enum: [...RISK_CLASSES] })
        ),
      },
      { additionalProperties: false }
    )
  ),
  retention: Type.Optional(
    Type.Object(
      {
        resultDays: Type.Optional(positiveInteger),
        evidenceDays: Type.Optional(positiveInteger),
      },
      { additionalProperties: false }
    )
  ),
  observability: Type.Optional(
    Type.Object(
      {
        level: Type.Unsafe<(typeof OBSERVABILITY_LEVELS)[number]>({
          type: "string",
          enum: [...OBSERVABILITY_LEVELS],
        }),
        captureInputs: Type.Optional(Type.Boolean()),
        captureOutputs: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false }
    )
  ),
} satisfies Record<string, TSchema>;

function state<
  const StateType extends RoutineStateType,
  const ExtraProps extends Record<string, TSchema>,
>(type: StateType, extraProps: ExtraProps) {
  return Type.Object(
    {
      type: Type.Unsafe<StateType>({ const: type }),
      ...sharedStateProps,
      ...extraProps,
    },
    { additionalProperties: false }
  );
}

const stateVariants = [
  state("agent", {
    agentRef: definitionRef,
    maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  }),
  state("tool", {
    toolRef: definitionRef,
    action: nonEmptyString,
    destination: Type.Optional(nonEmptyString),
    credentialRef: Type.Optional(secretReferenceSchema),
  }),
  state("branch", {
    conditions: Type.Array(
      Type.Object(
        {
          condition: nonEmptyString,
          transition: Type.Optional(stateName),
          end: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false }
      ),
      { minItems: 1 }
    ),
    default: Type.Optional(
      Type.Object(
        {
          transition: Type.Optional(stateName),
          end: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false }
      )
    ),
  }),
  state("parallel", {
    branches: Type.Array(stateName, { minItems: 1 }),
    maxConcurrency: positiveInteger,
    join: Type.Optional(
      Type.Unsafe<(typeof PARALLEL_JOINS)[number]>({ type: "string", enum: [...PARALLEL_JOINS] })
    ),
  }),
  state("foreach", {
    items: nonEmptyString,
    body: Type.Optional(stateName),
    maxItems: positiveInteger,
    maxConcurrency: positiveInteger,
  }),
  state("repeat_until", {
    condition: nonEmptyString,
    body: Type.Optional(stateName),
    maxIterations: positiveInteger,
    maxDurationMs: positiveInteger,
  }),
  state("wait", {
    waitFor: Type.Object(
      {
        kind: Type.Unsafe<(typeof WAIT_KINDS)[number]>({ type: "string", enum: [...WAIT_KINDS] }),
        durationMs: Type.Optional(positiveInteger),
        eventType: Type.Optional(nonEmptyString),
        eventVersion: Type.Optional(positiveInteger),
        correlation: Type.Optional(nonEmptyString),
        aggregation: Type.Optional(
          Type.Unsafe<(typeof WAIT_AGGREGATIONS)[number]>({
            type: "string",
            enum: [...WAIT_AGGREGATIONS],
          })
        ),
      },
      { additionalProperties: false }
    ),
  }),
  state("approval", { approverRoles: Type.Array(nonEmptyString, { minItems: 1 }) }),
  state("human_task", { assigneeRoles: Type.Array(nonEmptyString, { minItems: 1 }) }),
  state("form", { formRef: definitionRef }),
  state("child_routine", {
    routineRef: definitionRef,
    mode: Type.Unsafe<(typeof CHILD_ROUTINE_MODES)[number]>({
      type: "string",
      enum: [...CHILD_ROUTINE_MODES],
    }),
  }),
  state("compensate", {
    targetRef: nonEmptyString,
    forState: Type.Optional(stateName),
  }),
] as const;

const stateUnionSchema = Type.Unsafe<Static<(typeof stateVariants)[number]>>({
  oneOf: stateVariants,
});

export const RoutineDefinitionSchema = Type.Object(
  {
    apiVersion: Type.Unsafe<typeof apiVersion>({ const: apiVersion }),
    kind: Type.Unsafe<typeof kind>({ const: kind }),
    metadata: definitionMetadataSchema,
    spec: Type.Object(
      {
        owner: nonEmptyString,
        maintainers: Type.Optional(refListSchema),
        input: Type.Optional(jsonSchemaObject),
        output: Type.Optional(jsonSchemaObject),
        start: stateName,
        states: Type.Array(stateUnionSchema, { minItems: 1 }),
        requiredToolAbilities: Type.Optional(Type.Array(nonEmptyString)),
        limits: Type.Optional(stateLimits),
        concurrency: Type.Optional(
          Type.Object(
            {
              key: nonEmptyString,
              policy: Type.Unsafe<(typeof ROUTINE_CONCURRENCY_POLICIES)[number]>({
                type: "string",
                enum: [...ROUTINE_CONCURRENCY_POLICIES],
              }),
              max: Type.Optional(positiveInteger),
            },
            { additionalProperties: false }
          )
        ),
        compensation: Type.Optional(
          Type.Object(
            {
              policy: Type.Unsafe<(typeof COMPENSATION_POLICIES)[number]>({
                type: "string",
                enum: [...COMPENSATION_POLICIES],
              }),
            },
            { additionalProperties: false }
          )
        ),
      },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/${kind}`, additionalProperties: false }
);

export type RoutineDefinition = Static<typeof RoutineDefinitionSchema>;
export type RoutineSpec = RoutineDefinition["spec"];
export type RoutineState = RoutineSpec["states"][number];

export interface ValidatedRoutineDocument extends ValidatedSchemaDocument {
  document: Readonly<RoutineDefinition>;
}

export const ROUTINE_DEFINITION = definitionRegistration(kind, RoutineDefinitionSchema);
export const RoutineSchemaRegistration = ROUTINE_DEFINITION;

let registry: SchemaRegistry | undefined;

/**
 * Validate a Routine definition. Returns the canonical validated document (typed) on
 * success; throws a `SchemaContractError` subtype on failure.
 */
export function validateRoutineDefinition(document: unknown): ValidatedRoutineDocument {
  registry ??= new SchemaRegistry([RoutineSchemaRegistration]);
  return registry.validate(document) as ValidatedRoutineDocument;
}
