import { type Static, Type } from "@sinclair/typebox";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

/**
 * routine.yaml meta-schema (ROUT-V1-004/005, AC-V1-002). CNCF Serverless Workflow 0.8
 * subset + `x-` extensions. Deferred constructs (`parallel`/`event` states, `subFlowRef`,
 * `datetime`/`integration` triggers) are detected in a pre-pass and rejected with an
 * explicit "deferred in V1" error before AJV runs, so authors see the real reason instead
 * of a union-mismatch message.
 *
 * Expressions (switch conditions, foreach inputCollection, data filters, `${...}` argument
 * values) are opaque JS strings here — evaluated at runtime in isolated-vm (100ms).
 *
 * hooks.ts contract (documented, not schema-enforced): an object-literal expression
 * `({ beforeHook(ctx){}, afterHook(ctx){}, before<StateName>(ctx){}, after<StateName>(ctx){},
 * <fnName>(ctx, args){} })` — step-callable fns are referenced by functions with
 * `operation: "hook:<fnName>"`.
 */

export const ROUTINE_STATE_TYPES = ["operation", "switch", "foreach", "sleep", "inject"] as const;
export const ROUTINE_TRIGGER_TYPES = ["event", "manual", "cron", "webhook", "agent"] as const;
export const ROUTINE_APPROVAL_CHANNELS = ["ui", "slack", "email", "sms"] as const;
/** Deferred to post-V1 (ROUT-V1-004/005). */
export const DEFERRED_STATE_TYPES = ["parallel", "event"] as const;
export const DEFERRED_TRIGGER_TYPES = ["datetime", "integration"] as const;

/**
 * Domain-event names a routine `event` trigger may subscribe to. Mirrors
 * `DOMAIN_EVENTS` in apps/api/src/domain-events.ts (kept as a literal list here —
 * validation cannot depend on the api app).
 */
export const ROUTINE_EVENT_NAMES = [
  "resource.created",
  "resource.updated",
  "conversation.created",
  "conversation.completed",
] as const;

const ISO_DURATION = "^P(?!$)(\\d+Y)?(\\d+M)?(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+S)?)?$";

const EventName = Type.Unsafe<(typeof ROUTINE_EVENT_NAMES)[number]>({
  type: "string",
  enum: [...ROUTINE_EVENT_NAMES],
});

const ApprovalChannel = Type.Unsafe<(typeof ROUTINE_APPROVAL_CHANNELS)[number]>({
  type: "string",
  enum: [...ROUTINE_APPROVAL_CHANNELS],
});

// ── Triggers (x-triggers) ─────────────────────────────────────────────────────

const EventTrigger = Type.Object(
  {
    type: Type.Literal("event"),
    event: EventName,
    /** Optional JS filter over `{ trigger }`; run must only start when it returns truthy. */
    filter: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const ManualTrigger = Type.Object(
  { type: Type.Literal("manual") },
  { additionalProperties: false }
);

const CronTrigger = Type.Object(
  {
    type: Type.Literal("cron"),
    schedule: Type.String({ minLength: 1 }),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const WebhookTrigger = Type.Object(
  {
    type: Type.Literal("webhook"),
    /** Secret name resolved via SecretsService; requests without the matching header are rejected. */
    secret_ref: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const AgentTrigger = Type.Object({ type: Type.Literal("agent") }, { additionalProperties: false });

const Trigger = Type.Union([
  EventTrigger,
  ManualTrigger,
  CronTrigger,
  WebhookTrigger,
  AgentTrigger,
]);

// ── Functions ─────────────────────────────────────────────────────────────────

const FunctionDef = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    /** `tool:<toolName>` | `agent:<agentName>` | `hook:<hooksFnName>` */
    operation: Type.String({ pattern: "^(tool|agent|hook):\\S+$" }),
  },
  { additionalProperties: false }
);

// ── Errors / retries ──────────────────────────────────────────────────────────

const OnError = Type.Object(
  {
    /** Error name to match, or "*" for any. */
    errorRef: Type.String({ minLength: 1 }),
    transition: Type.Optional(Type.String({ minLength: 1 })),
    end: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const RetryPolicy = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
    /** ISO-8601 duration, e.g. PT5S. */
    delay: Type.Optional(Type.String({ pattern: ISO_DURATION })),
    multiplier: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false }
);

// ── States ────────────────────────────────────────────────────────────────────

const StateDataFilter = Type.Object(
  {
    input: Type.Optional(Type.String({ minLength: 1 })),
    output: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const ActionDataFilter = Type.Object(
  {
    results: Type.Optional(Type.String({ minLength: 1 })),
    toStateData: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const Action = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    functionRef: Type.Object(
      {
        refName: Type.String({ minLength: 1 }),
        /** Literal args; string values of the form "${ <js> }" are evaluated at runtime. */
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: false }
    ),
    retryRef: Type.Optional(Type.String({ minLength: 1 })),
    actionDataFilter: Type.Optional(ActionDataFilter),
  },
  { additionalProperties: false }
);

const Timeouts = Type.Object(
  { stateExecTimeout: Type.Optional(Type.String({ pattern: ISO_DURATION })) },
  { additionalProperties: false }
);

/** Fields shared by every V1 state. */
const stateBase = {
  name: Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9]*$" }),
  transition: Type.Optional(Type.String({ minLength: 1 })),
  end: Type.Optional(Type.Boolean()),
  onErrors: Type.Optional(Type.Array(OnError, { minItems: 1 })),
  timeouts: Type.Optional(Timeouts),
  stateDataFilter: Type.Optional(StateDataFilter),
  "x-autonomy-level": Type.Optional(Type.Literal("human_approval")),
  "x-approval-channel": Type.Optional(Type.Array(ApprovalChannel, { minItems: 1 })),
};

const OperationState = Type.Object(
  { ...stateBase, type: Type.Literal("operation"), actions: Type.Array(Action, { minItems: 1 }) },
  { additionalProperties: false }
);

const SwitchCondition = Type.Object(
  {
    condition: Type.String({ minLength: 1 }),
    transition: Type.Optional(Type.String({ minLength: 1 })),
    end: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const DefaultCondition = Type.Object(
  {
    transition: Type.Optional(Type.String({ minLength: 1 })),
    end: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const SwitchState = Type.Object(
  {
    ...stateBase,
    type: Type.Literal("switch"),
    dataConditions: Type.Array(SwitchCondition, { minItems: 1 }),
    defaultCondition: Type.Optional(DefaultCondition),
  },
  { additionalProperties: false }
);

const ForeachState = Type.Object(
  {
    ...stateBase,
    type: Type.Literal("foreach"),
    /** JS expression yielding an array (cap 1,000 items, enforced at runtime). */
    inputCollection: Type.String({ minLength: 1 }),
    iterationParam: Type.Optional(Type.String({ minLength: 1 })),
    actions: Type.Array(Action, { minItems: 1 }),
  },
  { additionalProperties: false }
);

const SleepState = Type.Object(
  { ...stateBase, type: Type.Literal("sleep"), duration: Type.String({ pattern: ISO_DURATION }) },
  { additionalProperties: false }
);

const InjectState = Type.Object(
  { ...stateBase, type: Type.Literal("inject"), data: Type.Record(Type.String(), Type.Unknown()) },
  { additionalProperties: false }
);

const State = Type.Union([OperationState, SwitchState, ForeachState, SleepState, InjectState]);

// ── Root ──────────────────────────────────────────────────────────────────────

export const RoutineDefinitionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String()),
    specVersion: Type.Optional(Type.Literal("0.8")),
    start: Type.String({ minLength: 1 }),
    states: Type.Array(State, { minItems: 1 }),
    functions: Type.Optional(Type.Array(FunctionDef)),
    retries: Type.Optional(Type.Array(RetryPolicy)),
    "x-triggers": Type.Array(Trigger, { minItems: 1 }),
    /** JSON Schema for the manual-trigger form; also validates webhook/agent payloads. */
    "x-inputs": Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false }
);

export type RoutineDefinition = Static<typeof RoutineDefinitionSchema>;
export type RoutineState = Static<typeof State>;
export type RoutineTrigger = Static<typeof Trigger>;
export type RoutineAction = Static<typeof Action>;
export type RoutineRetryPolicy = Static<typeof RetryPolicy>;
export type RoutineOnError = Static<typeof OnError>;

const check = ajv.compile(RoutineDefinitionSchema);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pre-pass: find deferred CNCF SW constructs and throw a "deferred in V1" error with a
 * JSON pointer, before AJV turns them into opaque union-mismatch messages (AC-V1-002).
 */
function rejectDeferredConstructs(data: unknown): void {
  if (!isRecord(data)) return;

  const states = Array.isArray(data.states) ? data.states : [];
  for (const [i, state] of states.entries()) {
    if (!isRecord(state)) continue;
    if ((DEFERRED_STATE_TYPES as readonly string[]).includes(String(state.type))) {
      throw new TulipFarmValidationError(
        "soul",
        `/states/${i}/type`,
        `state type "${String(state.type)}" is deferred in V1`
      );
    }
    const actionLists = [state.actions].filter(Array.isArray);
    for (const actions of actionLists) {
      for (const [j, action] of actions.entries()) {
        if (isRecord(action) && "subFlowRef" in action) {
          throw new TulipFarmValidationError(
            "soul",
            `/states/${i}/actions/${j}/subFlowRef`,
            "sub-routine invocation (subFlowRef) is deferred in V1"
          );
        }
      }
    }
  }

  const triggers = Array.isArray(data["x-triggers"]) ? data["x-triggers"] : [];
  for (const [i, trigger] of triggers.entries()) {
    if (!isRecord(trigger)) continue;
    if ((DEFERRED_TRIGGER_TYPES as readonly string[]).includes(String(trigger.type))) {
      throw new TulipFarmValidationError(
        "soul",
        `/x-triggers/${i}/type`,
        `trigger type "${String(trigger.type)}" is deferred in V1`
      );
    }
  }
}

/**
 * Structural checks AJV cannot express: start/transition targets exist, retryRef /
 * functionRef names resolve, human_approval only on operation/foreach states.
 */
function checkReferences(def: RoutineDefinition): void {
  const stateNames = new Set(def.states.map((s) => s.name));
  if (!stateNames.has(def.start)) {
    throw new TulipFarmValidationError("soul", "/start", `start state "${def.start}" not found`);
  }

  const fnNames = new Set((def.functions ?? []).map((f) => f.name));
  const retryNames = new Set((def.retries ?? []).map((r) => r.name));

  const checkTransition = (target: string | undefined, path: string) => {
    if (target !== undefined && !stateNames.has(target)) {
      throw new TulipFarmValidationError("soul", path, `transition target "${target}" not found`);
    }
  };

  for (const [i, state] of def.states.entries()) {
    checkTransition(state.transition, `/states/${i}/transition`);
    for (const [j, onError] of (state.onErrors ?? []).entries()) {
      checkTransition(onError.transition, `/states/${i}/onErrors/${j}/transition`);
    }
    if (state.type === "switch") {
      for (const [j, cond] of state.dataConditions.entries()) {
        checkTransition(cond.transition, `/states/${i}/dataConditions/${j}/transition`);
      }
      checkTransition(
        state.defaultCondition?.transition,
        `/states/${i}/defaultCondition/transition`
      );
    }
    if (state.type === "operation" || state.type === "foreach") {
      for (const [j, action] of state.actions.entries()) {
        if (!fnNames.has(action.functionRef.refName)) {
          throw new TulipFarmValidationError(
            "soul",
            `/states/${i}/actions/${j}/functionRef/refName`,
            `function "${action.functionRef.refName}" not found`
          );
        }
        if (action.retryRef !== undefined && !retryNames.has(action.retryRef)) {
          throw new TulipFarmValidationError(
            "soul",
            `/states/${i}/actions/${j}/retryRef`,
            `retry policy "${action.retryRef}" not found`
          );
        }
      }
    }
    if (
      state["x-autonomy-level"] === "human_approval" &&
      state.type !== "operation" &&
      state.type !== "foreach"
    ) {
      throw new TulipFarmValidationError(
        "soul",
        `/states/${i}/x-autonomy-level`,
        "human_approval is only valid on operation/foreach states"
      );
    }
  }
}

/**
 * Validate a routine.yaml document against the V1 meta-schema. Returns the typed
 * definition on success; throws `TulipFarmValidationError` (boundary `"soul"`) — with a
 * "deferred in V1" message for post-V1 constructs — on failure.
 */
export function validateRoutineDefinition(data: unknown): RoutineDefinition {
  rejectDeferredConstructs(data);
  if (!check(data)) {
    const e = check.errors?.[0];
    throw new TulipFarmValidationError(
      "soul",
      e?.instancePath ?? "",
      e?.message ?? "invalid routine definition"
    );
  }
  const def = data as RoutineDefinition;
  checkReferences(def);
  return def;
}
