import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, uuidSchema, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  FileError,
  fileRoleSchema,
  itemSchema,
  roleLevel,
  type FileAudienceMember,
  type FileGrant,
  type FileItem,
  type FileReference,
  type FileRole,
  type FileSharingContribution,
  type FileSharingSnapshot,
  type MoveAudience,
  type MovePreview,
  type ReadableFileReference,
} from './contracts.ts';

const version = { row_version: z.string() };
const rowSchema = itemSchema.extend(version);
const grantSchema = z.object({
  item_id: uuidSchema,
  subject_kind: z.enum(['individual', 'team']),
  subject_id: uuidSchema,
  role: fileRoleSchema,
  ...version,
});
const membershipSchema = z.object({
  id: uuidSchema,
  user_id: z.string(),
  role: z.enum(['admin', 'member']),
  created_at: z.date(),
  removed_at: z.date().nullable(),
  ...version,
});
const teamSchema = z.object({ id: uuidSchema, name: z.string(), created_at: z.date(), ...version });
const enrollmentSchema = z.object({ membership_id: uuidSchema, team_id: uuidSchema, ...version });
type SharingGraph = Awaited<ReturnType<typeof loadSharingGraph>>;
type Grant = z.infer<typeof grantSchema>;

export const sharingGraphLimits = Object.freeze({
  items: 2_000,
  grants: 20_000,
  memberships: 10_000,
  teams: 2_000,
  enrollments: 20_000,
  lineage: 128,
  audienceEntries: 200_000,
  roleChecks: 20_000_000,
});

function withinLimit(value: number, limit: number) {
  if (value > limit) throw new FileError('graph-limit');
}

export async function loadSharingGraph(
  tx: AuthorizationTransaction,
  id: string,
  parentId: string | null = null,
  descendants = false,
) {
  const table = (name: string) => qualified(tx.schema, name);
  const items = z.array(rowSchema).parse(
    (
      await tx.client.query(
        `WITH RECURSIVE subtree AS (
    SELECT id FROM ${table('tf_files')} WHERE id = $1
    UNION SELECT f.id FROM ${table('tf_files')} f JOIN subtree s ON f.parent_id = s.id WHERE $3
  ), lineage AS (
    SELECT id, parent_id FROM ${table('tf_files')} WHERE id = $1 OR id = $2
    UNION SELECT f.id, f.parent_id FROM ${table('tf_files')} f JOIN lineage a ON a.parent_id = f.id
  ), subtree_ids AS MATERIALIZED (SELECT id FROM subtree LIMIT $4),
    lineage_ids AS MATERIALIZED (SELECT id FROM lineage LIMIT $4)
    SELECT f.*, f.xmin::text AS row_version FROM ${table('tf_files')} f
    WHERE f.id IN (SELECT id FROM subtree_ids UNION SELECT id FROM lineage_ids)
    ORDER BY f.id LIMIT $4`,
        [id, parentId, descendants, sharingGraphLimits.items + 1],
      )
    ).rows,
  );
  withinLimit(items.length, sharingGraphLimits.items);
  const grants = z.array(grantSchema).parse(
    (
      await tx.client.query(
        `SELECT g.*, g.xmin::text AS row_version
    FROM ${table('tf_file_grants')} g WHERE item_id = ANY($1::uuid[]) ORDER BY item_id, subject_kind, subject_id LIMIT $2`,
        [items.map(item => item.id), sharingGraphLimits.grants + 1],
      )
    ).rows,
  );
  withinLimit(grants.length, sharingGraphLimits.grants);
  const memberships = z
    .array(membershipSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT m.*, m.xmin::text AS row_version FROM ${table('tf_memberships')} m ORDER BY id LIMIT $1`,
          [sharingGraphLimits.memberships + 1],
        )
      ).rows,
    );
  withinLimit(memberships.length, sharingGraphLimits.memberships);
  const teams = z
    .array(teamSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT t.*, t.xmin::text AS row_version FROM ${table('tf_teams')} t ORDER BY id LIMIT $1`,
          [sharingGraphLimits.teams + 1],
        )
      ).rows,
    );
  withinLimit(teams.length, sharingGraphLimits.teams);
  const enrollments = z
    .array(enrollmentSchema)
    .parse(
      (
        await tx.client.query(
          `SELECT e.*, e.xmin::text AS row_version FROM ${table('tf_member_teams')} e ORDER BY membership_id, team_id LIMIT $1`,
          [sharingGraphLimits.enrollments + 1],
        )
      ).rows,
    );
  withinLimit(enrollments.length, sharingGraphLimits.enrollments);
  const byId = new Map(items.map(item => [item.id, item]));
  const activeMemberships = new Set(memberships.filter(member => member.removed_at === null).map(member => member.id));
  const teamIds = new Set(teams.map(team => team.id));
  const memberTeams = new Map<string, Set<string>>();
  for (const enrollment of enrollments) {
    if (!teamIds.has(enrollment.team_id)) continue;
    const ids = memberTeams.get(enrollment.membership_id) ?? new Set<string>();
    ids.add(enrollment.team_id);
    memberTeams.set(enrollment.membership_id, ids);
  }
  const grantsByItem = new Map<string, Grant[]>();
  for (const grant of grants) {
    const direct = grantsByItem.get(grant.item_id) ?? [];
    direct.push(grant);
    grantsByItem.set(grant.item_id, direct);
  }
  return { items, grants, memberships, teams, enrollments, byId, activeMemberships, memberTeams, grantsByItem };
}

function chain(graph: SharingGraph, id: string, move?: { id: string; parentId: string | null }) {
  const result: FileItem[] = [];
  const visited = new Set<string>();
  let current: string | null = id;
  while (current !== null) {
    if (visited.has(current)) throw new FileError('invalid-move');
    visited.add(current);
    const item = graph.byId.get(current);
    if (!item) throw new AccessDenied();
    result.push(current === move?.id ? { ...item, trashed_at: null } : item);
    withinLimit(result.length, sharingGraphLimits.lineage);
    current = current === move?.id ? move.parentId : item.parent_id;
  }
  return result;
}

function effectiveRole(graph: SharingGraph, lineage: FileItem[], membershipId: string): FileRole | null {
  if (!graph.activeMemberships.has(membershipId)) return null;
  let role: FileRole | null = null;
  for (const item of lineage) {
    if (item.creator_membership_id === membershipId) return 'manager';
    for (const grant of graph.grantsByItem.get(item.id) ?? []) {
      const applies =
        grant.subject_kind === 'individual'
          ? grant.subject_id === membershipId
          : graph.memberTeams.get(membershipId)?.has(grant.subject_id);
      if (applies && (role === null || roleLevel[grant.role] > roleLevel[role])) role = grant.role;
    }
  }
  return role;
}

function available(lineage: FileItem[], trashId?: string) {
  return lineage.every(item => item.ready && (item.trashed_at === null || item.id === trashId));
}

export function requireFileAccess(
  graph: SharingGraph,
  actor: HumanActor,
  id: string,
  required: FileRole = 'viewer',
  trash = false,
  stranded = false,
) {
  const lineage = chain(graph, id);
  const item = graph.byId.get(id);
  const role = effectiveRole(graph, lineage, actor.membershipId);
  const rescue =
    stranded &&
    item?.creator_membership_id === actor.membershipId &&
    lineage.every(entry => entry.ready) &&
    lineage.slice(1).some(entry => entry.trashed_at);
  if (
    !item ||
    !(rescue || available(lineage, trash ? id : undefined)) ||
    role === null ||
    roleLevel[role] < roleLevel[required]
  )
    throw new AccessDenied();
  return { item, role };
}

const readable = (item: FileItem): ReadableFileReference => ({ kind: 'readable', id: item.id, name: item.name });
/** A move preview passes the moved lineage too: restoring a stranded item makes it and its contents readable again. */
function reference(graph: SharingGraph, actor: HumanActor, item: FileItem, moved?: FileItem[]): FileReference {
  const lineage = chain(graph, item.id);
  const reachable = (path: FileItem[]) => available(path) && effectiveRole(graph, path, actor.membershipId) !== null;
  return reachable(lineage) || (moved !== undefined && reachable(moved)) ? readable(item) : { kind: 'restricted' };
}
const publicGrant = (grant: Grant): FileGrant => ({
  subject: { kind: grant.subject_kind, id: grant.subject_id },
  role: grant.role,
});
function audience(graph: SharingGraph, lineage: FileItem[]): FileAudienceMember[] {
  return graph.memberships.flatMap(member => {
    const role = effectiveRole(graph, lineage, member.id);
    return role === null ? [] : [{ membershipId: member.id, role }];
  });
}

function requireAudienceBudget(graph: SharingGraph, lineages: FileItem[][]) {
  withinLimit(graph.memberships.length * lineages.length, sharingGraphLimits.audienceEntries);
  const checks = lineages.reduce(
    (total, lineage) =>
      total + lineage.reduce((cost, item) => cost + 1 + (graph.grantsByItem.get(item.id)?.length ?? 0), 0),
    0,
  );
  withinLimit(graph.memberships.length * checks, sharingGraphLimits.roleChecks);
}

export function sharingSnapshot(graph: SharingGraph, actor: HumanActor, id: string): FileSharingSnapshot {
  const { item } = requireFileAccess(graph, actor, id, 'manager');
  const lineage = chain(graph, id);
  requireAudienceBudget(graph, [lineage]);
  const ownership = (item: FileItem) => ({
    membershipId: item.creator_membership_id,
    active: graph.activeMemberships.has(item.creator_membership_id),
  });
  const inherited: FileSharingContribution[] = [];
  for (const ancestor of lineage.slice(1)) {
    const source = reference(graph, actor, ancestor);
    inherited.push({ kind: 'ownership', source, owner: ownership(ancestor) });
    for (const grant of graph.grantsByItem.get(ancestor.id) ?? [])
      inherited.push({ kind: 'grant', source, grant: publicGrant(grant) });
  }
  return {
    item: readable(item),
    creator: ownership(item),
    effectiveRole: 'manager',
    directGrants: (graph.grantsByItem.get(id) ?? []).map(publicGrant),
    inherited,
    effectiveAudience: audience(graph, lineage),
  };
}

export function movePreview(
  graph: SharingGraph,
  actor: HumanActor,
  workspaceId: string,
  id: string,
  parentId: string | null,
): MovePreview {
  const { item } = requireFileAccess(graph, actor, id, 'manager', true, true);
  let destination: MovePreview['destination'] = { kind: 'root' };
  if (parentId !== null) {
    const target = requireFileAccess(graph, actor, parentId, 'editor');
    if (target.item.kind !== 'folder' || chain(graph, parentId).some(ancestor => ancestor.id === id))
      throw new FileError('invalid-move');
    destination = { kind: 'folder', item: readable(target.item), effectiveRole: target.role };
  }
  const changes = graph.items.flatMap(child => {
    const before = chain(graph, child.id);
    return before.some(ancestor => ancestor.id === id)
      ? [{ child, before, after: chain(graph, child.id, { id, parentId }) }]
      : [];
  });
  requireAudienceBudget(
    graph,
    changes.flatMap(change => [change.before, change.after]),
  );
  const state = (lineage: FileItem[]): MoveAudience => ({
    availability: available(lineage) ? 'available' : 'unavailable',
    audience: audience(graph, lineage),
  });
  const subtree = changes.map(({ child, before, after }) => ({
    item: reference(graph, actor, child, after),
    before: state(before),
    after: state(after),
  }));
  // Row versions detect committed update/revert cycles, not permanent history or transient absent rows.
  const fingerprint =
    'files-move-v1:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          'files-move-v1',
          workspaceId,
          actor.membershipId,
          actor.userId,
          id,
          parentId,
          graph.items,
          graph.grants,
          graph.memberships,
          graph.teams,
          graph.enrollments,
        ]),
      )
      .digest('hex');
  return { source: readable(item), destination, subtree, fingerprint };
}
