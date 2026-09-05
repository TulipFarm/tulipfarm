import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { SchemaRegistry, type ValidatedSchemaDocument } from "../registry";
import { TeamBusinessAssetOwnershipSchema } from "../teams";
import {
  DEFINITION_API_VERSION,
  definitionMetadataSchema,
  definitionRegistration,
  refListSchema,
  secretReferenceSchema,
} from "./common";
import { EmbeddedTriggerSchema } from "./trigger";

/** Routine schema: typed States, immutable outputs, and bounded loops/fan-out/retries. */

const apiVersion = DEFINITION_API_VERSION;
const kind = "Routine";

export const ROUTINE_STATE_TYPES = [
  "agent",
  "tool",
  "compute",
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
  "emit",
  "script",
  "action",
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
const PARALLEL_JOINS = ["all", "any", "quorum"] as const;
const WAIT_KINDS = ["timer", "event"] as const;
const WAIT_AGGREGATIONS = ["first", "all", "quorum", "window"] as const;
const CHILD_ROUTINE_MODES = ["wait", "detach"] as const;
const COMPENSATION_POLICIES = ["none", "explicit", "on_failure"] as const;

const nonEmptyString = Type.String({ minLength: 1 });
const positiveInteger = Type.Integer({ minimum: 1 });
const stateName = Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_]*$" });

// Opaque here; later stages validate this as JSON Schema.
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
    tokens: Type.Optional(positiveInteger),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    iterations: Type.Optional(positiveInteger),
    fanOut: Type.Optional(positiveInteger),
    parallelism: Type.Optional(positiveInteger),
    retries: Type.Optional(Type.Integer({ minimum: 0 })),
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

/**
 * Fields every State type shares.
 *
 * Deliberately absent, and rejected by `additionalProperties: false` if an author writes them:
 * a State-level `wallClockMs` (a third spelling of `limits.wallClockMs`, which is where a
 * per-State wall-clock budget belongs), `retention`, and `observability`. All three validated and
 * compiled to nothing — no purge path and no capture gate exists to read them — and a config key
 * that silently does nothing is a worse contract than one that fails. They return with their
 * implementations, not before.
 */
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
  /**
   * Derives values from expressions alone — no model, no Tool, no effect.
   *
   * `input` is the assignment map and is required here, unlike every other State type: a
   * `compute` that assigns nothing has no reason to exist, and an author who wrote one meant
   * something else. Each resolved key becomes a field of the State's output, which downstream
   * States read as `${states.<name>.output.<key>}`.
   */
  state("compute", {
    input: Type.Unknown({ type: "object", additionalProperties: true, minProperties: 1 }),
  }),
  /**
   * Runs authored TypeScript in an isolated VM: no network, no filesystem, no host reach, frozen
   * clock. Whatever the function returns becomes the State's output.
   *
   * The isolate is deliberately sealed, so a `script` State cannot fetch anything itself. Reaching
   * a provider is an `action` State's job, and this State transforms what that returned.
   */
  state("script", {
    /** A module expression exporting the named function, e.g. `({ run(ctx, input) { ... } })`. */
    script: nonEmptyString,
    /** Which exported function to call. Defaults to `run`. */
    entry: Type.Optional(nonEmptyString),
  }),
  /**
   * Calls one runtime Tool directly — no model in the loop. `action` names the Tool
   * (`record_create`, `record_search`, `api_request`, `send_slack_message`, ...) and `input` is its
   * arguments. What the Tool returned becomes the State's output.
   */
  state("action", {
    action: nonEmptyString,
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
  /**
   * Announces an internal event, which any published `internal_event` Trigger may bind to a Run.
   *
   * The shared `input` map is the event payload, exactly as it is for `compute`. `emit` starts
   * Runs; it never waits for one. A Routine that needs an answer calls `child_routine` instead.
   */
  state("emit", {
    event: Type.Object(
      {
        type: nonEmptyString,
        version: Type.Optional(positiveInteger),
      },
      { additionalProperties: false }
    ),
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
        ownership: Type.Optional(TeamBusinessAssetOwnershipSchema),
        maintainers: Type.Optional(refListSchema),
        input: Type.Optional(jsonSchemaObject),
        output: Type.Optional(jsonSchemaObject),
        start: stateName,
        states: Type.Array(stateUnionSchema, { minItems: 1 }),
        triggers: Type.Optional(Type.Array(EmbeddedTriggerSchema)),
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

/** Validate a Routine definition through the registry. */
export function validateRoutineDefinition(document: unknown): ValidatedRoutineDocument {
  registry ??= new SchemaRegistry([RoutineSchemaRegistration]);
  return registry.validate(document) as ValidatedRoutineDocument;
}
