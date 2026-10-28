import { z } from 'zod';
import { createWorkspace } from '@tulipfarm/workspaces/store';
import { createWorkspaceMaintenance } from '@tulipfarm/workspaces/lifecycle';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { workspaceSlugError } from '@tulipfarm/workspaces/contracts';
import { commonCompatibility } from '@tulipfarm/workspaces/storage';
import { activeGeneration, readRecord, workspaceMembersTable } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { manualWorkspaceMemberValues } from '@tulipfarm/tables/workspace-members';
import { apiOrigin, webOrigin } from './env.ts';
import type { SeedContext } from './context.ts';
import type { ManifestUser, ManifestWorkspace } from './manifest.ts';
import { stableId } from './random.ts';

export const seedSlugPrefix = 'seed-';
export const seedEmailDomain = 'tulipfarm.test';

export function signInUrl(email: string, redirect = '/') {
  const url = new URL('/v1/dev/session', apiOrigin());
  url.search = new URLSearchParams({ email, redirect }).toString();
  return url.toString();
}

export async function ensureUser(context: SeedContext, email: string, name: string): Promise<ManifestUser> {
  const address = email.trim().toLowerCase();
  const existing = z
    .object({ id: z.string(), name: z.string() })
    .optional()
    .parse((await context.identity.query('SELECT id, name FROM app.users WHERE lower(email) = $1', [address])).rows[0]);
  let id = existing?.id;
  if (!existing) id = (await context.sessions.signIn(address, name)).user.id;
  else if (!existing.name.trim())
    await context.identity.query('UPDATE app.users SET name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [
      existing.id,
      name,
    ]);
  const user = { id: id!, email: address, name: existing?.name.trim() || name, signInUrl: signInUrl(address) };
  context.manifest.users[address] = user;
  return user;
}

export function workspaceUrl(slug: string, path = '') {
  return new URL(`/${slug}${path ? `/${path}` : ''}`, webOrigin()).toString();
}

export async function ensureWorkspace(
  context: SeedContext,
  owner: ManifestUser,
  input: { slug: string; name: string; scenario: string },
): Promise<ManifestWorkspace> {
  const slug = input.slug.startsWith(seedSlugPrefix) ? input.slug : `${seedSlugPrefix}${input.slug}`;
  const slugError = workspaceSlugError(slug);
  if (slugError) throw new Error(`Invalid workspace slug ${slug}: ${slugError}`);
  const prior = z
    .object({ id: z.uuid(), created_by: z.string(), stage: z.string() })
    .optional()
    .parse(
      (
        await context.identity.query(
          'SELECT w.id, w.created_by, s.stage FROM app.workspaces w JOIN app.workspace_storage s ON s.workspace_id = w.id WHERE w.slug = $1',
          [slug],
        )
      ).rows[0],
    );
  if (prior && prior.created_by !== owner.id)
    throw new Error(
      `Workspace ${slug} already exists with another owner; run \`pnpm seed:reset --workspace ${slug}\` first.`,
    );
  if (prior?.stage === 'unavailable')
    throw new Error(`Workspace ${slug} is unavailable; run \`pnpm seed:reset --workspace ${slug}\` first.`);
  const id =
    prior?.id ??
    (
      await createWorkspace(
        { pool: context.identity, runtime: context.runtime },
        owner.id,
        { requestId: stableId('workspace-request', slug), name: input.name, slug },
        async () => {},
      )
    ).id;
  if (prior?.stage !== 'ready') {
    context.log(`Provisioning workspace ${slug} (isolated schema, migrations, Soul)…`);
    const maintenance = createWorkspaceMaintenance({ migrations: await workspaceTableMigrations() });
    try {
      await maintenance.initializeWorkspaceStorage(id);
    } finally {
      await maintenance.close();
    }
  }
  const snapshot = await context.governance.snapshot(id, owner.id);
  const existing = context.manifest.workspaces[slug];
  const workspace: ManifestWorkspace = {
    id,
    slug,
    name: input.name,
    url: workspaceUrl(slug),
    scenario: input.scenario,
    owner: owner.email,
    members: [
      { email: owner.email, role: 'admin', membershipId: snapshot.actorMembershipId },
      ...(existing?.id === id ? existing.members.filter(member => member.email !== owner.email) : []),
    ],
    teams: existing?.id === id ? existing.teams : [],
    entities: existing?.id === id ? existing.entities : {},
    unavailable: existing?.id === id ? existing.unavailable : {},
  };
  context.manifest.workspaces[slug] = workspace;
  return workspace;
}

function invitationToken(url: string) {
  const parsed = new URL(url);
  const token = parsed.searchParams.get('token') ?? new URLSearchParams(parsed.hash.slice(1)).get('token');
  if (!token) throw new Error('Invitation link has no token');
  return token;
}

// Email invitations must name the Workspace Members record the person will be linked to.
async function ensureWorkspaceMemberRecord(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  user: ManifestUser,
) {
  const recordId = stableId('workspace-member', workspace.id, user.email);
  const generation = await context.runtime.transaction(workspace.id, commonCompatibility, async tx => {
    const registration = await workspaceMembersTable(tx);
    if (!registration) throw new Error(`${workspace.slug} has no Workspace Members table`);
    const active = await activeGeneration(tx, registration.coreDefinition.id);
    return { active, existing: await readRecord(tx, active, recordId) };
  });
  if (!generation.existing)
    await createTableService(
      context.runtime,
      { readableFiles: async () => new Set<string>() },
      commonCompatibility,
    ).mutate(workspace.id, owner.id, {
      kind: 'create',
      tableId: generation.active.table_id,
      revision: generation.active.revision,
      recordId,
      values: manualWorkspaceMemberValues({ name: user.name, contactEmail: user.email }),
    });
  return recordId;
}

// Members join through the real invitation path so audit rows, redemptions, and identity checks match production.
export async function ensureMember(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  user: ManifestUser,
  role: 'admin' | 'member',
) {
  let member = (await context.governance.snapshot(workspace.id, owner.id)).members.find(
    item => item.userId === user.id,
  );
  if (!member) {
    const created = await context.governance.createInvitation(workspace.id, owner.id, {
      kind: 'email',
      email: user.email,
      requestId: stableId('invite', workspace.id, user.email),
      workspaceMemberId: await ensureWorkspaceMemberRecord(context, workspace, owner, user),
    });
    if (created.outcome !== 'already-member') {
      const link = await context.governance.copyInvitation(workspace.id, owner.id, created.invitation.id);
      await context.governance.redeemInvitation(user.id, invitationToken(link.url));
    }
    member = (await context.governance.snapshot(workspace.id, owner.id)).members.find(item => item.userId === user.id);
    if (!member) throw new Error(`Could not add ${user.email} to ${workspace.slug}`);
  }
  if (member.role !== role) await context.governance.setMemberRole(workspace.id, owner.id, member.id, { role });
  const entry = { email: user.email, role, membershipId: member.id };
  workspace.members = [...workspace.members.filter(item => item.email !== user.email), entry];
  return entry;
}

export async function ensureTeam(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  input: { key: string; name: string; description?: string; managers?: string[]; members?: string[] },
) {
  const teamId = stableId('team', workspace.id, input.key);
  let team = (await context.governance.snapshot(workspace.id, owner.id)).teams.find(item => item.id === teamId);
  if (!team) {
    await context.governance.createTeam(workspace.id, owner.id, teamId, {
      name: input.name,
      description: input.description ?? '',
    });
    team = (await context.governance.snapshot(workspace.id, owner.id)).teams.find(item => item.id === teamId);
  }
  const membership = (email: string) => {
    const found = workspace.members.find(item => item.email === email);
    if (!found) throw new Error(`${email} is not a seeded member of ${workspace.slug}`);
    return found.membershipId;
  };
  for (const email of [...(input.members ?? []), ...(input.managers ?? [])]) {
    const id = membership(email);
    if (!team?.membershipIds.includes(id))
      await context.governance.setEnrollment(workspace.id, owner.id, teamId, id, { enrolled: true });
  }
  for (const email of input.managers ?? []) {
    const id = membership(email);
    if (!team?.managerIds.includes(id))
      await context.governance.setTeamRole(workspace.id, owner.id, teamId, id, { role: 'manager' });
  }
  const entry = {
    id: teamId,
    name: input.name,
    managers: [owner.email, ...(input.managers ?? [])],
    members: input.members ?? [],
  };
  workspace.teams = [...workspace.teams.filter(item => item.id !== teamId), entry];
  return entry;
}
