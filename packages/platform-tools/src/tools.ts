/**
 * Platform Tools whose handlers read no ambient control-plane state, so the durable runtime can
 * execute them in-process. Anything that reaches the Soul stays in `apps/api`.
 */

import { formatTemporalContext } from "@tulipfarm/agent-runtime";
import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { err, ok } from "./tool-result";

/** The whole context these Tools need: a Run reference when one is in scope. */
export interface PlatformRuntimeContext {
  routineContext?: { routineId: string; runId: string };
}

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

function bestError(errors: AjvErrors): NonNullable<AjvErrors>[number] | undefined {
  if (!errors || errors.length === 0) return undefined;
  const specific = errors.filter((e) => e.keyword !== "oneOf");
  const pool = specific.length > 0 ? specific : errors;
  return pool.reduce((deepest, e) =>
    e.instancePath.length > deepest.instancePath.length ? e : deepest
  );
}

function firstError(errors: AjvErrors): string {
  const e = bestError(errors);
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

const VALIDATE_ARTIFACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["artifact", "schema"],
  properties: {
    artifact: { description: "The data to validate." },
    schema: {
      type: "object",
      description: "JSON Schema to validate the artifact against.",
    },
  },
};

const COMPLETE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { description: "Output data from the completed state." },
  },
};

const COMPLETE_TASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "failed", "cancelled"],
      description: "Outcome of the delegated work.",
    },
    summary: { type: "string", description: "One-line summary of what was built / what happened." },
    result: {
      type: "object",
      description:
        "Optional structured result, e.g. { resources, skills, agents } counts or names.",
    },
    error: { type: "string", description: "Specific reason when status is 'failed'." },
  },
};

const GET_CURRENT_TIME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    timezone: {
      type: "string",
      minLength: 1,
      description: "IANA zone to read the time in (e.g. 'Asia/Kolkata'). Defaults to UTC.",
    },
  },
};

const validateArtifactArgs = ajv.compile(VALIDATE_ARTIFACT_SCHEMA);

const validateCompleteState = ajv.compile(COMPLETE_STATE_SCHEMA);

const validateCompleteTask = ajv.compile(COMPLETE_TASK_SCHEMA);

const validateGetCurrentTime = ajv.compile(GET_CURRENT_TIME_SCHEMA);

export const validateArtifactTool = defineApiTool<PlatformRuntimeContext>({
  name: "validate_artifact",
  description:
    "Validate an arbitrary artifact against a JSON Schema. Returns { valid: true } on success or { valid: false, errors: [...] } with AJV error details. Use before writing structured data to resources.",
  mutating: false,
  tier: "platform",
  inputSchema: VALIDATE_ARTIFACT_SCHEMA,
  authorization: {
    action: "platform.artifact.validate",
    resources: ["platform.artifact"],
    dataClasses: ["soul_definition"],
  },
  handler: async (args, _ctx) => {
    if (!validateArtifactArgs(args))
      return err("validation_error", firstError(validateArtifactArgs.errors));
    const { artifact, schema } = args as { artifact: unknown; schema: Record<string, unknown> };
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return err("internal_error", `Invalid schema: ${e instanceof Error ? e.message : String(e)}`);
    }
    const valid = validate(artifact);
    if (valid) return ok({ valid: true });
    return ok({
      valid: false,
      errors: (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "(root)",
        message: e.message ?? "is invalid",
      })),
    });
  },
});

export const completeStateTool = defineApiTool<PlatformRuntimeContext>({
  name: "complete_state",
  description:
    "Signal completion of the current routine state and emit its output. Only callable from a routine-spawned agent turn.",
  mutating: true,
  tier: "platform",
  inputSchema: COMPLETE_STATE_SCHEMA,
  authorization: {
    action: "platform.state.complete",
    resources: ["platform.state"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateCompleteState(args))
      return err("validation_error", firstError(validateCompleteState.errors));
    if (!ctx.routineContext)
      return err("internal_error", "complete_state is only callable from a routine context.");
    const { output } = args as { output?: unknown };
    return ok({
      routineId: ctx.routineContext.routineId,
      runId: ctx.routineContext.runId,
      completed: true,
      output: output ?? null,
    });
  },
});

export const completeTaskTool = defineApiTool<PlatformRuntimeContext>({
  name: "complete_task",
  description:
    "Signal that the delegated work is finished and hand control back to the front-desk agent. Call this when a creation/onboarding session is done (success), cannot proceed (failed), or was abandoned (cancelled).",
  mutating: false,
  tier: "platform",
  inputSchema: COMPLETE_TASK_SCHEMA,
  authorization: {
    action: "platform.task.complete",
    resources: ["platform.task"],
    dataClasses: ["operational"],
  },
  handler: async (args) => {
    if (!validateCompleteTask(args))
      return err("validation_error", firstError(validateCompleteTask.errors));
    const { status, summary, result, error } = args as {
      status: "success" | "failed" | "cancelled";
      summary?: string;
      result?: Record<string, unknown>;
      error?: string;
    };
    return ok({
      status,
      summary: summary ?? null,
      result: result ?? null,
      error: error ?? null,
      completed: true,
    });
  },
});

export const getCurrentTimeTool = defineApiTool<PlatformRuntimeContext>({
  name: "get_current_time",
  description:
    "Get the current date, day of week and time. Nothing else tells you what now is, so call this " +
    "before any date reasoning — what today is, whether something is overdue, what 'next Tuesday' " +
    "means — and again if a long turn may have outlived the first reading.",
  mutating: false,
  tier: "platform",
  inputSchema: GET_CURRENT_TIME_SCHEMA,
  authorization: {
    action: "platform.time.read",
    resources: ["platform.time"],
    dataClasses: ["operational"],
  },
  handler: async (args) => {
    if (!validateGetCurrentTime(args))
      return err("validation_error", firstError(validateGetCurrentTime.errors));
    const { timezone } = args as { timezone?: string };
    return ok({ current: formatTemporalContext({ now: new Date(), timezone }) });
  },
});

export const PLAN_DECLARE_TOOL_NAME = "plan_declare";

const PLAN_DECLARE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["rounds"],
  properties: {
    rounds: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      description:
        "The Rounds ahead, in order. Every call in a Round must be able to run without any other " +
        "call in that same Round, because they are dispatched together. Put a call in a later " +
        "Round when its arguments depend on an earlier Round's result.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["calls"],
        properties: {
          calls: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["tool"],
              properties: {
                tool: {
                  type: "string",
                  minLength: 1,
                  maxLength: 80,
                  description: "The Tool you expect to call.",
                },
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 120,
                  description: "What that call is for, in the reader's words. Keep it short.",
                },
              },
            },
          },
        },
      },
    },
  },
};
const validatePlanDeclare = ajv.compile(PLAN_DECLARE_SCHEMA);

/**
 * Publishes the Agent's forecast of the work ahead so a reader can see it before it happens.
 *
 * Non-mutating on purpose: it touches nothing, which is what lets it ride in the same concurrent
 * dispatch as the Round it is describing. Declaring the plan therefore costs no model round-trip,
 * and a round-trip is the only thing that meaningfully costs a Turn its wall clock.
 */
export const planDeclareTool = defineApiTool<PlatformRuntimeContext>({
  name: PLAN_DECLARE_TOOL_NAME,
  description:
    "Show the person the shape of the work before you do it. Call it whenever the request needs " +
    "three or more Tool calls across two or more Rounds — creating a Routine, an Agent or a " +
    "Resource type usually does. Skip it for anything you can finish in one Round; a plan for " +
    "trivial work is noise. NEVER call it on its own: put it in the same message as Round 1's " +
    "calls. A message carrying only this Tool spends a whole model round-trip declaring work it " +
    "then has to come back to start, so the person watches a plan in which nothing is running for " +
    "as long as it takes you to think again. Round 1 must therefore list the calls you are making " +
    "in THAT SAME message. Group calls that can run at the same time into one Round, and put a " +
    "call in a later Round only when it needs an earlier Round's result. Call this again, with " +
    "the whole plan, whenever what you learned changes it. Declaring a plan neither reserves nor " +
    "runs anything.",
  mutating: false,
  tier: "platform",
  inputSchema: PLAN_DECLARE_SCHEMA,
  authorization: {
    action: "platform.plan.declare",
    resources: ["platform.plan"],
    dataClasses: ["operational"],
  },
  handler: async (args) => {
    if (!validatePlanDeclare(args))
      return err("validation_error", firstError(validatePlanDeclare.errors));
    const { rounds } = args as {
      rounds: { calls: { tool: string; label?: string }[] }[];
    };
    // Echoed under `plan` so the announce wrapper can lift it into a `plan.declared` Run event
    // without knowing which Tool produced it, the same structural match Surfaces already use.
    return ok({
      plan: {
        rounds: rounds.map((round) => ({
          calls: round.calls.map((call) => ({
            tool: call.tool,
            ...(call.label === undefined ? {} : { label: call.label }),
          })),
        })),
      },
      declared: true,
    });
  },
});

export const PLATFORM_RUNTIME_TOOLS: ApiToolDefinition<PlatformRuntimeContext>[] = [
  validateArtifactTool,
  completeStateTool,
  completeTaskTool,
  getCurrentTimeTool,
  planDeclareTool,
];
