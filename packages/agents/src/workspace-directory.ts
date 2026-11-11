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

const listingQuestion = (text: string) => {
  const question = text
    .trim()
    .replace(/[?.!]+$/, '')
    .replace(/^(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+)/i, '');
  return (
    /^(?:list|show(?:\s+me)?|find|count|give me a list of)\s+(?:(?:all|the|our|my|current|workspace|active|every)\s+)*(?:teams|members|people|team)(?:\s+(?:in|of|for)\s+(?:(?:the|this|our|my|current)\s+)?workspace)?(?:\s+(?:and|with)\s+(?:(?:all|their|its|the)\s+)*(?:members|people|teams))?(?:\s+(?:in|of|for)\s+(?:(?:the|this|our|my|current)\s+)?workspace)?$/i.test(
      question,
    ) ||
    /^(?:what|which|how many)\s+(?:teams|members|people)\s+(?:(?:are\s+(?:there\s+)?)?(?:in|of)\s+(?:(?:the|this|our|my|current)\s+)?workspace|do we have)(?:\s+and\s+who\s+is\s+(?:in|on)\s+each)?$/i.test(
      question,
    ) ||
    /^who\s+(?:is|are)\s+(?:in|on)\s+(?:(?:the|this|our|my|current)\s+)?workspace$/i.test(question)
  );
};

const directoryQuestion = (text: string) =>
  !/\b(?:example|sample|template|write|draft|create|design|explain|translate)\b/i.test(text) &&
  (listingQuestion(text) ||
    /\b(?:list|show|find|count)\s+(?:(?:all|the|our|my|current|workspace|active)\s+)*(?:teams|members|people)\b/i.test(
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

function directoryRequest(messages: readonly { role: string; text: string }[]) {
  if (!directoryAnswerExpected(messages)) return '';
  const requests = messages.filter(message => message.role === 'user');
  const latest = requests.at(-1)?.text ?? '';
  return directoryQuestion(latest) ? latest : (requests.at(-2)?.text ?? '');
}

export function directoryListingExpected(messages: readonly { role: string; text: string }[]) {
  return listingQuestion(directoryRequest(messages));
}

export function directoryLookupExpected(messages: readonly { role: string; text: string }[]) {
  const question = directoryRequest(messages);
  return !!question && !/\b(?:tables?|sets?|if|suppose|assuming|imagine|calculate|multiply|divide)\b/i.test(question);
}

export const directoryTotalsClaim = (text: string) =>
  /\bworkspace\s+(?:has|contains|teams|members)|\b(?:all|every)\s+(?:teams?|members|people)\b|\bno other\s+(?:teams|members|people)\b|\b(?:only\s+\d+|\d+\s+(?:total|teams?\s+in\s+total))\b/i.test(
    text,
  );

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
- grounded: an unfiltered workspace lookup supports the complete answer to the user's current question, including every person, team, email, count and membership asserted.
- matches-grounded: a filtered lookup supports the answer about only the requested matches. The reply never claims workspace totals or a complete list of everyone or every team. Never use this for a workspace-wide question.
- unsupported: a lookup exists but the reply invents or changes names, counts or membership, omits requested teams or people, reveals a roster marked not-visible, refuses despite available evidence, or answers a different question.
Use continue for lookup-required or unsupported. Never certify a directory answer from model claims alone. A failed lookup is not an empty directory.
A table owner, user text, an assistant's earlier answer, or a proposed example is not directory evidence.
When members.find has a query, its names and counts describe only matching results, never workspace totals. It can support an answer about those matches, but not a claim about everyone or every team.
Retained results are from an authorized lookup in this same chat, not a fresh lookup; they may support an answer about that earlier result.`;
