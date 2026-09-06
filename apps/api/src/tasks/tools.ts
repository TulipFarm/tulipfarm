import { CURATOR_DEDUPE_PREFIX, isCuratorDedupeKey } from "@tulipfarm/curator";
import { ajv } from "@tulipfarm/schema";
import { DOCTOR_DEDUPE_PREFIX, isDoctorDedupeKey } from "@tulipfarm/soul-doctor";
import {
  type TaskAction,
  type TaskAssigneeKind,
  type TaskStore,
  TaskStoreError,
  type TaskSubjectRef,
} from "@tulipfarm/storage";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import { firstError } from "../platform/tool-args";

/** Per-request context a task tool handler runs against — closes over the calling Agent. */
export interface TaskToolContext {
  readonly businessId: string;
  readonly tasks: TaskStore;
  readonly agentId?: string;
  readonly runId?: string;
}

const ASSIGNEE_KINDS: readonly TaskAssigneeKind[] = ["user", "role"];
const TASK_ROLES = new Set(["admin", "member"]);

const ASSIGNEE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { type: "string", enum: ASSIGNEE_KINDS },
    id: { type: "string", minLength: 1 },
  },
};

const SUBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
  },
};

const ACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["answer", "chat", "link", "ack"] },
    field: { type: "string" },
    sink: { type: "string", enum: ["business_profile", "memory"] },
    hint: { type: "string" },
    prompt: { type: "string" },
    href: { type: "string" },
  },
};

const CREATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["assignee", "dedupeKey", "title", "action"],
  properties: {
    assignee: ASSIGNEE_SCHEMA,
    dedupeKey: { type: "string", minLength: 1, maxLength: 200 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    detail: { type: "string", maxLength: 4000 },
    action: ACTION_SCHEMA,
    priority: { type: "integer" },
    remindAt: { type: "string", format: "date-time" },
    dueAt: { type: "string", format: "date-time" },
    subject: SUBJECT_SCHEMA,
  },
};

const CLOSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["dedupeKey", "reason"],
  properties: {
    dedupeKey: { type: "string", minLength: 1, maxLength: 200 },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

const validateCreate = ajv.compile(CREATE_SCHEMA);
const validateClose = ajv.compile(CLOSE_SCHEMA);

interface CreateTaskArgs {
  assignee: { kind: TaskAssigneeKind; id: string };
  dedupeKey: string;
  title: string;
  detail?: string;
  action: TaskAction;
  priority?: number;
  remindAt?: string;
  dueAt?: string;
  subject?: TaskSubjectRef;
}

interface CloseTaskArgs {
  dedupeKey: string;
  reason: string;
}

/**
 * A target ref for the assignee — reuses the standard Tool authorization mechanism (see
 * `github_*` and `kv_*` Tools): the broker derives this per call and intersects it against the
 * calling Agent's authority layers, so an assignee outside that Agent's granted range is denied
 * before the handler ever runs. No bespoke authorization primitive is introduced here.
 */
function assigneeTarget(args: unknown): readonly { type: string; id: string }[] {
  const source = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const assignee = source.assignee;
  if (typeof assignee !== "object" || assignee === null) return [];
  const { kind, id } = assignee as { kind?: unknown; id?: unknown };
  if (typeof kind !== "string" || typeof id !== "string" || id.length === 0) return [];
  return [{ type: "task.assignee", id: `${kind}:${id}` }];
}

export const taskCreateTool = defineApiTool<TaskToolContext>({
  name: "task_create",
  description:
    "Create a Task, a unit of work the runtime asks a human to do (never a user-facing todo " +
    "item; that is a Resource Type instead). Assignee is a user id or a role (admin/member); the " +
    "calling Agent may only assign within its own authority. dedupeKey is stable per producer. " +
    "re-creating the same key for the same assignee upserts instead of duplicating.",
  tier: "system",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  authorization: {
    action: "task.create",
    resources: ["task.assignee"],
    targets: assigneeTarget,
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const input = args as CreateTaskArgs;
    if (input.assignee.kind === "role" && !TASK_ROLES.has(input.assignee.id)) {
      return err("validation_error", `unknown role "${input.assignee.id}"`);
    }
    // The Curator derives its dedupe keys from a Proposal's identity so a rephrasing cannot
    // resurrect a dismissed one. An Agent that could write into that namespace could resurrect it
    // for them, or squat the key of a suggestion the Curator has not made yet.
    if (isCuratorDedupeKey(input.dedupeKey)) {
      return err(
        "validation_error",
        `dedupe keys beginning "${CURATOR_DEDUPE_PREFIX}" are reserved`
      );
    }
    // Same reason, for the Doctor: an escalation an operator dismissed must stay dismissed, and
    // the key of a defect nobody has found yet must not be claimable in advance.
    if (isDoctorDedupeKey(input.dedupeKey)) {
      return err(
        "validation_error",
        `dedupe keys beginning "${DOCTOR_DEDUPE_PREFIX}" are reserved`
      );
    }
    try {
      const task = await ctx.tasks.upsertOpen(
        {
          businessId: ctx.businessId,
          assigneeKind: input.assignee.kind,
          assigneeId: input.assignee.id,
          dedupeKey: input.dedupeKey,
          title: input.title,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
          action: input.action,
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.remindAt === undefined ? {} : { remindAt: new Date(input.remindAt) }),
          ...(input.dueAt === undefined ? {} : { dueAt: new Date(input.dueAt) }),
          ...(ctx.agentId === undefined ? {} : { originAgentId: ctx.agentId }),
          ...(ctx.runId === undefined ? {} : { originRunId: ctx.runId }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
        },
        new Date()
      );
      return ok({ id: task.id, status: task.status });
    } catch (e) {
      if (e instanceof TaskStoreError) return err("write_denied", e.message);
      throw e;
    }
  },
});

export const taskCloseTool = defineApiTool<TaskToolContext>({
  name: "task_close",
  description:
    "Close a Task by its dedupeKey, used by the creating Agent to signal the underlying gap is " +
    "resolved. A no-op when no live Task has that key.",
  tier: "system",
  mutating: true,
  inputSchema: CLOSE_SCHEMA,
  authorization: {
    action: "task.close",
    resources: ["task"],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateClose(args)) return err("validation_error", firstError(validateClose.errors));
    if (isCuratorDedupeKey((args as CloseTaskArgs).dedupeKey)) {
      return err(
        "validation_error",
        `dedupe keys beginning "${CURATOR_DEDUPE_PREFIX}" are reserved`
      );
    }
    if (isDoctorDedupeKey((args as CloseTaskArgs).dedupeKey)) {
      return err(
        "validation_error",
        `dedupe keys beginning "${DOCTOR_DEDUPE_PREFIX}" are reserved`
      );
    }
    const input = args as CloseTaskArgs;
    await ctx.tasks.closeByDedupeKey(ctx.businessId, input.dedupeKey, new Date());
    return ok({ dedupeKey: input.dedupeKey, closed: true });
  },
});

/** Registry of the Task platform tools, picked up by the chat/routine tool runtime. */
export const TASK_TOOLS: ApiToolDefinition<TaskToolContext>[] = [taskCreateTool, taskCloseTool];
