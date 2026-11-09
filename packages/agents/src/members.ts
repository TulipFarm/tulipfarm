import { z } from 'zod';
import { activeGeneration, GenerationError, readRecords, workspaceMembersTable } from '@tulipfarm/tables/store';
import { workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import { currentMember, type HumanActor } from '@tulipfarm/access';
import { relation, type AgentTransaction } from './store.ts';

export type MemberSummary = { membershipId: string; userId: string; name: string; email: string | null };
export type TeamSummary = { teamId: string; name: string };

const unnamed = 'Unnamed member';
const text = (value: unknown) => {
  const parsed = z.object({ kind: z.literal('text'), value: z.string() }).safeParse(value);
  return parsed.success && parsed.data.value.trim() ? parsed.data.value.trim() : null;
};

/**
 * Active members with the name and email from the workspace's Members table. A member whose profile has not been
 * projected yet, or a workspace without the table, reads as "Unnamed member" with no email.
 */
export async function activeMembers(tx: AgentTransaction, membershipIds?: readonly string[]) {
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
  const values = new Map<string, Readonly<Record<string, unknown>>>();
  const registration = await workspaceMembersTable(tx).catch(() => null);
  const memberIds = rows.flatMap(row => (row.member_id ? [row.member_id] : []));
  if (registration && memberIds.length)
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
  return rows.map((row): MemberSummary => {
    const record = row.member_id ? values.get(row.member_id) : undefined;
    const email =
      text(record?.[workspaceMemberFields.contactEmail]) ?? text(record?.[workspaceMemberFields.accountEmail]);
    return {
      membershipId: row.membership_id,
      userId: row.user_id,
      name: text(record?.[workspaceMemberFields.name]) ?? email ?? unnamed,
      email,
    };
  });
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
// The workspace admins team is stored under an internal name; the app shows it as "Workspace admins".
const teamName = (name: string) => (name === '_admin' ? 'Workspace admins' : name);

type Roster = { membershipId: string; name: string; role: 'member' | 'manager' };

/**
 * Active members and teams whose name or email contains the query, ignoring case, or everyone when there is no query.
 * Only IDs, names and emails. A team lists who is in it only when the asker could see that in Settings: a workspace
 * admin sees every team's people, anyone else only the teams they belong to. Counts are of every match, so the agent
 * never has to guess how many there are.
 */
export async function findMembers(tx: AgentTransaction, actor: HumanActor, query?: string) {
  const needle = query?.trim().toLocaleLowerCase() ?? '';
  const matches = (...values: (string | null)[]) =>
    !needle || values.some(value => value !== null && value.toLocaleLowerCase().includes(needle));
  const everyone = await activeMembers(tx);
  const members = everyone.filter(member => matches(member.name, member.email));
  const teams = (await workspaceTeams(tx)).filter(team => matches(team.name, teamName(team.name)));
  const admin = (await currentMember(tx, actor)).role === 'admin';
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
    memberCount: members.length,
    members: members
      .slice(0, limit)
      .map(member => ({ membershipId: member.membershipId, name: member.name, email: member.email })),
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
    truncated: members.length > limit || teams.length > limit,
  };
}
