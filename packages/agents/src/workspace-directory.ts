import { z } from 'zod';

const person = z.object({ name: z.string(), email: z.string().nullable().optional() });
export const workspaceDirectorySchema = z.object({
  scope: z.enum(['workspace', 'filtered']).optional(),
  workspaceMemberCount: z.number().int().nonnegative().optional(),
  workspaceTeamCount: z.number().int().nonnegative().optional(),
  memberCount: z.number().int().nonnegative(),
  members: z.array(person),
  teamCount: z.number().int().nonnegative(),
  teams: z.array(
    z.object({
      name: z.string(),
      people: z.union([z.literal('not-visible'), z.array(person.extend({ role: z.string() }))]),
      peopleCount: z.number().int().nonnegative().optional(),
      peopleTruncated: z.boolean().optional(),
    }),
  ),
  truncated: z.boolean(),
});
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

const directoryQuestion = (text: string) =>
  !/\b(?:example|sample|template|write|draft|create|design|explain|translate)\b/i.test(text) &&
  (/\b(?:list|show|find|count)\s+(?:(?:all|the|our|my|current|workspace|active)\s+)*(?:teams|members|people)\b/i.test(
    text,
  ) ||
    /\b(?:what|which|how many)\s+(?:teams|members|people)\b/i.test(text) ||
    /\bwho\s+(?:is|are)\s+(?:in|on)\s+(?:(?:the|our|my|this)\s+)?(?:workspace|.+?\s+team)\b/i.test(text) ||
    /\b(?:teams|members)\s+(?:are\s+)?(?:in|of|belong to)\s+(?:(?:the|our|my|this)\s+)?workspace\b/i.test(text));

/** Selects previews to hold, not whether an answer is true; the structured completion check decides that. */
export function directoryAnswerExpected(messages: readonly { role: string; text: string }[]) {
  const requests = messages.filter(message => message.role === 'user');
  const latest = requests.at(-1)?.text ?? '';
  if (directoryQuestion(latest)) return true;
  return (
    /^(?:please\s+)?(?:list|show|count|check|verify|confirm)\s+(?:them|those|these|their\b.*)|^(?:and\s+)?(?:their members|who is in each|are you sure|check again)[?.! ]*$/i.test(
      latest.trim(),
    ) && directoryQuestion(requests.at(-2)?.text ?? '')
  );
}

export function directoryListingExpected(messages: readonly { role: string; text: string }[]) {
  if (!directoryAnswerExpected(messages)) return false;
  const requests = messages.filter(message => message.role === 'user');
  const latest = requests.at(-1)?.text ?? '';
  const question = directoryQuestion(latest) ? latest : (requests.at(-2)?.text ?? '');
  if (
    /\b(?:tables?|sets?|team|invitations?|invitees?|invites?|invited|only|except|matching|named|called|without)\b|\bwith\s+no\b/i.test(
      question,
    )
  )
    return false;
  return (
    /\bworkspace\b/i.test(question) ||
    /^(?:please\s+)?(?:list|show|find|count)\s+(?:(?:all|the|our|my|current|active)\s+)*(?:teams|members|people)(?:\s+and\s+(?:their\s+)?(?:members|people))?[?.! ]*$/i.test(
      question.trim(),
    )
  );
}

export const directoryUnavailableReply =
  "I couldn't check the workspace's people and teams just now. Please try again.";

export function directoryReply(directory: WorkspaceDirectory) {
  const named = (member: z.infer<typeof person>) =>
    member.email && member.email !== member.name ? `${member.name} (${member.email})` : member.name;
  return [
    `Workspace teams: ${directory.teamCount}. Current members: ${directory.memberCount}.`,
    ...directory.teams.map(team =>
      team.people === 'not-visible'
        ? `- ${team.name}: I can't see this team's members.`
        : `- ${team.name}: ${team.people.map(member => `${named(member)} (${member.role})`).join(', ') || 'No members.'}${team.peopleTruncated ? ' More members are not shown.' : ''}`,
    ),
    ...(directory.members.length ? ['Members:', ...directory.members.map(member => `- ${named(member)}`)] : []),
    ...(directory.truncated ? ['This lookup shows only part of the results.'] : []),
  ].join('\n');
}

export const directoryCheckPrompt = `
This turn may answer a workspace people-and-teams question. Set workspaceDirectory in your decision:
- not-applicable: the reply makes no workspace directory claim and the user is not asking for one (for example writing a message to a team).
- lookup-required: the user asks for workspace people, teams, counts or rosters, but there is no successful members.find result in this turn or retainedWorkspaceDirectory.
- grounded: every person, team, email, count and membership asserted in the reply is supported by those directory results. A table owner, user text, an assistant's earlier answer, or a proposed example is not directory evidence.
- unsupported: a lookup exists but the reply invents or changes names, counts or membership, omits requested teams, or reveals a roster marked not-visible.
Use continue for lookup-required or unsupported. Never certify a directory answer from model claims alone. A failed lookup is not an empty directory.
When members.find has a query, its names and counts describe only matching results, never workspace totals. It can support an answer about those matches, but not a claim about everyone or every team.
Retained results are from an authorized lookup in this same chat, not a fresh lookup; they may support an answer about that earlier result.`;
