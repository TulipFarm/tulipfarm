import { randomUUID } from 'node:crypto';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import { grantTable, hasGrant, requireGrant, workflowMember, type GrantDomain } from './authorization.ts';
import { recordRecommendationChange, recommendationsInstalled } from '@tulipfarm/workspace-storage/recommendations';
import { idSchema, principalSchema } from './contracts.ts';
import { WorkflowConflict } from './commands.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
export async function sharingCandidates(tx: AuthorizationTransaction, user: string) {
  const actor = await workflowMember(tx, user);
  const people = z
    .array(z.object({ id: idSchema, userId: z.string(), name: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,user_id AS "userId",user_id AS name FROM ${table(tx, 'tf_memberships')} WHERE removed_at IS NULL ORDER BY user_id`,
        )
      ).rows,
    );
  const teams = z
    .array(z.object({ id: idSchema, name: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT t.id,t.name FROM ${table(tx, 'tf_teams')} t JOIN ${table(tx, 'tf_member_teams')} mt ON mt.team_id=t.id WHERE mt.membership_id=$1 ORDER BY t.name`,
          [actor.membershipId],
        )
      ).rows,
    );
  return { membershipId: actor.membershipId, people, teams };
}
export async function listGrants(tx: AuthorizationTransaction, user: string, id: string, domain: GrantDomain) {
  const actor = await workflowMember(tx, user);
  await requireGrant(tx, actor.membershipId, id, 'manage', domain);
  const target = grantTable(domain);
  return z
    .array(z.object({ membershipId: idSchema.nullable(), teamId: idSchema.nullable(), permission: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT membership_id AS "membershipId",team_id AS "teamId",permission FROM ${table(tx, target.name)} WHERE ${target.column}=$1 ORDER BY membership_id,team_id,permission`,
          [id],
        )
      ).rows,
    );
}
export async function changeGrant(
  tx: AuthorizationTransaction,
  user: string,
  id: string,
  value: unknown,
  domain: GrantDomain,
) {
  const input = z
    .strictObject({
      principal: principalSchema,
      permissions: z
        .array(domain === 'workflow' ? z.enum(['read', 'invoke', 'manage']) : z.enum(['use', 'manage']))
        .max(3),
    })
    .parse(value);
  const actor = await workflowMember(tx, user);
  await requireGrant(tx, actor.membershipId, id, 'manage', domain);
  const principal = input.principal;
  // Revocation needs only manage authority. Granting needs a current person or a team the manager belongs to.
  if (input.permissions.length) {
    const recipient =
      principal.kind === 'person'
        ? await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`, [
            principal.id,
          ])
        : await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_member_teams')} WHERE team_id=$1 AND membership_id=$2`, [
            principal.id,
            actor.membershipId,
          ]);
    if (!recipient.rowCount) throw new AccessDenied();
  }
  const target = grantTable(domain),
    column = principal.kind === 'person' ? 'membership_id' : 'team_id';
  const active =
    (await recommendationsInstalled(tx)) &&
    (domain !== 'workflow' ||
      !!(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_workflows')} WHERE id=$1 AND active_revision IS NOT NULL AND enabled AND archived_at IS NULL`,
          [id],
        )
      ).rowCount);
  const members = active
    ? z
        .array(z.object({ id: idSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT m.id FROM ${table(tx, 'tf_memberships')} m WHERE m.removed_at IS NULL AND ${
                principal.kind === 'person'
                  ? 'm.id=$1'
                  : `EXISTS(SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=$1)`
              } ORDER BY m.id`,
              [principal.id],
            )
          ).rows,
        )
    : [];
  const permissions =
    domain === 'workflow' ? (['read', 'invoke', 'manage'] as const) : (['read', 'use', 'manage'] as const);
  const before = new Map<string, boolean[]>();
  for (const member of members) {
    const grants: boolean[] = [];
    for (const permission of permissions) grants.push(await hasGrant(tx, member.id, id, permission, domain));
    before.set(member.id, grants);
  }
  await tx.client.query(`DELETE FROM ${table(tx, target.name)} WHERE ${target.column}=$1 AND ${column}=$2`, [
    id,
    principal.id,
  ]);
  for (const permission of new Set(input.permissions))
    await tx.client.query(
      `INSERT INTO ${table(tx, target.name)} (${target.column},${column},permission) VALUES ($1,$2,$3)`,
      [id, principal.id, permission],
    );
  const managers = await tx.client.query(
    `SELECT 1 FROM ${table(tx, target.name)} g JOIN ${table(tx, 'tf_memberships')} m ON m.removed_at IS NULL AND (m.id=g.membership_id OR EXISTS (SELECT 1 FROM ${table(tx, 'tf_member_teams')} mt WHERE mt.team_id=g.team_id AND mt.membership_id=m.id)) WHERE g.${target.column}=$1 AND g.permission='manage' LIMIT 1`,
    [id],
  );
  if (!managers.rowCount) throw new WorkflowConflict('manager-handoff-required');
  await tx.client.query(
    `INSERT INTO ${table(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), actor.membershipId, `workflow.${domain}.sharing`, id],
  );
  for (const member of members) {
    const previous = before.get(member.id)!;
    const current: boolean[] = [];
    for (const permission of permissions) current.push(await hasGrant(tx, member.id, id, permission, domain));
    if (previous.some((value, index) => value !== current[index]))
      await recordRecommendationChange(tx, {
        id: randomUUID(),
        kind: domain === 'workflow' ? 'definition' : 'integration',
        sourceId: id,
        membershipIds: [member.id],
        invalidate: previous.some((value, index) => value && !current[index]),
      });
  }
  return { saved: true };
}
