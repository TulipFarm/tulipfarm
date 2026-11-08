import type {
  Definition,
  GitHubEventFilter,
  GitHubRepositories,
  GitHubTriggerEvent,
  RecordFilter,
  SlackText,
  Trigger,
} from '@tulipfarm/workflows/contracts';

export type WorkflowValue = Extract<Definition['steps'][number], { kind: 'transform' }>['fields'][string];

export const comparisonWords = {
  eq: 'is',
  ne: 'is not',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  'is-empty': 'is empty',
  'not-empty': 'is not empty',
} as const;
export function describeValue(value: WorkflowValue) {
  switch (value.kind) {
    case 'literal':
      return JSON.stringify(value.value);
    case 'input':
      return value.path.length ? `run input ${value.path.join('.')}` : 'run input';
    case 'step':
      return [`step ${value.step.replaceAll('_', ' ')} output`, value.path.join('.')].filter(Boolean).join(' ');
    case 'trigger':
      return value.path[0] === 'kind'
        ? 'kind of the trigger that started the run'
        : value.path[0] === 'id'
          ? 'ID of the trigger that started the run'
          : 'trigger that started the run';
  }
}
export function describeSlackText(text: SlackText) {
  return text.kind === 'template' ? JSON.stringify(text.template) : describeValue(text);
}
/** Where each placeholder of a Slack message template gets its value, or null for plain message text. */
export function describeSlackFills(text: SlackText) {
  if (text.kind !== 'template') return null;
  return Object.entries(text.values)
    .map(([key, value]) => `{{${key}}} from ${describeValue(value)}`)
    .join('; ');
}
const orderedWords = {
  numeric: { lt: 'is less than', lte: 'is at most', gt: 'is more than', gte: 'is at least' },
  date: { lt: 'is before', lte: 'is on or before', gt: 'is after', gte: 'is on or after' },
} as const;
export function filterPhrase(filter: RecordFilter, shown: string | null) {
  switch (filter.match) {
    case 'is-empty':
      return 'is empty';
    case 'is-not-empty':
      return 'is not empty';
    case 'is':
      return `is ${shown}`;
    case 'is-not':
      return `is not ${shown}`;
    default:
      return `${orderedWords[filter.value.kind === 'numeric' ? 'numeric' : 'date'][filter.match]} ${shown}`;
  }
}
const githubEventText: Record<GitHubTriggerEvent, string> = {
  star: 'When someone stars a GitHub repository',
  watch: 'When someone watches a GitHub repository',
  issues: 'When a GitHub issue changes',
  pull_request: 'When a GitHub pull request changes',
  issue_comment: 'When someone comments on a GitHub issue or pull request',
  push: 'When someone pushes to a GitHub repository',
  release: 'When a GitHub release changes',
};
export const githubInstallNote = 'Events arrive only after the TulipFarm GitHub App is installed on this repository.';
export const githubEventNames: Record<GitHubTriggerEvent, string> = {
  star: 'star',
  watch: 'watch',
  issues: 'issue',
  pull_request: 'pull request',
  issue_comment: 'comment',
  push: 'push',
  release: 'release',
};
const githubEventPhrase = (filter: GitHubEventFilter) => {
  const actions = filter.actions?.map(action => action.replaceAll('_', ' ')).join(', ');
  return `${githubEventNames[filter.event]}${actions ? ` (${actions})` : ''}`;
};
/** GitHub repository names by ID and account names by owner ID; IDs are never shown to people. */
export type GitHubNames = { repositories?: Record<string, string>; accounts?: Record<string, string> };
export function describeGitHubRepositories(repositories: GitHubRepositories, names: GitHubNames = {}) {
  if (!Array.isArray(repositories)) {
    const account = names.accounts?.[repositories.organizationId];
    return account
      ? `All repositories in ${account}, including future ones`
      : 'All repositories in a GitHub account, including future ones';
  }
  const known = repositories.flatMap(id => (names.repositories?.[id] ? [names.repositories[id]] : []));
  const unknown = repositories.length - known.length;
  if (known.length && known.length <= 3 && !unknown) return known.join(', ');
  if (known.length === 1 && repositories.length === 1) return known[0]!;
  const shown = known.slice(0, 2).join(', ');
  return shown
    ? `${shown} and ${repositories.length - Math.min(2, known.length)} more`
    : `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`;
}
export function describeGitHubTrigger(
  trigger: Pick<Extract<Trigger, { kind: 'github' }>, 'events' | 'repositories'>,
  names?: GitHubNames,
) {
  const events =
    trigger.events.length === 1 && !trigger.events[0]!.actions
      ? githubEventText[trigger.events[0]!.event]
      : `On GitHub ${trigger.events.map(githubEventPhrase).join(', ')}`;
  return `${events} in ${describeGitHubRepositories(trigger.repositories, names)}`;
}
/** "GitHub push, pull request" */
export const githubShortSummary = (trigger: Pick<Extract<Trigger, { kind: 'github' }>, 'events'>) =>
  `GitHub ${trigger.events.map(item => githubEventNames[item.event]).join(', ')}`;
export function recordScheduleDescription(
  field: Extract<Definition['triggers'][number], { kind: 'record' }>['field'],
  subject = field.kind === 'date' ? 'the record date' : 'the record time',
) {
  const { amount, unit, direction } = field.offset;
  const when =
    amount === 0
      ? `${field.kind === 'date' ? 'On' : 'At'} ${subject}`
      : `${amount} ${amount === 1 ? unit.slice(0, -1) : unit} ${direction} ${subject}`;
  return field.kind === 'date' ? `${when} at ${field.time} in ${field.timezone.replaceAll('_', ' ')}` : when;
}
