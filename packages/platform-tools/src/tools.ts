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

export const PLATFORM_RUNTIME_TOOLS: ApiToolDefinition<PlatformRuntimeContext>[] = [
  validateArtifactTool,
  completeStateTool,
  completeTaskTool,
  getCurrentTimeTool,
];
