import { z } from 'zod';
import { teamLabel } from '@tulipfarm/workspace-storage/team-labels';
import { activeGeneration, GenerationError, readRecords, workspaceMembersTable } from '@tulipfarm/tables/store';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import { currentMember, type HumanActor } from '@tulipfarm/access';
import { canonicalEmailSql } from '@tulipfarm/workspaces/canonical-email';
import {
  hasMemberIdentities,
  identitiesOfMembers,
  normalizeExternalProvider,
  resolveMemberIdentities,
  searchMemberIdentities,
  type MemberIdentity,
} from '@tulipfarm/integrations/member-identities';
import { extractSlackUserMentions, slackMessageText, type SlackResolvedMember } from '@tulipfarm/slack';
import { relation, type AgentTransaction } from './store.ts';

export type MemberSummary = { membershipId: string; userId: string; name: string; email: string | null };
export type TeamSummary = { teamId: string; name: string };
export type FindMembersOptions = { provider?: string };
export type MemberIdentitySummary = {
  provider: string;
  scope: string;
  handle: string | null;
  externalId: string | null;
  aliases: readonly string[];
  mention: string | null;
  trust: 'verified' | 'manual';
};

type MemberRecord = MemberSummary & { memberId: string | null; photo: string | null };
type MemberCandidate =
  | { memberId: string | null; membershipId: string; name: string; email: string | null }
  | { memberId: string; membershipId: null; name: string; email: string | null };

const unnamed = 'Unnamed member';
const text = (value: unknown) => {
  const parsed = z.object({ kind: z.literal('text'), value: z.string() }).safeParse(value);
  return parsed.success && parsed.data.value.trim() ? parsed.data.value.trim() : null;
};
const booleanValue = (value: unknown) => {
  const parsed = z.object({ kind: z.literal('boolean'), value: z.boolean() }).safeParse(value);
  return parsed.success ? parsed.data.value : null;
};

async function readMemberTableValues(tx: AgentTransaction, memberIds: readonly string[]) {
  const values = new Map<string, Readonly<Record<string, unknown>>>();
  const registration = await workspaceMembersTable(tx).catch(() => null);
  if (!registration || !memberIds.length) return values;
  try {
    const generation = await activeGeneration(tx, registration.coreDefinition.id);
    for (let start = 0; start < memberIds.length; start += 1000) {
      const ids = memberIds.slice(start, start + 1000);
      for (const record of await readRecords(tx, generation, { ids, limit: ids.length }))
        values.set(record.id, record.values);
    }
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error;
  }
  return values;
}

async function activeMemberRecords(tx: AgentTransaction, membershipIds?: readonly string[]): Promise<MemberRecord[]> {
  const rows = z
    .array(z.object({ membership_id: z.uuid(), user_id: z.string(), member_id: z.uuid().nullable() }))
    .parse(
      (
        await tx.client.query(
          `SELECT m.id AS membership_id,m.user_id,a.member_id FROM ${relation(tx, 'tf_memberships')} m
          LEFT JOIN ${relation(tx, 'tf_workspace_member_accounts')} a ON a.membership_id=m.id
          WHERE m.removed_at IS NULL AND ($1::uuid[] IS NULL OR m.id=ANY($1)) ORDER BY m.created_at,m.id`,
          [membershipIds ?? null],
        )
      ).rows,
    );
  const memberIds = rows.flatMap(row => (row.member_id ? [row.member_id] : []));
  const values = await readMemberTableValues(tx, memberIds);
  return rows.map(row => {
    const record = row.member_id ? values.get(row.member_id) : undefined;
    const email =
      text(record?.[workspaceMemberFields.contactEmail]) ?? text(record?.[workspaceMemberFields.accountEmail]);
    return {
      membershipId: row.membership_id,
      userId: row.user_id,
      memberId: row.member_id,
      name: text(record?.[workspaceMemberFields.name]) ?? email ?? unnamed,
      email,
      photo: text(record?.[workspaceMemberFields.photo]),
    };
  });
}

async function handAddedMembers(tx: AgentTransaction): Promise<MemberCandidate[]> {
  const registration = await workspaceMembersTable(tx).catch(() => null);
  if (!registration) return [];
  const rows = z.array(z.object({ member_id: z.uuid() })).parse(
    (
      await tx.client.query(
        `SELECT ti.row_id AS member_id FROM ${relation(tx, 'tf_table_identities')} ti
          LEFT JOIN ${relation(tx, 'tf_workspace_member_accounts')} a ON a.member_id=ti.row_id
          WHERE ti.table_id=$1 AND ti.live AND a.member_id IS NULL
          ORDER BY ti.updated_at,ti.row_id`,
        [registration.coreDefinition.id],
      )
    ).rows,
  );
  if (!rows.length) return [];
  const values = await readMemberTableValues(
    tx,
    rows.map(row => row.member_id),
  );
  const people: MemberCandidate[] = [];
  for (const row of rows) {
    const record = values.get(row.member_id);
    if (!record || booleanValue(record[workspaceMemberFields.active]) === false) continue;
    const email = text(record[workspaceMemberFields.contactEmail]) ?? text(record[workspaceMemberFields.accountEmail]);
    people.push({
      memberId: row.member_id,
      membershipId: null,
      name: text(record[workspaceMemberFields.name]) ?? email ?? unnamed,
      email,
    });
  }
  return people;
}

/**
 * Active members with the name and email from the workspace's Members table. A member whose profile has not been
 * projected yet, or a workspace without the table, reads as "Unnamed member" with no email.
 */
export async function activeMembers(tx: AgentTransaction, membershipIds?: readonly string[]): Promise<MemberSummary[]> {
  return (await activeMemberRecords(tx, membershipIds)).map(
    ({ photo: _photo, memberId: _memberId, ...member }) => member,
  );
}

/** Active members as {@link activeMembers} reads them, plus each one's Members table photo path, if any. */
export async function activeMemberProfiles(tx: AgentTransaction, membershipIds?: readonly string[]) {
  return (await activeMemberRecords(tx, membershipIds)).map(({ memberId: _memberId, ...member }) => member);
}

export async function resolveSlackThreadMembers(
  tx: AgentTransaction,
  installation: { installationId: string; generation: number },
  messages: readonly (Parameters<typeof slackMessageText>[0] & { user?: string })[],
  extraTexts: readonly string[] = [],
  extraUserIds: readonly string[] = [],
): Promise<Record<string, SlackResolvedMember> | undefined> {
  if (!hasMemberIdentities(tx)) return undefined;
  const userIds = new Set<string>();
  for (const id of extraUserIds) {
    if (id.trim()) userIds.add(id.trim());
  }
  const texts: string[] = [];
  for (const message of messages) {
    if (message.user?.trim()) userIds.add(message.user.trim());
    texts.push(slackMessageText(message));
  }
  for (const extra of extraTexts) {
    if (extra) texts.push(extra);
  }
  for (const mentioned of extractSlackUserMentions(texts)) userIds.add(mentioned);
  const externalIds = [...userIds];
  if (!externalIds.length) return undefined;

  const teamId = z
    .object({ team_id: z.string() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT team_id FROM ${relation(tx, 'tf_slack_installations')} WHERE id=$1 AND generation=$2`,
          [installation.installationId, installation.generation],
        )
      ).rows[0],
    )?.team_id;
  if (!teamId) return undefined;

  const resolutions = await resolveMemberIdentities(tx, { provider: 'slack', scope: teamId, externalIds });
  const resolvedItems = resolutions.filter(
    (
      item,
    ): item is typeof item & {
      status: 'resolved';
      memberId: string;
      trust: 'verified' | 'manual';
    } => item.status === 'resolved' && item.memberId !== null && item.trust !== null,
  );
  if (!resolvedItems.length) return undefined;

  const values = await readMemberTableValues(tx, [...new Set(resolvedItems.map(item => item.memberId))]);
  const resolved: Record<string, SlackResolvedMember> = {};
  for (const item of resolvedItems) {
    const record = values.get(item.memberId);
    const email =
      text(record?.[workspaceMemberFields.contactEmail]) ?? text(record?.[workspaceMemberFields.accountEmail]);
    resolved[item.key.value] = {
      memberId: item.memberId,
      membershipId: item.membershipId,
      name: text(record?.[workspaceMemberFields.name]) ?? email ?? unnamed,
      trust: item.trust,
    };
  }
  return resolved;
}

function summarizeIdentity(identity: MemberIdentity): MemberIdentitySummary {
  return {
    provider: identity.provider,
    scope: identity.scope,
    handle: identity.handle,
    externalId: identity.externalId,
    aliases: identity.aliases,
    mention: identity.mention,
    trust: identity.trust,
  };
}

export async function workspaceTeams(tx: AgentTransaction, teamIds?: readonly string[]): Promise<TeamSummary[]> {
  return z
    .array(z.object({ id: z.uuid(), name: z.string() }))
    .parse(
      (
        await tx.client.query(
          `SELECT id,name FROM ${relation(tx, 'tf_teams')} WHERE $1::uuid[] IS NULL OR id=ANY($1) ORDER BY lower(name),id`,
          [teamIds ?? null],
        )
      ).rows,
    )
    .map(team => ({ teamId: team.id, name: team.name }));
}

const limit = 20;
const rosterLimit = 50;
const teamName = teamLabel;

type Roster = { membershipId: string; name: string; role: 'member' | 'manager' };

const invitationRows = z.array(
  z.object({
    email: z.string(),
    expired: z.boolean(),
    expires_at: z.date(),
    role: z.enum(['admin', 'member']),
    assignments: z
      .object({ teams: z.array(z.object({ id: z.uuid(), role: z.enum(['member', 'manager']), name: z.string() })) })
      .catch({ teams: [] }),
  }),
);

/** Email invitations nobody has accepted yet, the latest per address, as Members lists them; newest first. */
async function openInvitations(tx: AgentTransaction, teams: ReadonlyMap<string, string>) {
  const invitations = relation(tx, 'tf_invitations');
  const rows = invitationRows.parse(
    (
      await tx.client.query(
        `SELECT i.email,i.expires_at<=clock_timestamp() AS expired,i.expires_at,i.role,i.assignments FROM ${invitations} i
        WHERE i.kind='email' AND i.revoked_at IS NULL AND i.consumed_membership_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM ${invitations} newer WHERE newer.email IS NOT NULL
            AND ${canonicalEmailSql('newer.email')}=${canonicalEmailSql('i.email')}
            AND (newer.created_at,newer.id)>(i.created_at,i.id))
        ORDER BY i.created_at DESC,i.id DESC`,
      )
    ).rows,
  );
  return rows.map(row => ({
    email: row.email,
    status: row.expired ? ('expired' as const) : ('pending' as const),
    expiresAt: row.expires_at.toISOString(),
    role: row.role,
    teams: row.assignments.teams.map(team => ({ name: teamName(teams.get(team.id) ?? team.name), role: team.role })),
  }));
}

export async function findMembers(
  tx: AgentTransaction,
  actor: HumanActor,
  query?: string,
  options?: FindMembersOptions,
) {
  const rawQuery = query?.trim() ?? '';
  const needle = rawQuery.toLocaleLowerCase();
  const provider = options?.provider?.trim() ? normalizeExternalProvider(options.provider) : undefined;
  const filtered = Boolean(needle || provider);
  const matchesText = (...values: (string | null)[]) =>
    !needle || values.some(value => value !== null && value.toLocaleLowerCase().includes(needle));
  const everyone = await activeMemberRecords(tx);
  const candidates: MemberCandidate[] = everyone.map(member => ({
    memberId: member.memberId,
    membershipId: member.membershipId,
    name: member.name,
    email: member.email,
  }));
  if (filtered) candidates.push(...(await handAddedMembers(tx)));

  const identitiesEnabled = hasMemberIdentities(tx);
  const candidateMemberIds = [
    ...new Set(candidates.flatMap(candidate => (candidate.memberId ? [candidate.memberId] : []))),
  ];
  const identitiesByMember =
    identitiesEnabled && candidateMemberIds.length
      ? await identitiesOfMembers(tx, candidateMemberIds)
      : new Map<string, readonly MemberIdentity[]>();

  const identityMatchedMemberIds = new Set<string>();
  if (identitiesEnabled && rawQuery) {
    const identityNeedle = extractSlackUserMentions([rawQuery])[0] ?? rawQuery;
    const hits = await searchMemberIdentities(tx, identityNeedle, {
      ...(provider ? { provider } : {}),
      limit: 200,
    });
    for (const hit of hits) identityMatchedMemberIds.add(hit.memberId);
  }

  const members = candidates.filter(candidate => {
    const identities = candidate.memberId ? (identitiesByMember.get(candidate.memberId) ?? []) : [];
    if (provider && !identities.some(identity => identity.provider === provider)) return false;
    if (!needle) return true;
    return (
      matchesText(candidate.name, candidate.email) ||
      (candidate.memberId !== null && identityMatchedMemberIds.has(candidate.memberId))
    );
  });

  const allTeams = await workspaceTeams(tx);
  // A query naming several teams, such as "QA Editors and QA Readers", finds each team it names.
  const teams = provider
    ? []
    : allTeams.filter(
        team =>
          matchesText(team.name, teamName(team.name)) ||
          [team.name, teamName(team.name)].some(name => name.length >= 3 && needle.includes(name.toLocaleLowerCase())),
      );
  const admin = (await currentMember(tx, actor)).role === 'admin';
  // Every open invitation regardless of the query: a question about a team's invitees is also about the workspace's.
  const invitations = admin ? await openInvitations(tx, new Map(allTeams.map(team => [team.teamId, team.name]))) : null;
  const enrollments = z
    .array(z.object({ team_id: z.uuid(), membership_id: z.uuid(), role: z.enum(['member', 'manager']) }))
    .parse(
      (
        await tx.client.query(
          `SELECT mt.team_id,mt.membership_id,mt.role FROM ${relation(tx, 'tf_member_teams')} mt
          JOIN ${relation(tx, 'tf_memberships')} m ON m.id=mt.membership_id AND m.removed_at IS NULL
          WHERE mt.team_id=ANY($1::uuid[]) ORDER BY m.created_at,m.id`,
          [teams.slice(0, limit).map(team => team.teamId)],
        )
      ).rows,
    );
  const names = new Map(everyone.map(member => [member.membershipId, member.name]));
  const rosters = new Map<string, Roster[]>();
  for (const row of enrollments) {
    const roster = rosters.get(row.team_id) ?? [];
    roster.push({ membershipId: row.membership_id, name: names.get(row.membership_id) ?? unnamed, role: row.role });
    rosters.set(row.team_id, roster);
  }
  return {
    scope: filtered ? ('filtered' as const) : ('workspace' as const),
    workspaceMemberCount: everyone.length,
    workspaceTeamCount: allTeams.length,
    memberCount: members.length,
    members: members.slice(0, limit).map(candidate => {
      const identities = (candidate.memberId ? (identitiesByMember.get(candidate.memberId) ?? []) : [])
        .filter(identity => !provider || identity.provider === provider)
        .map(summarizeIdentity);
      if (candidate.membershipId === null) {
        return {
          memberId: candidate.memberId,
          membershipId: null,
          name: candidate.name,
          email: candidate.email,
          ...(identities.length > 0 ? { identities } : {}),
        };
      }
      return {
        membershipId: candidate.membershipId,
        ...(identities.length > 0 && candidate.memberId ? { memberId: candidate.memberId } : {}),
        name: candidate.name,
        email: candidate.email,
        ...(identities.length > 0 ? { identities } : {}),
      };
    }),
    teamCount: teams.length,
    teams: teams.slice(0, limit).map(team => {
      const roster = rosters.get(team.teamId) ?? [];
      const visible = admin || roster.some(person => person.membershipId === actor.membershipId);
      return {
        teamId: team.teamId,
        name: teamName(team.name),
        ...(visible
          ? {
              peopleCount: roster.length,
              people: roster.slice(0, rosterLimit),
              ...(roster.length > rosterLimit ? { peopleTruncated: true } : {}),
            }
          : { people: 'not-visible' as const }),
      };
    }),
    ...(invitations
      ? {
          pendingInvitationCount: invitations.length,
          pendingInvitations: invitations.slice(0, limit),
          invitationsInstruction: invitations.length
            ? 'These are every open invitation in the workspace, whatever the query. When asked about invitees, list each one by email with the teams it joins, or say it joins no team.'
            : 'The workspace has no open invitations.',
        }
      : {
          pendingInvitations: 'not-visible' as const,
          invitationsInstruction:
            "Only workspace admins can see pending invitations, on Members. Say you can't see them and that an admin can check Members; never say there are none.",
        }),
    truncated: members.length > limit || teams.length > limit || (invitations?.length ?? 0) > limit,
  };
}
