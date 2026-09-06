import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { ajv } from "@tulipfarm/schema";
import { defineApiTool } from "@tulipfarm/tool-host";
import type { RunReadModel, RunStateReadModel } from "../admin/types";
import { firstError, SOUL_ROUTINE_TARGET, soulTarget } from "./tool-args";
import { err, ok } from "./tool-result";
import type { PlatformToolContext } from "./tools";

/**
 * Prose for a Run status an Agent has to explain to a person. `needs_reconciliation` in
 * particular reads as a healthy word and is not one: it means the Run stopped where no retry can
 * move it, and someone has to look.
 */
const RUN_STATUS_MEANING: Record<string, string> = {
  queued: "Accepted, not yet picked up by a Worker.",
  running: "Executing now.",
  waiting: "Parked on a wait, an approval, or a child Run.",
  succeeded: "Finished. Every State completed.",
  failed: "Finished unsuccessfully. See `states[].error`.",
  cancelled: "Stopped on request before it finished.",
  paused: "Held by an operator; resumable.",
  needs_reconciliation:
    "Stopped in a state no retry can clear — usually an authoring bug or a missing dependency. " +
    "It will never finish on its own and needs an operator.",
};

/**
 * Turns an `error_evidence_ref` into something worth reading. The refs are `routine:<code>` or
 * `routine:<code>:<state>`, and the codes are the executor's own vocabulary, so an Agent handed
 * the bare ref reports a token rather than a cause.
 */
const EVIDENCE_MEANING: Record<string, string> = {
  input_not_evaluable:
    "One of this State's input mappings referenced something that does not exist at run time — " +
    "typically `${states.<Name>.output.<field>}` naming a field the previous State never " +
    "published. Read the Routine with `routine_get` and compare the mapping to what the earlier " +
    "State actually returns.",
  missing_state: "The Routine transitions to a State name that its own definition does not define.",
  unsupported_state: "This deployment hosts no executor for that State type.",
  state_cannot_progress: "The State was reached in a status it cannot be run from.",
  missing_action_name: "An `action` State does not name the runtime Tool to call.",
};

function explainEvidence(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const [, code, state] = ref.split(":");
  const meaning = code === undefined ? undefined : EVIDENCE_MEANING[code];
  const at = state === undefined ? "" : ` (at State \`${state}\`)`;
  return meaning === undefined ? `${ref}${at}` : `${meaning}${at}`;
}

const UNSETTLED = new Set(["queued", "running", "waiting", "paused"]);

/** The State that explains the Run: the one carrying evidence, else the one still unsettled. */
function culprit(states: readonly RunStateReadModel[]): RunStateReadModel | undefined {
  return (
    states.find((state) => state.errorEvidenceRef !== undefined) ??
    states.find((state) => UNSETTLED.has(state.status))
  );
}

function runSummary(run: RunReadModel) {
  const failing = culprit(run.states);
  return {
    runId: run.id,
    routineId: run.routineId,
    routineVersion: run.routineVersion,
    status: run.status,
    statusMeaning: RUN_STATUS_MEANING[run.status] ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    states: run.states.map((state) => ({
      name: state.key,
      status: state.status,
      attempts: state.attempts,
      error: explainEvidence(state.errorEvidenceRef),
    })),
    error:
      failing?.errorEvidenceRef === undefined
        ? null
        : {
            state: failing.key,
            evidenceRef: failing.errorEvidenceRef,
            explanation: explainEvidence(failing.errorEvidenceRef),
          },
    costs: run.costs,
  };
}

const ROUTINE_RUN_GET_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: {
    runId: {
      type: "string",
      minLength: 1,
      description: "Run id, exactly as `trigger_routine` returned it.",
    },
  },
};
const validateRoutineRunGet = ajv.compile(ROUTINE_RUN_GET_SCHEMA);

export const routineRunGetTool = defineApiTool<PlatformToolContext>({
  name: "routine_run_get",
  description:
    "Read the status of one Routine Run by its run id — the id `trigger_routine` returns. Answers " +
    "whether it is still running, succeeded, failed, or stopped needing an operator, and names " +
    "the State it stopped on with a readable explanation of the error. Use this whenever someone " +
    "asks what happened to a Run, and poll it after `trigger_routine` rather than assuming a " +
    "triggered Run did its work.",
  mutating: false,
  tier: "platform",
  inputSchema: ROUTINE_RUN_GET_SCHEMA,
  authorization: {
    action: "platform.routine.read",
    resources: ["soul.routine"],
    targets: () => [],
    dataClasses: ["operational"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateRoutineRunGet(args))
      return err("validation_error", firstError(validateRoutineRunGet.errors));
    const { runId } = args as { runId: string };
    if (ctx.runs === undefined)
      return err("internal_error", "The Run reader is unavailable, so no Run can be read.");

    let run: RunReadModel | null;
    try {
      run = await ctx.runs.get(DEPLOYMENT_BUSINESS_ID, runId);
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
    if (run === null) return err("not_found", `No Run with id ${runId}.`);
    return ok(runSummary(run));
  },
});

const ROUTINE_RUN_LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Routine slug, as `routine_picker` lists it.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "How many of the most recent Runs to return. Defaults to 5.",
    },
  },
};
const validateRoutineRunList = ajv.compile(ROUTINE_RUN_LIST_SCHEMA);

export const routineRunListTool = defineApiTool<PlatformToolContext>({
  name: "routine_run_list",
  description:
    "List the most recent Runs of one Routine, newest first, with the same status and error " +
    "detail as `routine_run_get`. Use it when someone asks whether a Routine is working and no " +
    "run id is to hand — including right after a scheduled window, to see whether the schedule " +
    "actually fired.",
  mutating: false,
  tier: "platform",
  inputSchema: ROUTINE_RUN_LIST_SCHEMA,
  authorization: {
    action: "platform.routine.read",
    resources: ["soul.routine"],
    targets: (args) => soulTarget(SOUL_ROUTINE_TARGET, args, "name"),
    dataClasses: ["operational"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateRoutineRunList(args))
      return err("validation_error", firstError(validateRoutineRunList.errors));
    const { name, limit } = args as { name: string; limit?: number };
    if (ctx.runs === undefined)
      return err("internal_error", "The Run reader is unavailable, so no Run can be read.");
    if (ctx.routineCatalog === undefined)
      return err(
        "internal_error",
        "The Routines surface is unavailable, so no Routine can be read."
      );

    // Runs pin the Routine's id, not its slug, so the catalog is the only way from the name a
    // person uses to the key the Run carries.
    const detail = await ctx.routineCatalog.get(name);
    if (detail === undefined) return err("not_found", `routine not found: ${name}`);

    let page: { items: readonly RunReadModel[] };
    try {
      page = await ctx.runs.list(DEPLOYMENT_BUSINESS_ID, {
        limit: limit ?? 5,
        routineId: detail.id,
      });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }

    // The list page carries no States, so each Run is re-read for the detail that makes the
    // answer worth giving. `limit` is capped at 20 precisely to bound this.
    const runs = await Promise.all(
      page.items.map(async (item) => {
        const full = await ctx.runs?.get(DEPLOYMENT_BUSINESS_ID, item.id);
        return runSummary(full ?? item);
      })
    );
    return ok({ routine: name, runs });
  },
});
