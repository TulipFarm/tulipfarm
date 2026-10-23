import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import {
  githubCorpusKinds,
  githubCorpusLimits,
  githubExcludePatternProblem,
  type GitHubKind,
} from './github-knowledge-api';

export const githubKindLabels: Record<GitHubKind, { label: string; short: string; description?: string }> = {
  code: { label: 'Source code', short: 'code', description: 'Code files on the default branch.' },
  docs: {
    label: 'Documentation and text files',
    short: 'docs',
    description: 'Markdown and text files up to 256 KB on the default branch.',
  },
  issues: { label: 'Issues and comments', short: 'issues' },
  pulls: { label: 'Pull request descriptions and comments', short: 'pull requests' },
  discussions: { label: 'Discussions', short: 'discussions' },
};

/** What to index from each repository. Everything is on by default; members opt content out. */
export type GitHubContentValue = { kinds: GitHubKind[]; after: string; patterns: string };

export const defaultGitHubContent = (): GitHubContentValue => ({
  kinds: [...githubCorpusKinds],
  after: '',
  patterns: '',
});

export function githubContentValue(selection: {
  kinds: readonly GitHubKind[];
  after?: string | undefined;
  excludePaths?: readonly string[] | undefined;
}): GitHubContentValue {
  return {
    kinds: [...selection.kinds],
    after: selection.after ?? '',
    patterns: (selection.excludePaths ?? []).join('\n'),
  };
}

const patternMessages = {
  length: `is longer than ${githubCorpusLimits.excludePatternLength} characters`,
  unsafe: 'could take too long to match; avoid nested or repeated wildcards and backreferences',
  invalid: 'is not a valid regular expression',
} as const;

export function checkGitHubContent(value: GitHubContentValue, now = Date.now()) {
  const excludePaths = [
    ...new Set(
      value.patterns
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean),
    ),
  ];
  const problem = excludePaths
    .map(pattern => ({ pattern, problem: githubExcludePatternProblem(pattern) }))
    .find(item => item.problem);
  const start = value.after ? Date.parse(value.after) : null;
  const errors = {
    kinds: value.kinds.length ? undefined : 'Choose at least one kind of content.',
    after:
      start !== null && (!Number.isFinite(start) || start > now)
        ? 'Enter a date that is not in the future.'
        : undefined,
    patterns:
      excludePaths.length > githubCorpusLimits.excludePatterns
        ? `Use at most ${githubCorpusLimits.excludePatterns} patterns.`
        : problem?.problem
          ? `“${problem.pattern}” ${patternMessages[problem.problem]}.`
          : undefined,
  };
  return {
    errors,
    valid: !errors.kinds && !errors.after && !errors.patterns,
    kinds: [...value.kinds].sort(),
    excludePaths,
    after: value.after || null,
  };
}

const displayDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function describeGitHubContent(selection: {
  kinds: readonly GitHubKind[];
  after?: string | null | undefined;
  excludePaths?: readonly string[] | undefined;
}) {
  const kinds = githubCorpusKinds.filter(kind => selection.kinds.includes(kind));
  const parts = [
    kinds.length === githubCorpusKinds.length
      ? 'All content'
      : kinds.map(kind => githubKindLabels[kind].short).join(', '),
    selection.after ? `activity since ${displayDate.format(Date.parse(selection.after))} UTC` : 'full history',
  ];
  const patterns = selection.excludePaths?.length ?? 0;
  if (patterns) parts.push(`${patterns} excluded path ${patterns === 1 ? 'pattern' : 'patterns'}`);
  return parts.join(' · ');
}

export function GitHubContentOptions({
  value,
  onChange,
  attempted,
  idPrefix,
}: {
  value: GitHubContentValue;
  onChange: (value: GitHubContentValue) => void;
  attempted: boolean;
  idPrefix: string;
}) {
  const { errors } = checkGitHubContent(value);
  return (
    <div className="space-y-5">
      <ChoiceGroup
        type="checkbox"
        legend="Content to index"
        helper="Everything is indexed by default. Clear a box to leave that content out."
        required
        options={githubCorpusKinds.map(kind => ({ value: kind, ...githubKindLabels[kind] }))}
        value={value.kinds}
        onValueChange={kinds => onChange({ ...value, kinds })}
        error={attempted ? errors.kinds : undefined}
      />
      <div className="max-w-sm space-y-2">
        <Field
          id={`${idPrefix}-after`}
          label="Only index activity after"
          optional
          helper="Leave empty to index the full history of issues, pull requests and discussions. Dates use UTC."
          error={attempted ? errors.after : undefined}
        >
          <Input
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={value.after}
            onChange={event => onChange({ ...value, after: event.target.value })}
          />
        </Field>
        {value.after && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...value, after: '' })}>
            Index full history
          </Button>
        )}
      </div>
      <Field
        id={`${idPrefix}-patterns`}
        label="Exclude file paths"
        optional
        helper={`One regular expression per line, matched against each file path in a repository, such as \\.min\\.js$ or ^vendor/. Up to ${githubCorpusLimits.excludePatterns} patterns of ${githubCorpusLimits.excludePatternLength} characters.`}
        error={attempted ? errors.patterns : undefined}
      >
        <Textarea
          rows={3}
          spellCheck={false}
          value={value.patterns}
          onChange={event => onChange({ ...value, patterns: event.target.value })}
        />
      </Field>
    </div>
  );
}
