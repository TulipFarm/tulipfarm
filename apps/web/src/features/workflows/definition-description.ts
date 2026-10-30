import type { Definition, GitHubTrigger, GitHubTriggerEvent, RecordFilter } from '@tulipfarm/workflows/contracts';

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
  }
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
export function describeGitHubTrigger(trigger: GitHubTrigger) {
  const actions = trigger.actions?.map(action => action.replaceAll('_', ' ')).join(', ');
  return `${githubEventText[trigger.event]}${actions ? ` (${actions})` : ''}`;
}
export function recordScheduleDescription(
  field: Extract<Definition['trigger'], { kind: 'record' }>['field'],
  subject = field.kind === 'date' ? 'the record date' : 'the record time',
) {
  const { amount, unit, direction } = field.offset;
  const when =
    amount === 0
      ? `${field.kind === 'date' ? 'On' : 'At'} ${subject}`
      : `${amount} ${amount === 1 ? unit.slice(0, -1) : unit} ${direction} ${subject}`;
  return field.kind === 'date' ? `${when} at ${field.time} in ${field.timezone.replaceAll('_', ' ')}` : when;
}
