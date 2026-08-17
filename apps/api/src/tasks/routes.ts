import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import {
  type GitSyncService,
  isSoulWriteError,
  type SoulWriter,
  soulWriteHttpError,
} from "@tulipfarm/soul";
import {
  type TaskAction,
  type TaskRecord,
  type TaskStore,
  TaskStoreError,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { AuthorizationCheck } from "../authz/route-gate";
import { mergeSoulConfig } from "../setup/soul-config";
import { commitActorFromRequest } from "../soul/commit-actor";
import { rankTasks } from "./ranking";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const BUSINESS_PROFILE_FIELDS = new Set(["businessName", "businessDescription"]);

export interface TaskRoutesDeps {
  readonly tasks: TaskStore;
  /** Soul write gateway (ADR-007) — the only door for a `business_profile` sink answer. */
  readonly soulWriter?: SoulWriter;
  readonly gitSync?: GitSyncService;
  readonly auditService?: AuditService;
  /** The user's Memory Document; a `memory` sink answer is appended to it. */
  readonly memoryDocuments?: MemoryDocumentRepo;
}

const TaskActionSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["answer", "chat", "link", "ack"] },
    field: { type: "string" },
    sink: { type: "string", enum: ["business_profile", "memory"] },
    hint: { type: "string" },
    prompt: { type: "string" },
    href: { type: "string" },
  },
} as const;

const TaskSchema = {
  type: "object",
  required: ["id", "title", "action", "blocking", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    detail: { type: "string" },
    action: TaskActionSchema,
    blocking: { type: "boolean" },
    status: { type: "string", enum: ["open", "claimed", "done", "snoozed", "dismissed"] },
    dueAt: { type: "string" },
    remindAt: { type: "string" },
    createdAt: { type: "string" },
  },
} as const;

function serialize(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    ...(task.detail === undefined ? {} : { detail: task.detail }),
    action: task.action,
    blocking: task.blocking,
    status: task.status,
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt.toISOString() }),
    ...(task.remindAt === undefined ? {} : { remindAt: task.remindAt.toISOString() }),
    createdAt: task.createdAt.toISOString(),
  };
}

function rolesFor(user: UserDoc): string[] {
  return [user.role];
}

async function loadOwnedTask(
  deps: TaskRoutesDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  requireAction?: TaskAction["kind"]
): Promise<TaskRecord | undefined> {
  const user = req.user as UserDoc;
  const task = await deps.tasks.get(DEPLOYMENT_BUSINESS_ID, id);
  if (!task) {
    reply.code(404).send({ error: "task not found" });
    return undefined;
  }
  const owned =
    (task.assigneeKind === "user" && task.assigneeId === user._id) ||
    (task.assigneeKind === "role" && rolesFor(user).includes(task.assigneeId)) ||
    task.claimedBy === user._id;
  if (!owned) {
    reply.code(403).send({ error: "this task is not yours" });
    return undefined;
  }
  if (requireAction && task.action.kind !== requireAction) {
    reply.code(400).send({ error: `task ${id} is not a ${requireAction} task` });
    return undefined;
  }
  return task;
}

/** Task routes: the runtime's internal, system-created human work-item queue (never user-created). */
export function registerTaskRoutes(
  app: FastifyInstance,
  deps: TaskRoutesDeps,
  requireAuth: PreHandler,
  authorizationCheck: AuthorizationCheck
): void {
  const auditWrite = makeSoulAuditWriter(deps.auditService);

  app.get(
    "/api/v1/tasks",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The caller's open Tasks: assigned to them directly, or unclaimed on a role they hold. " +
          "Ranked deterministically — blocking tasks suppress the rest, then time-bound, then " +
          "priority. Tasks are created only by the reconciler or an Agent Tool, never by a route " +
          "here.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: { includeSnoozed: { type: "boolean" } },
        },
        response: {
          200: {
            type: "object",
            required: ["tasks"],
            properties: { tasks: { type: "array", items: TaskSchema } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req) => {
      const user = req.user as UserDoc;
      const { includeSnoozed } = req.query as { includeSnoozed?: boolean };
      const tasks = await deps.tasks.listForPrincipal(
        DEPLOYMENT_BUSINESS_ID,
        user._id,
        rolesFor(user),
        includeSnoozed === true
      );
      return { tasks: rankTasks(tasks, new Date()).map(serialize) };
    }
  );

  app.post(
    "/api/v1/tasks/:id/answer",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Answers an `answer`-action Task inline. A `business_profile` sink is admin-only and " +
          "writes soul.yaml the same way `PUT /api/v1/business` does; a `memory` sink writes a " +
          "Memory Assertion for the caller. Closes the Task on success.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string", minLength: 1, maxLength: 2000 } },
        },
        response: {
          200: {
            type: "object",
            required: ["id", "answered"],
            properties: { id: { type: "string" }, answered: { type: "boolean" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const task = await loadOwnedTask(
        deps,
        req,
        reply,
        (req.params as { id: string }).id,
        "answer"
      );
      if (!task) return;
      const action = task.action as Extract<TaskAction, { kind: "answer" }>;
      const { value } = req.body as { value: string };
      const trimmed = value.trim();
      if (!trimmed) return reply.code(400).send({ error: "value is required" });

      if (action.sink === "business_profile") {
        const allowed =
          req.principal !== undefined &&
          (await authorizationCheck(req.principal, {
            action: "task.answer.business_profile",
            resourceType: "task",
            fallback: "admin",
          }));
        if (!allowed) return reply.code(403).send({ error: "forbidden" });
        if (!BUSINESS_PROFILE_FIELDS.has(action.field)) {
          return reply.code(400).send({ error: `field ${action.field} is not answerable here` });
        }
        if (!deps.gitSync || !deps.soulWriter) {
          return reply.code(400).send({ error: "soul git sync unavailable" });
        }
        const next = mergeSoulConfig(deps.soulWriter.read("Settings"), { [action.field]: trimmed });
        try {
          await deps.soulWriter.apply({
            subject: "chore: update business profile",
            source: "api",
            actor: commitActorFromRequest(req),
            businessId: DEPLOYMENT_BUSINESS_ID,
            changes: [{ op: "put", target: { kind: "Settings" }, content: next }],
          });
        } catch (e) {
          if (isSoulWriteError(e)) {
            const m = soulWriteHttpError(e);
            return reply.code(m.status).send(m.body);
          }
          throw e;
        }
        deps.gitSync.emit("soul.synced");
        await auditWrite(req, "soul-config.update", "soul:business-profile", { task: task.id });
      } else {
        if (!deps.memoryDocuments) return reply.code(400).send({ error: "memory unavailable" });
        const user = req.user as UserDoc;
        // Answers land in "Other durable facts" as `field: value`: the Task supplies a label, not
        // a section, and guessing one from a free-text field would file facts under the wrong
        // heading far more often than it would help.
        await deps.memoryDocuments.applyDelta({
          businessId: DEPLOYMENT_BUSINESS_ID,
          userId: user._id,
          delta: { section: "other_facts", add: [`${action.field}: ${trimmed}`] },
          writer: "task",
          now: new Date(),
        });
      }

      try {
        await deps.tasks.markDone(DEPLOYMENT_BUSINESS_ID, task.id, new Date());
      } catch (e) {
        if (e instanceof TaskStoreError) return reply.code(409).send({ error: e.message });
        throw e;
      }
      return reply.send({ id: task.id, answered: true });
    }
  );

  app.post(
    "/api/v1/tasks/:id/claim",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Claims an unclaimed role Task — first claim wins; the rest of the role no longer sees it.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["id", "status"],
            properties: { id: { type: "string" }, status: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const task = await loadOwnedTask(deps, req, reply, id);
      if (!task) return;
      const user = req.user as UserDoc;
      try {
        const claimed = await deps.tasks.claim(DEPLOYMENT_BUSINESS_ID, id, user._id, new Date());
        return reply.send({ id: claimed.id, status: claimed.status });
      } catch (e) {
        if (e instanceof TaskStoreError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    }
  );

  app.post(
    "/api/v1/tasks/:id/done",
    {
      preHandler: requireAuth,
      schema: {
        description: "Marks a `chat`/`link`/`ack` Task done by hand.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["id", "status"],
            properties: { id: { type: "string" }, status: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const task = await loadOwnedTask(deps, req, reply, id);
      if (!task) return;
      try {
        const done = await deps.tasks.markDone(DEPLOYMENT_BUSINESS_ID, id, new Date());
        return reply.send({ id: done.id, status: done.status });
      } catch (e) {
        if (e instanceof TaskStoreError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    }
  );

  app.post(
    "/api/v1/tasks/:id/snooze",
    {
      preHandler: requireAuth,
      schema: {
        description: "Hides a Task until a given time, without dismissing it permanently.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["until"],
          additionalProperties: false,
          properties: { until: { type: "string", format: "date-time" } },
        },
        response: {
          200: {
            type: "object",
            required: ["id", "status"],
            properties: { id: { type: "string" }, status: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const task = await loadOwnedTask(deps, req, reply, id);
      if (!task) return;
      const { until } = req.body as { until: string };
      const untilDate = new Date(until);
      if (Number.isNaN(untilDate.getTime())) {
        return reply.code(400).send({ error: "until must be a valid date-time" });
      }
      try {
        const snoozed = await deps.tasks.snooze(DEPLOYMENT_BUSINESS_ID, id, untilDate, new Date());
        return reply.send({ id: snoozed.id, status: snoozed.status });
      } catch (e) {
        if (e instanceof TaskStoreError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    }
  );

  app.post(
    "/api/v1/tasks/:id/dismiss",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Permanently dismisses a Task. The reconciler will never recreate the same dedupe key " +
          "for this assignee.",
        tags: ["tasks"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["id", "status"],
            properties: { id: { type: "string" }, status: { type: "string" } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const task = await loadOwnedTask(deps, req, reply, id);
      if (!task) return;
      try {
        const dismissed = await deps.tasks.dismiss(DEPLOYMENT_BUSINESS_ID, id, new Date());
        return reply.send({ id: dismissed.id, status: dismissed.status });
      } catch (e) {
        if (e instanceof TaskStoreError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    }
  );
}
