import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, lockAuthorization, resolveHuman, uuidSchema, type HumanActor } from '@tulipfarm/access';
import { authorizeChat } from '@tulipfarm/conversations/chat-access';
import {
  ensureSystemFolder,
  FileError,
  requireReadableFile,
  syncFileGrantsForOrigin,
  type createFiles,
} from '@tulipfarm/files';
import {
  changeList,
  planDocumentModel,
  planDocumentPdfLimit,
  planDocumentSectionsSchema,
  planStamp,
  type PlanDocumentInput,
  type PlanDocumentRenderJob,
  type PlanDocumentRenderResult,
} from '@tulipfarm/plan-documents';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentStorage } from './store.ts';
import { currentRevision, notifyPlanChange, planDocumentsVersion, type PlanTransaction } from './plans.ts';
import { AgentPlanError, type planDocumentErrorSchema } from './plan-contracts.ts';

/** Plan documents need `*_plan_documents.sql`; older storage renders none. */
export const planDocumentCompatibility = Object.freeze({
  minimum: planDocumentsVersion,
  maximum: commonCompatibility.maximum,
});
export type PlanDocumentError = z.infer<typeof planDocumentErrorSchema>;
/** `auto` follows plan changes; `retry` renders a failed revision again; `recreate` also files a new PDF. */
export type PlanDocumentMode = 'auto' | 'retry' | 'recreate';
export type PlanDocumentTarget = { revision: number; generation: number };
export type PreparedPlanDocument = PlanDocumentTarget & { job: PlanDocumentRenderJob };
/** Reads display names by user ID; names live outside workspace storage. */
export type PlanDocumentNames = (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
/** The object store the render worker wrote to. */
export type PlanDocumentObjects = {
  read: (key: string, size: number) => Promise<Uint8Array>;
  remove: (key: string) => Promise<void>;
};
type Files = ReturnType<typeof createFiles>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/**
 * The ID of a plan's new PDF. It is fixed by the rendering and when it was dispatched, so a retried publish finds the
 * file it created, and a PDF saved again after the starter deleted one gets a new file.
 */
const newFileId = (planId: string, target: PlanDocumentTarget, dispatchedAt: string) => {
  const hex = createHash('sha256')
    .update(`plan-document-file:${planId}:${target.revision}:${target.generation}:${dispatchedAt}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
/** The PDF's name: the plan's title without characters Files rejects. */
export function planDocumentFileName(title: string) {
  const base =
    [...title]
      .map(char =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\' ? ' ' : char,
      )
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trim() || 'Plan';
  return `${base}.pdf`;
}

const snapshotSchema = z.object({
  title: z.string(),
  brief: z.string(),
  requirements: z.array(z.object({ key: z.string(), description: z.string() })).catch([]),
  prerequisites: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        status: z.enum(['verified', 'blocked', 'unknown']).catch('unknown'),
        reason: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  tasks: z.array(
    z.object({
      key: z.string(),
      parent: z.string().nullable(),
      kind: z.enum(['group', 'work']),
      order: z.enum(['parallel', 'serial']),
      title: z.string(),
      brief: z.string(),
      criteria: z.array(z.string()),
      dependsOn: z.array(z.string()),
      assignee: z.string().nullable(),
    }),
  ),
  budget: z.object({
    toolCalls: z.number(),
    activeMilliseconds: z.number(),
    credits: z.number().nullable().optional(),
  }),
  document: z.record(z.string(), z.unknown()).nullable().catch(null),
});
type Snapshot = z.infer<typeof snapshotSchema>;

/** The document input of a frozen snapshot. A plan without written sections gets its brief as the summary. */
function documentInput(
  snapshot: Snapshot,
  revision: number,
  generatedAt: string,
  starterName: string,
): PlanDocumentInput {
  const sections = planDocumentSectionsSchema.safeParse(snapshot.document);
  return {
    title: snapshot.title,
    brief: snapshot.brief,
    starterName,
    contentRevision: revision,
    generatedAt,
    requirements: snapshot.requirements,
    prerequisites: snapshot.prerequisites,
    tasks: snapshot.tasks.map(task => ({
      ...task,
      assignee:
        task.assignee === null
          ? null
          : task.assignee === 'Main agent'
            ? { kind: 'coordinator' as const }
            : { kind: 'agent' as const, name: task.assignee },
    })),
    budget: {
      toolCalls: snapshot.budget.toolCalls,
      activeMinutes: Math.ceil(snapshot.budget.activeMilliseconds / 60000),
      credits: snapshot.budget.credits ?? null,
    },
    sections: sections.success ? sections.data : { summary: snapshot.brief.trim() || snapshot.title },
  };
}

const planSchema = z.object({
  title: z.string(),
  chatId: uuidSchema,
  starterUserId: z.string(),
  starterMembershipId: uuidSchema,
  revision: z.number().int().positive(),
  fileId: uuidSchema.nullable(),
  fileDetached: z.boolean(),
  namedFrom: z.string().nullable(),
  projectId: uuidSchema.nullable(),
});
const planQuery = (tx: PlanTransaction, lock: boolean) =>
  `SELECT p.title, p.conversation_id AS "chatId", p.starter_user_id AS "starterUserId", p.starter_membership_id AS "starterMembershipId",
    p.content_revision AS revision, p.document_file_id AS "fileId", p.document_file_detached AS "fileDetached",
    p.document_file_named_from AS "namedFrom", c.project_id AS "projectId"
  FROM ${relation(tx, 'tf_agent_plans')} p JOIN ${relation(tx, 'tf_conversations')} c ON c.id=p.conversation_id
  WHERE p.id=$1 ${lock ? 'FOR UPDATE OF p' : ''}`;
async function loadPlan(tx: PlanTransaction, planId: string, lock: boolean) {
  return planSchema.optional().parse((await tx.client.query(planQuery(tx, lock), [planId])).rows[0]);
}
async function approvals(tx: PlanTransaction, planId: string) {
  const rows = z
    .array(
      z.object({
        revision: z.number().int().positive(),
        approvedAt: z.string(),
        timeZone: z.string(),
        userId: z.string().nullable(),
      }),
    )
    .parse(
      (
        await tx.client.query(
          `SELECT a.revision, to_json(a.approved_at)#>>'{}' AS "approvedAt", a.time_zone AS "timeZone", m.user_id AS "userId"
          FROM ${relation(tx, 'tf_agent_plan_approvals')} a LEFT JOIN ${relation(tx, 'tf_memberships')} m ON m.id=a.approved_by_membership_id
          WHERE a.plan_id=$1 ORDER BY a.approved_at DESC, a.revision DESC`,
          [planId],
        )
      ).rows,
    );
  return { count: rows.length, latest: rows[0] ?? null };
}
/** The rendering a plan needs now: its current revision under the number of approvals recorded so far. */
async function target(tx: PlanTransaction, planId: string, revision: number): Promise<PlanDocumentTarget> {
  return { revision, generation: (await approvals(tx, planId)).count };
}
async function documentRow(tx: PlanTransaction, planId: string, at: PlanDocumentTarget) {
  return z
    .object({ status: z.enum(['pending', 'rendering', 'ready', 'failed']) })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT status FROM ${relation(tx, 'tf_agent_plan_documents')} WHERE plan_id=$1 AND revision=$2 AND generation=$3`,
          [planId, at.revision, at.generation],
        )
      ).rows[0],
    );
}

/**
 * Stores and files plan documents. The worker prepares a rendering, has the render worker draw it, then publishes it
 * into the starter's Files. The API reads the status and pages through it.
 */
export function createPlanDocumentStore(runtime: AgentStorage) {
  const transaction = <T>(workspaceId: string, operation: (tx: PlanTransaction) => Promise<T>) =>
    runtime.transaction(uuidSchema.parse(workspaceId), planDocumentCompatibility, operation);
  const humanTransaction = <T>(
    workspaceId: string,
    user: string,
    write: boolean,
    operation: (tx: PlanTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    transaction(workspaceId, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, user));
    });
  async function readablePlan(tx: PlanTransaction, actor: HumanActor, planId: string, lock = false) {
    const plan = await loadPlan(tx, uuidSchema.parse(planId), lock);
    if (!plan) throw new AccessDenied();
    const chat = z
      .object({ owner: z.boolean(), projectId: uuidSchema.nullable() })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT (owner_user_id=$2 AND owner_membership_id=$3) AS owner, project_id AS "projectId"
            FROM ${relation(tx, 'tf_conversations')} WHERE id=$1 AND kind='private' AND deleted_at IS NULL`,
            [plan.chatId, actor.userId, actor.membershipId],
          )
        ).rows[0],
      );
    if (!chat) throw new AccessDenied();
    await authorizeChat(tx, actor, chat, 'read');
    return plan;
  }
  const isStarter = (plan: z.infer<typeof planSchema>, actor: HumanActor) =>
    plan.starterUserId === actor.userId && plan.starterMembershipId === actor.membershipId;
  /** Records the outcome of a rendering, and tells the chat so an open Document view refreshes. */
  async function record(
    tx: PlanTransaction,
    workspaceId: string,
    planId: string,
    at: PlanDocumentTarget,
    outcome: {
      status: 'ready' | 'failed';
      error?: PlanDocumentError | undefined;
      html?: PlanDocumentRenderResult['html'] | undefined;
      stampTone?: string | undefined;
      pdf?: { fileId: string; version: number } | undefined;
    },
  ) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_plan_documents')} SET status=$4, error=$5,
        html_object_key=COALESCE($6, html_object_key), html_size=COALESCE($7, html_size), html_digest=COALESCE($8, html_digest),
        stamp_tone=COALESCE($9, stamp_tone), pdf_file_id=$10, pdf_file_version=$11,
        rendered_at=CASE WHEN $6::uuid IS NULL THEN rendered_at ELSE clock_timestamp() END, updated_at=clock_timestamp()
      WHERE plan_id=$1 AND revision=$2 AND generation=$3`,
      [
        planId,
        at.revision,
        at.generation,
        outcome.status,
        outcome.error ?? null,
        outcome.html?.key ?? null,
        outcome.html?.size ?? null,
        outcome.html?.sha256 ?? null,
        outcome.stampTone ?? null,
        outcome.pdf?.fileId ?? null,
        outcome.pdf?.version ?? null,
      ],
    );
    const chat = z
      .object({ chatId: uuidSchema })
      .parse(
        (
          await tx.client.query(
            `SELECT conversation_id AS "chatId" FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1`,
            [planId],
          )
        ).rows[0],
      );
    await notifyPlanChange(tx, workspaceId, { id: planId, chatId: chat.chatId });
  }
  /** Whether the file the plan files into is gone for good: missing, in Trash or being deleted. */
  async function fileGone(tx: PlanTransaction, fileId: string) {
    const file = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_files')} WHERE id=$1 AND kind='file' AND ready AND trashed_at IS NULL AND deleting_at IS NULL`,
        [fileId],
      )
    ).rowCount;
    return !file;
  }
  /** Marks a rendering as due again, so plan recovery starts it if the workflow can't be started now. */
  async function requeue(tx: PlanTransaction, workspaceId: string, planId: string, at: PlanDocumentTarget) {
    await currentRevision(tx, planId);
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_agent_plan_documents')} (plan_id,revision,generation,dispatched_at) VALUES ($1,$2,$3,clock_timestamp())
      ON CONFLICT (plan_id,revision,generation) DO UPDATE SET status='pending', error=NULL, dispatched_at=clock_timestamp(), updated_at=clock_timestamp()`,
      [planId, at.revision, at.generation],
    );
    const chat = z
      .object({ chatId: uuidSchema })
      .parse(
        (
          await tx.client.query(
            `SELECT conversation_id AS "chatId" FROM ${relation(tx, 'tf_agent_plans')} WHERE id=$1`,
            [planId],
          )
        ).rows[0],
      );
    await notifyPlanChange(tx, workspaceId, { id: planId, chatId: chat.chatId });
  }
  async function detach(tx: PlanTransaction, planId: string) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_agent_plans')} SET document_file_detached=true WHERE id=$1 AND document_file_id IS NOT NULL`,
      [planId],
    );
  }

  /** Records a rendering that failed; the HTML of a quota or size failure stays readable. */
  async function fail(
    workspaceId: string,
    planId: string,
    at: PlanDocumentTarget,
    error: PlanDocumentError,
    html?: PlanDocumentRenderResult['html'],
  ) {
    await transaction(workspaceId, tx => record(tx, workspaceId, planId, at, { status: 'failed', error, html }));
  }
  async function publishFiled(
    workspaceId: string,
    planId: string,
    at: PlanDocumentTarget,
    result: PlanDocumentRenderResult & { stampTone: string },
    files: Files,
    objects: PlanDocumentObjects,
  ) {
    const { html, stampTone } = result;
    if (!result.pdf) {
      await fail(workspaceId, planId, at, 'too-large', html);
      return;
    }
    const pdf = result.pdf;
    const placed = await transaction(workspaceId, async tx => {
      await lockAuthorization(tx, 'write');
      const plan = await loadPlan(tx, planId, true);
      if (!plan) throw new AccessDenied();
      const starter = (
        await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_memberships')} WHERE id=$1 AND user_id=$2 AND removed_at IS NULL`,
          [plan.starterMembershipId, plan.starterUserId],
        )
      ).rowCount;
      if (!starter) return { kind: 'unfiled' as const };
      if (plan.fileId && !plan.fileDetached && (await fileGone(tx, plan.fileId))) await detach(tx, planId);
      const current = await loadPlan(tx, planId, false);
      if (!current) throw new AccessDenied();
      if (current.fileDetached) return { kind: 'detached' as const };
      if (current.fileId) {
        const reused = z
          .object({ version: z.number().int().positive() })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT pdf_file_version AS version FROM ${relation(tx, 'tf_agent_plan_documents')}
                WHERE plan_id=$1 AND pdf_file_id=$2 AND html_digest=$3 ORDER BY revision DESC, generation DESC LIMIT 1`,
                [planId, current.fileId, html.sha256],
              )
            ).rows[0],
          );
        return { kind: 'version' as const, plan: current, reused: reused?.version ?? null };
      }
      const dispatched = z.object({ at: z.string() }).parse(
        (
          await tx.client.query(
            `SELECT to_json(dispatched_at)#>>'{}' AS at FROM ${relation(tx, 'tf_agent_plan_documents')}
              WHERE plan_id=$1 AND revision=$2 AND generation=$3 AND dispatched_at IS NOT NULL`,
            [planId, at.revision, at.generation],
          )
        ).rows[0],
      );
      const actor: HumanActor = { kind: 'human', userId: plan.starterUserId, membershipId: plan.starterMembershipId };
      return {
        kind: 'create' as const,
        plan: current,
        fileId: newFileId(planId, at, dispatched.at),
        folderId: await ensureSystemFolder(tx, actor, 'plans'),
      };
    });
    if (placed.kind === 'unfiled') {
      await fail(workspaceId, planId, at, 'files', html);
      return;
    }
    if (placed.kind === 'detached') {
      await transaction(workspaceId, tx => record(tx, workspaceId, planId, at, { status: 'ready', html, stampTone }));
      return;
    }
    if (pdf.size > planDocumentPdfLimit) {
      await fail(workspaceId, planId, at, 'too-large', html);
      return;
    }
    const plan = placed.plan;
    let filed: { fileId: string; version: number };
    try {
      if (placed.kind === 'version' && placed.reused !== null) filed = { fileId: plan.fileId!, version: placed.reused };
      else {
        const content = await objects.read(pdf.key, pdf.size);
        if (sha256(content) !== pdf.sha256) throw new Error('plan-document-integrity');
        if (placed.kind === 'create') {
          const fileId = placed.fileId;
          const name = planDocumentFileName(plan.title);
          await files.createDerived(
            workspaceId,
            plan.starterUserId,
            fileId,
            { name, parentId: placed.folderId, mediaType: 'application/pdf' },
            content,
          );
          await transaction(workspaceId, tx =>
            tx.client.query(
              `UPDATE ${relation(tx, 'tf_agent_plans')} SET document_file_id=$2, document_file_named_from=$3, document_file_detached=false
              WHERE id=$1 AND document_file_id IS NULL`,
              [planId, fileId, name],
            ),
          );
          filed = { fileId, version: 1 };
        } else {
          const entry = await files.addVersion(
            workspaceId,
            { kind: 'file-owner' },
            plan.fileId!,
            { mediaType: 'application/pdf', content },
            'plan-document',
          );
          filed = { fileId: plan.fileId!, version: entry.version };
        }
      }
    } catch (error) {
      if (error instanceof FileError && (error.code === 'quota' || error.code === 'size')) {
        await fail(workspaceId, planId, at, error.code === 'quota' ? 'quota' : 'too-large', html);
        return;
      }
      // The starter moved the file to Trash or deleted it while this version was being made.
      const gone = await transaction(workspaceId, async tx => {
        const current = await loadPlan(tx, planId, true);
        const fileId = current?.fileId ?? (placed.kind === 'create' ? null : plan.fileId);
        if (fileId && (await fileGone(tx, fileId))) {
          await detach(tx, planId);
          return true;
        }
        return placed.kind === 'create' && error instanceof FileError && error.code === 'conflict';
      });
      if (!gone) throw error;
      await transaction(workspaceId, tx => record(tx, workspaceId, planId, at, { status: 'ready', html, stampTone }));
      return;
    }
    // Renames follow the title only while nobody has renamed the file by hand.
    const name = planDocumentFileName(plan.title);
    if (placed.kind === 'version' && plan.namedFrom && name !== plan.namedFrom) {
      const renamed = await transaction(workspaceId, async tx =>
        (
          await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_files')} WHERE id=$1 AND name=$2`, [
            filed.fileId,
            plan.namedFrom,
          ])
        ).rowCount
          ? true
          : false,
      );
      if (renamed) {
        await files.rename(workspaceId, plan.starterUserId, filed.fileId, name).then(
          () =>
            transaction(workspaceId, tx =>
              tx.client.query(`UPDATE ${relation(tx, 'tf_agent_plans')} SET document_file_named_from=$2 WHERE id=$1`, [
                planId,
                name,
              ]),
            ),
          () => undefined,
        );
      }
    }
    await transaction(workspaceId, async tx => {
      await lockAuthorization(tx, 'write');
      const current = await loadPlan(tx, planId, true);
      if (!current) throw new AccessDenied();
      if (!(await fileGone(tx, filed.fileId))) {
        // Project members can read the plan in the chat already; they get the PDF as viewers (P35).
        const members = current.projectId
          ? z.array(z.object({ id: uuidSchema })).parse(
              (
                await tx.client.query(
                  `SELECT pm.membership_id AS id FROM ${relation(tx, 'tf_project_members')} pm
                  JOIN ${relation(tx, 'tf_memberships')} m ON m.id=pm.membership_id AND m.removed_at IS NULL
                  WHERE pm.project_id=$1 AND pm.removed_at IS NULL AND pm.membership_id<>$2`,
                  [current.projectId, current.starterMembershipId],
                )
              ).rows,
            )
          : [];
        await syncFileGrantsForOrigin(
          tx,
          filed.fileId,
          `plan-project:${planId}`,
          members.map(member => ({ subject: { kind: 'individual' as const, id: member.id }, role: 'viewer' as const })),
        );
      }
      await record(tx, workspaceId, planId, at, { status: 'ready', html, stampTone, pdf: filed });
    });
  }

  return {
    /**
     * Marks the plan's current rendering as due and returns true when it has none yet, so the caller starts the
     * workflow. A plan saved before revisions gets its revision row now.
     */
    async claim(workspaceId: string, planId: string): Promise<boolean> {
      return transaction(workspaceId, async tx => {
        const plan = await loadPlan(tx, planId, true);
        if (!plan) return false;
        const at = await target(tx, planId, plan.revision);
        if (await documentRow(tx, planId, at)) return false;
        await currentRevision(tx, planId);
        const inserted = await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_documents')} (plan_id,revision,generation,dispatched_at) VALUES ($1,$2,$3,clock_timestamp())
          ON CONFLICT DO NOTHING`,
          [planId, at.revision, at.generation],
        );
        return Boolean(inserted.rowCount);
      });
    },
    /** Plans whose rendering was dispatched more than ten minutes ago and has not finished, marked as dispatched again. */
    async stalled(workspaceId: string): Promise<string[]> {
      return transaction(workspaceId, async tx =>
        z
          .array(z.object({ planId: uuidSchema }))
          .parse(
            (
              await tx.client.query(
                `UPDATE ${relation(tx, 'tf_agent_plan_documents')} d SET dispatched_at=clock_timestamp()
              FROM (SELECT plan_id, revision, generation FROM ${relation(tx, 'tf_agent_plan_documents')}
                WHERE status IN ('pending','rendering') AND (dispatched_at IS NULL OR dispatched_at < clock_timestamp() - interval '10 minutes')
                ORDER BY dispatched_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED) due
              WHERE d.plan_id=due.plan_id AND d.revision=due.revision AND d.generation=due.generation
              RETURNING d.plan_id AS "planId"`,
              )
            ).rows,
          )
          .map(row => row.planId),
      );
    },
    /**
     * Claims the plan's current rendering and builds what the render worker draws. Returns null when there is nothing to
     * do: the rendering finished, or failed and is not being retried.
     */
    async prepare(
      workspaceId: string,
      planId: string,
      mode: PlanDocumentMode,
      names: PlanDocumentNames,
    ): Promise<PreparedPlanDocument | null> {
      const source = await transaction(workspaceId, async tx => {
        const plan = await loadPlan(tx, planId, true);
        if (!plan) return null;
        await currentRevision(tx, planId);
        const { count, latest } = await approvals(tx, planId);
        const at = { revision: plan.revision, generation: count };
        const row = await documentRow(tx, planId, at);
        if (row && mode === 'auto' && (row.status === 'ready' || row.status === 'failed')) return null;
        if (row && mode === 'retry' && row.status === 'ready') return null;
        // Renderings of earlier revisions that never finished were superseded; the newest one is what Document shows.
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plan_documents')} SET status='failed', error='render', updated_at=clock_timestamp()
          WHERE plan_id=$1 AND status IN ('pending','rendering') AND (revision,generation)<>($2,$3)`,
          [planId, at.revision, at.generation],
        );
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_agent_plan_documents')} (plan_id,revision,generation,status,dispatched_at) VALUES ($1,$2,$3,'rendering',clock_timestamp())
          ON CONFLICT (plan_id,revision,generation) DO UPDATE SET status='rendering', error=NULL, dispatched_at=clock_timestamp(), updated_at=clock_timestamp()`,
          [planId, at.revision, at.generation],
        );
        const revisions = z
          .array(
            z.object({
              revision: z.number().int().positive(),
              snapshot: z.unknown(),
              changeKind: z.enum(['starter', 'runtime']),
              createdAt: z.string(),
            }),
          )
          .parse(
            (
              await tx.client.query(
                `SELECT revision, snapshot, change_kind AS "changeKind", to_json(created_at)#>>'{}' AS "createdAt"
                FROM ${relation(tx, 'tf_agent_plan_revisions')} WHERE plan_id=$1 AND revision BETWEEN $2 AND $3 ORDER BY revision DESC`,
                // The change list runs from the latest approved revision; a plan never approved has none.
                [planId, Math.min(latest?.revision ?? at.revision, at.revision), at.revision],
              )
            ).rows,
          );
        const [current] = revisions;
        if (!current || current.revision !== at.revision) throw new AgentPlanError('document-unavailable');
        return { plan, at, current, history: [...revisions].reverse(), approval: latest };
      });
      if (!source) return null;
      const { plan, at, current, history, approval } = source;
      const people = await names(
        [plan.starterUserId, ...(approval?.userId ? [approval.userId] : [])].filter(
          (id, index, all) => all.indexOf(id) === index,
        ),
      );
      const starterName = people.get(plan.starterUserId) || 'Unknown member';
      const approverName = (approval?.userId && people.get(approval.userId)) || 'Unknown member';
      const timeZone = approval?.timeZone ?? 'UTC';
      const input = documentInput(snapshotSchema.parse(current.snapshot), at.revision, current.createdAt, starterName);
      const revisionModel = (revision: (typeof history)[number]) =>
        planDocumentModel(
          documentInput(snapshotSchema.parse(revision.snapshot), revision.revision, current.createdAt, starterName),
        );
      // Each step since the approved revision is listed with who made it: the starter, or the plan while running.
      const changes = history
        .slice(1)
        .flatMap((revision, index) =>
          changeList(revisionModel(history[index]!), revisionModel(revision), revision.changeKind),
        );
      const model = planDocumentModel({
        ...input,
        approval: approval ? { approverName, approvedAt: approval.approvedAt, revision: approval.revision } : null,
        changes,
      });
      const stamp = planStamp({
        ...(approval ? { approval: { approverName, approvedAt: approval.approvedAt } } : {}),
        contentRevision: at.revision,
        ...(approval ? { approvedRevision: approval.revision } : {}),
        timeZone,
      });
      return { ...at, job: { workspaceId, model, stamp, timeZone } };
    },
    fail,
    /**
     * Files a drawn document: the first PDF goes into the starter's `plans` folder, later ones are versions of it. A
     * project chat's members get viewer access, and the rendering is recorded as ready. The PDF object is removed after.
     */
    async publish(
      workspaceId: string,
      planId: string,
      at: PlanDocumentTarget,
      result: PlanDocumentRenderResult & { stampTone: string },
      files: Files,
      objects: PlanDocumentObjects,
    ) {
      try {
        await publishFiled(workspaceId, planId, at, result, files, objects);
      } finally {
        if (result.pdf) await objects.remove(result.pdf.key).catch(() => undefined);
      }
    },
    /**
     * The stored page of a revision, for someone who can read the chat. Others than the starter must also be able to
     * open the plan's PDF (P16).
     */
    async page(workspaceId: string, user: string, planId: string, revision: number) {
      return humanTransaction(workspaceId, user, false, async (tx, actor) => {
        const plan = await readablePlan(tx, actor, planId);
        const page = z
          .object({
            key: uuidSchema,
            size: z.number().int().positive(),
            sha256: z.string(),
            fileId: uuidSchema.nullable(),
          })
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT html_object_key AS key, html_size AS size, html_digest AS sha256, pdf_file_id AS "fileId"
                FROM ${relation(tx, 'tf_agent_plan_documents')} WHERE plan_id=$1 AND revision=$2 AND html_object_key IS NOT NULL
                ORDER BY generation DESC LIMIT 1`,
                [planId, z.number().int().positive().parse(revision)],
              )
            ).rows[0],
          );
        if (!page) throw new AgentPlanError('document-unavailable');
        if (!isStarter(plan, actor)) {
          const fileId = plan.fileDetached ? null : (plan.fileId ?? page.fileId);
          if (!fileId) throw new AccessDenied();
          await requireReadableFile(tx, actor, fileId);
        }
        return { key: page.key, size: page.size, sha256: page.sha256 };
      });
    },
    /**
     * Lets the starter render the current revision again after it failed. Returns the mode to start the workflow with,
     * or null when it isn't failed.
     */
    async retry(workspaceId: string, user: string, planId: string): Promise<PlanDocumentMode | null> {
      return humanTransaction(workspaceId, user, true, async (tx, actor) => {
        const plan = await readablePlan(tx, actor, planId, true);
        if (!isStarter(plan, actor)) throw new AgentPlanError('not-starter');
        const at = await target(tx, planId, plan.revision);
        const row = await documentRow(tx, planId, at);
        if (row && row.status !== 'failed') return null;
        await requeue(tx, workspaceId, planId, at);
        return 'retry' as const;
      });
    },
    /** Lets the starter file a new PDF after moving the old one to Trash or deleting it (P20). */
    async recreate(workspaceId: string, user: string, planId: string): Promise<PlanDocumentMode> {
      return humanTransaction(workspaceId, user, true, async (tx, actor) => {
        const plan = await readablePlan(tx, actor, planId, true);
        if (!isStarter(plan, actor)) throw new AgentPlanError('not-starter');
        if (plan.fileId && !plan.fileDetached && !(await fileGone(tx, plan.fileId)))
          throw new AgentPlanError('document-unavailable');
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_agent_plans')} SET document_file_id=NULL, document_file_detached=false, document_file_named_from=NULL WHERE id=$1`,
          [planId],
        );
        await requeue(tx, workspaceId, planId, await target(tx, planId, plan.revision));
        return 'recreate' as const;
      });
    },
  };
}
