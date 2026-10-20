import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import {
  AccessDenied,
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { ConversationRuntime } from './runtime.ts';

const text = z
  .string()
  .refine(
    value =>
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Invalid text',
  );
export const createProjectSchema = z.strictObject({ id: uuidSchema, name: text.trim().min(1).max(160) });
export const editProjectSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  name: text.trim().min(1).max(160),
  instructions: text.refine(value => Buffer.byteLength(value) <= 65536, 'Instructions exceed 64 KiB'),
  archived: z.boolean(),
});
export const projectMemberSchema = z.strictObject({
  membershipId: uuidSchema,
  role: z.enum(['manager', 'member']),
  removed: z.boolean(),
});
export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  instructions: z.string(),
  revision: z.number().int(),
  archived: z.boolean(),
  manager: z.boolean(),
});
export class ProjectConflict extends Error {
  constructor() {
    super('project-conflict');
  }
}
// A project keeps at least one current manager. The last manager hands off before leaving or stepping down.
export class ProjectManagerRequired extends Error {
  constructor() {
    super('project-manager-required');
  }
}
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);

// Project access comes only from current project membership. Workspace admin status grants nothing here.
export async function requireProjectAccess(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  projectId: string,
  manage = false,
) {
  await currentMember(tx, actor);
  const project = projectSchema.optional().parse(
    (
      await tx.client.query(
        `SELECT p.id,p.name,p.instructions,p.revision,p.archived_at IS NOT NULL AS archived,
    pm.role='manager' AS manager FROM ${table(tx, 'tf_projects')} p
    JOIN ${table(tx, 'tf_project_members')} pm ON pm.project_id=p.id AND pm.membership_id=$2 AND pm.removed_at IS NULL
    WHERE p.id=$1`,
        [projectId, actor.membershipId],
      )
    ).rows[0],
  );
  if (!project || (manage && !project.manager)) throw new AccessDenied();
  return project;
}

/** Everyone who can read a project chat: its current project members. Admin status grants no project access. */
export async function projectReaders(tx: AuthorizationTransaction, projectId: string): Promise<HumanActor[]> {
  return z
    .array(z.object({ userId: z.string(), membershipId: uuidSchema }))
    .parse(
      (
        await tx.client.query(
          `SELECT m.user_id AS "userId",m.id AS "membershipId" FROM ${table(tx, 'tf_memberships')} m
    WHERE m.removed_at IS NULL AND EXISTS (SELECT 1 FROM ${table(tx, 'tf_project_members')} pm WHERE pm.project_id=$1 AND pm.membership_id=m.id AND pm.removed_at IS NULL)`,
          [projectId],
        )
      ).rows,
    )
    .map(reader => ({ kind: 'human', ...reader }));
}

export function createProjectMembership(runtime: ConversationRuntime, compatibility = commonCompatibility) {
  async function human<T>(
    workspaceId: string,
    userId: string,
    write: boolean,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      return operation(tx, await resolveHuman(tx, userId));
    });
  }
  async function create(workspaceId: string, userId: string, value: unknown) {
    denyMcpEgress();
    const input = createProjectSchema.parse(value);
    return human(workspaceId, userId, true, async (tx, actor) => {
      const prior = (
        await tx.client.query(`SELECT creator_membership_id,name FROM ${table(tx, 'tf_projects')} WHERE id=$1`, [
          input.id,
        ])
      ).rows[0];
      if (prior) {
        if (prior.creator_membership_id !== actor.membershipId || prior.name !== input.name)
          throw new ProjectConflict();
        return requireProjectAccess(tx, actor, input.id);
      }
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_projects')} (id,name,creator_membership_id) VALUES ($1,$2,$3)`,
        [input.id, input.name, actor.membershipId],
      );
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'manager')`,
        [input.id, actor.membershipId],
      );
      await recordRecommendationChange(tx, {
        id: randomUUID(),
        kind: 'project',
        sourceId: input.id,
        membershipIds: [actor.membershipId],
      });
      return requireProjectAccess(tx, actor, input.id);
    });
  }
  async function list(workspaceId: string, userId: string) {
    return human(workspaceId, userId, false, async (tx, actor) => {
      return z.array(projectSchema).parse(
        (
          await tx.client.query(
            `SELECT p.id,p.name,p.instructions,p.revision,p.archived_at IS NOT NULL AS archived,pm.role='manager' AS manager
        FROM ${table(tx, 'tf_projects')} p JOIN ${table(tx, 'tf_project_members')} pm ON pm.project_id=p.id AND pm.membership_id=$1 AND pm.removed_at IS NULL
        ORDER BY p.created_at DESC,p.id`,
            [actor.membershipId],
          )
        ).rows,
      );
    });
  }
  async function read(workspaceId: string, userId: string, projectId: string) {
    projectId = uuidSchema.parse(projectId);
    return human(workspaceId, userId, false, async (tx, actor) => {
      const project = await requireProjectAccess(tx, actor, projectId);
      const members = z
        .array(z.object({ membershipId: uuidSchema, userId: z.string(), role: z.enum(['manager', 'member']) }))
        .parse(
          (
            await tx.client.query(
              `SELECT m.id AS "membershipId",m.user_id AS "userId",pm.role FROM ${table(tx, 'tf_project_members')} pm JOIN ${table(tx, 'tf_memberships')} m ON m.id=pm.membership_id WHERE pm.project_id=$1 AND pm.removed_at IS NULL AND m.removed_at IS NULL ORDER BY m.user_id`,
              [projectId],
            )
          ).rows,
        );
      return { project, members };
    });
  }
  async function edit(workspaceId: string, userId: string, projectId: string, value: unknown) {
    denyMcpEgress();
    projectId = uuidSchema.parse(projectId);
    const input = editProjectSchema.parse(value);
    return human(workspaceId, userId, true, async (tx, actor) => {
      const current = await requireProjectAccess(tx, actor, projectId, true);
      if (current.revision !== input.expectedRevision) {
        if (
          current.revision === input.expectedRevision + 1 &&
          current.name === input.name &&
          current.instructions === input.instructions &&
          current.archived === input.archived
        )
          return current;
        throw new ProjectConflict();
      }
      await tx.client.query(
        `UPDATE ${table(tx, 'tf_projects')} SET name=$2,instructions=$3,archived_at=CASE WHEN $4 THEN COALESCE(archived_at,clock_timestamp()) ELSE NULL END,revision=revision+1 WHERE id=$1`,
        [projectId, input.name, input.instructions, input.archived],
      );
      if (current.instructions !== input.instructions || current.archived !== input.archived) {
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'project',
          sourceId: projectId,
          membershipIds: (await projectReaders(tx, projectId)).map(reader => reader.membershipId),
          invalidate: true,
        });
      }
      return requireProjectAccess(tx, actor, projectId);
    });
  }
  async function member(workspaceId: string, userId: string, projectId: string, value: unknown) {
    projectId = uuidSchema.parse(projectId);
    const input = projectMemberSchema.parse(value);
    return human(workspaceId, userId, true, async (tx, actor) => {
      const leaving = input.removed && input.membershipId === actor.membershipId;
      await requireProjectAccess(tx, actor, projectId, !leaving);
      if (
        !(
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
            input.membershipId,
          ])
        ).rowCount
      )
        throw new AccessDenied();
      const current = z
        .object({ role: z.enum(['manager', 'member']) })
        .optional()
        .parse(
          (
            await tx.client.query(
              `SELECT role FROM ${table(tx, 'tf_project_members')} WHERE project_id=$1 AND membership_id=$2 AND removed_at IS NULL FOR UPDATE`,
              [projectId, input.membershipId],
            )
          ).rows[0],
        );
      if (current?.role === 'manager' && (input.removed || input.role !== 'manager')) {
        const others = await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_project_members')} pm JOIN ${table(tx, 'tf_memberships')} m ON m.id=pm.membership_id AND m.removed_at IS NULL
          WHERE pm.project_id=$1 AND pm.membership_id<>$2 AND pm.role='manager' AND pm.removed_at IS NULL LIMIT 1`,
          [projectId, input.membershipId],
        );
        if (!others.rowCount) throw new ProjectManagerRequired();
      }
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_project_members')} AS pm (project_id,membership_id,role,removed_at) VALUES ($1,$2,$3,CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)
        ON CONFLICT (project_id,membership_id) DO UPDATE SET role=CASE WHEN $4 THEN pm.role ELSE EXCLUDED.role END,removed_at=EXCLUDED.removed_at`,
        [projectId, input.membershipId, input.role, input.removed],
      );
      if (input.removed ? current !== undefined : current?.role !== input.role) {
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'project',
          sourceId: projectId,
          membershipIds: [
            input.membershipId,
            ...(await projectReaders(tx, projectId)).map(reader => reader.membershipId),
          ],
          invalidate: true,
        });
      }
      return { saved: true };
    });
  }
  return { create, list, read, edit, member };
}
