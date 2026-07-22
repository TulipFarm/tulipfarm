import { SchemaRegistry, type ValidatedSchemaDocument } from "../registry";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
  refListSchema,
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

const nonEmptyString = { type: "string", minLength: 1 } as const;
const positiveInteger = { type: "integer", minimum: 1 } as const;
const stateName = { type: "string", minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_]*$" } as const;

// An authored JSON Schema fragment (opaque here; validated as a schema by later stages).
const jsonSchemaObject = { type: "object", additionalProperties: true } as const;

const definitionRef = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version"],
  properties: { id: nonEmptyString, name: nonEmptyString, version: nonEmptyString },
} as const;

const retryPolicy = {
  type: "object",
  additionalProperties: false,
  required: ["maxAttempts"],
  properties: {
    maxAttempts: { type: "integer", minimum: 1, maximum: MAX_RETRY_ATTEMPTS },
    backoffMs: { type: "integer", minimum: 0 },
    multiplier: { type: "number", minimum: 1 },
  },
} as const;

const stateLimits = {
  type: "object",
  additionalProperties: false,
  properties: {
    wallClockMs: positiveInteger,
    activeMs: positiveInteger,
    tokens: positiveInteger,
    costUsd: { type: "number", minimum: 0 },
    iterations: positiveInteger,
    fanOut: positiveInteger,
    parallelism: positiveInteger,
    artifactBytes: positiveInteger,
    resultRows: positiveInteger,
    networkBytes: positiveInteger,
    sideEffects: { type: "integer", minimum: 0 },
  },
} as const;

const onErrorHandler = {
  type: "object",
  additionalProperties: false,
  required: ["errorRef"],
  properties: {
    errorRef: nonEmptyString,
    transition: stateName,
    end: { type: "boolean" },
    compensateWith: nonEmptyString,
  },
} as const;

// Fields shared by every typed State.
const sharedStateProps = {
  name: stateName,
  transition: stateName,
  end: { type: "boolean" },
  input: { type: "object", additionalProperties: true },
  output: jsonSchemaObject,
  onError: { type: "array", items: onErrorHandler },
  retry: retryPolicy,
  limits: stateLimits,
  concurrencyKey: nonEmptyString,
  deadlineMs: positiveInteger,
  wallClockMs: positiveInteger,
  identity: {
    type: "object",
    additionalProperties: false,
    required: ["principalKind", "principalId"],
    properties: { principalKind: nonEmptyString, principalId: nonEmptyString },
  },
  permissionCeiling: {
    type: "object",
    additionalProperties: false,
    properties: {
      grants: refListSchema,
      maxRiskClass: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
  retention: {
    type: "object",
    additionalProperties: false,
    properties: { resultDays: positiveInteger, evidenceDays: positiveInteger },
  },
  observability: {
    type: "object",
    additionalProperties: false,
    required: ["level"],
    properties: {
      level: { type: "string", enum: ["minimal", "standard", "detailed"] },
      captureInputs: { type: "boolean" },
      captureOutputs: { type: "boolean" },
    },
  },
} as const;

const sharedStateRequired = ["type", "name"] as const;

function state(
  type: RoutineStateType,
  extraProps: Record<string, unknown>,
  extraRequired: readonly string[] = []
) {
  return {
    type: "object",
    additionalProperties: false,
    required: [...sharedStateRequired, ...extraRequired],
    properties: {
      type: { const: type },
      ...sharedStateProps,
      ...extraProps,
    },
  } as const;
}

const stateVariants = [
  state(
    "agent",
    { agentRef: definitionRef, maxRepairAttempts: { type: "integer", minimum: 0, maximum: 10 } },
    ["agentRef"]
  ),
  state(
    "tool",
    {
      toolRef: definitionRef,
      action: nonEmptyString,
      destination: nonEmptyString,
      credentialRef: nonEmptyString,
    },
    ["toolRef", "action"]
  ),
  state(
    "branch",
    {
      conditions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["condition"],
          properties: {
            condition: nonEmptyString,
            transition: stateName,
            end: { type: "boolean" },
          },
        },
      },
      default: {
        type: "object",
        additionalProperties: false,
        properties: { transition: stateName, end: { type: "boolean" } },
      },
    },
    ["conditions"]
  ),
  state(
    "parallel",
    {
      branches: { type: "array", minItems: 1, items: stateName },
      maxConcurrency: positiveInteger,
      join: { type: "string", enum: ["all", "any", "quorum"] },
    },
    ["branches", "maxConcurrency"]
  ),
  state(
    "foreach",
    {
      items: nonEmptyString,
      body: stateName,
      maxItems: positiveInteger,
      maxConcurrency: positiveInteger,
    },
    ["items", "maxItems", "maxConcurrency"]
  ),
  state(
    "repeat_until",
    {
      condition: nonEmptyString,
      body: stateName,
      maxIterations: positiveInteger,
      maxDurationMs: positiveInteger,
    },
    ["condition", "maxIterations", "maxDurationMs"]
  ),
  state(
    "wait",
    {
      waitFor: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["timer", "event"] },
          durationMs: positiveInteger,
          eventType: nonEmptyString,
          eventVersion: positiveInteger,
          correlation: nonEmptyString,
          aggregation: { type: "string", enum: ["first", "all", "quorum", "window"] },
        },
      },
    },
    ["waitFor"]
  ),
  state("approval", { approverRoles: { type: "array", minItems: 1, items: nonEmptyString } }, [
    "approverRoles",
  ]),
  state("human_task", { assigneeRoles: { type: "array", minItems: 1, items: nonEmptyString } }, [
    "assigneeRoles",
  ]),
  state("form", { formRef: definitionRef }, ["formRef"]),
  state(
    "child_routine",
    { routineRef: definitionRef, mode: { type: "string", enum: ["wait", "detach"] } },
    ["routineRef", "mode"]
  ),
  state("compensate", { targetRef: nonEmptyString, forState: stateName }, ["targetRef"]),
];

export const RoutineDefinitionSchema = {
  $id: `${apiVersion}/${kind}`,
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "spec"],
  properties: {
    apiVersion: { const: apiVersion },
    kind: { const: kind },
    metadata: definitionMetadataSchema,
    spec: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "start", "states"],
      properties: {
        owner: nonEmptyString,
        maintainers: refListSchema,
        input: jsonSchemaObject,
        output: jsonSchemaObject,
        start: stateName,
        states: { type: "array", minItems: 1, items: { oneOf: stateVariants } },
        requiredToolAbilities: { type: "array", items: nonEmptyString },
        limits: stateLimits,
        concurrency: {
          type: "object",
          additionalProperties: false,
          required: ["key", "policy"],
          properties: {
            key: nonEmptyString,
            policy: { type: "string", enum: [...ROUTINE_CONCURRENCY_POLICIES] },
            max: positiveInteger,
          },
        },
        compensation: {
          type: "object",
          additionalProperties: false,
          required: ["policy"],
          properties: { policy: { type: "string", enum: ["none", "explicit", "on_failure"] } },
        },
      },
    },
  },
} as const;

export interface RoutineState {
  type: RoutineStateType;
  name: string;
  [key: string]: unknown;
}

export interface RoutineDefinition {
  apiVersion: typeof apiVersion;
  kind: typeof kind;
  metadata: DefinitionMetadata;
  spec: {
    owner: string;
    maintainers?: string[];
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    start: string;
    states: RoutineState[];
    requiredToolAbilities?: string[];
    [key: string]: unknown;
  };
}

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
