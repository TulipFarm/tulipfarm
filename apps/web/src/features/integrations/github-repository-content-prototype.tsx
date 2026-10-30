import { useMemo, useState } from 'react';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Switch } from '@tulipfarm/sprout/switch';
import { Table, type TableColumn } from '@tulipfarm/sprout/table';
import { type GitHubKind } from './github-knowledge-api';
import { PrivateMark } from '@/components/private-mark';

// Prototype only: the API stores content types per source, not per repository.
export const githubRepositoryPrototypeEnabled =
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  window.location.pathname.startsWith('/default-knowledge-mock/');

const kindNames: Record<GitHubKind, string> = {
  code: 'Code',
  docs: 'Docs',
  issues: 'Issues',
  pulls: 'Pull requests',
  discussions: 'Discussions',
  commits: 'Commits',
};

type Progress = { kind: 'indexed'; items: number; synced: string } | { kind: 'indexing'; percent: number } | null;
type Repository = {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  progress: Progress;
  on: boolean;
  kinds: GitHubKind[];
};

const all: GitHubKind[] = ['code', 'docs', 'issues', 'pulls', 'discussions', 'commits'];
const seed: Repository[] = [
  {
    id: '1',
    name: 'TulipFarm/tulipfarm',
    visibility: 'public',
    progress: { kind: 'indexed', items: 18_204, synced: '4 min ago' },
    on: true,
    kinds: all,
  },
  {
    id: '2',
    name: 'TulipFarm/tulipfarm-private',
    visibility: 'private',
    progress: { kind: 'indexing', percent: 62 },
    on: true,
    kinds: ['code', 'docs', 'issues', 'pulls'],
  },
  {
    id: '3',
    name: 'TulipFarm/sprout',
    visibility: 'public',
    progress: { kind: 'indexed', items: 3_912, synced: '12 min ago' },
    on: true,
    kinds: ['code', 'docs', 'pulls'],
  },
  {
    id: '4',
    name: 'TulipFarm/website',
    visibility: 'private',
    progress: { kind: 'indexed', items: 1_480, synced: '1 hr ago' },
    on: true,
    kinds: ['docs', 'issues'],
  },
  { id: '5', name: 'TulipFarm/deploy', visibility: 'private', progress: null, on: false, kinds: all },
  { id: '6', name: 'ada-dev/dotfiles', visibility: 'public', progress: null, on: false, kinds: all },
];

const summary = (repository: Repository) =>
  !repository.on
    ? 'Not indexed'
    : repository.progress?.kind === 'indexing'
      ? `Indexing · ${repository.progress.percent}%`
      : repository.progress?.kind === 'indexed'
        ? `${repository.progress.items.toLocaleString()} items · synced ${repository.progress.synced}`
        : 'Queued for import';

export function GitHubRepositoryContentPrototype() {
  const [repositories, setRepositories] = useState(seed);
  const [saved, setSaved] = useState(seed);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const shown = useMemo(
    () => repositories.filter(repository => repository.name.toLowerCase().includes(query.trim().toLowerCase())),
    [repositories, query],
  );
  const dirty = JSON.stringify(repositories) !== JSON.stringify(saved);
  const indexed = repositories.filter(repository => repository.on);
  const update = (id: string, change: (repository: Repository) => Repository) => {
    setStatus(null);
    setRepositories(current => current.map(repository => (repository.id === id ? change(repository) : repository)));
  };
  const toggleKind = (id: string, kind: GitHubKind, checked: boolean) =>
    update(id, repository => {
      const kinds = checked
        ? all.filter(item => item === kind || repository.kinds.includes(item))
        : repository.kinds.filter(item => item !== kind);
      return { ...repository, kinds, on: kinds.length > 0 };
    });
  const toggleColumn = (kind: GitHubKind, checked: boolean) => {
    setStatus(null);
    setRepositories(current =>
      current.map(repository =>
        repository.on && shown.some(item => item.id === repository.id)
          ? {
              ...repository,
              kinds: checked
                ? all.filter(item => item === kind || repository.kinds.includes(item))
                : repository.kinds.filter(item => item !== kind),
            }
          : repository,
      ),
    );
  };
  const column = (kind: GitHubKind) => {
    const eligible = shown.filter(repository => repository.on);
    const count = eligible.filter(repository => repository.kinds.includes(kind)).length;
    return {
      eligible: eligible.length,
      checked: eligible.length > 0 && count === eligible.length,
      mixed: count > 0 && count < eligible.length,
    };
  };
  const enable = (id: string, on: boolean) =>
    update(id, repository => ({ ...repository, on, kinds: on && !repository.kinds.length ? all : repository.kinds }));

  type Row = Record<'id' | 'name', string> & Record<GitHubKind, boolean> & { repository: Repository };
  const rows: Row[] = shown.map(repository => ({
    id: repository.id,
    name: repository.name,
    repository,
    ...(Object.fromEntries(all.map(kind => [kind, repository.on && repository.kinds.includes(kind)])) as Record<
      GitHubKind,
      boolean
    >),
  }));
  const columns: TableColumn<Row>[] = [
    {
      key: 'name',
      header: 'Repository',
      cell: ({ repository }) => (
        <span className="flex items-center gap-3 py-1">
          <Switch
            size="sm"
            checked={repository.on}
            aria-label={`Index ${repository.name}`}
            onCheckedChange={on => enable(repository.id, on)}
          />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-all font-medium text-foreground">{repository.name}</span>
              {repository.visibility === 'private' && <PrivateMark />}
            </span>
            <span className="block text-xs tabular-nums text-muted-foreground">{summary(repository)}</span>
          </span>
        </span>
      ),
    },
    ...all.map((kind): TableColumn<Row> => ({
      key: kind,
      header: kindNames[kind],
      cell: row => (
        <Checkbox
          aria-label={`${kindNames[kind]} from ${row.name}`}
          checked={row[kind]}
          disabled={!row.repository.on}
          onCheckedChange={checked => toggleKind(row.id, kind, checked)}
        />
      ),
    })),
  ];
  return (
    <section aria-labelledby="github-repositories-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="github-repositories-title" className="text-base font-semibold text-foreground">
              Repositories
            </h2>
            <Badge variant="outline">Prototype</Badge>
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">
            Choose which repositories to index and what to bring in from each. Turning a type off removes it from
            Knowledge on the next sync; your GitHub data is not changed.
          </p>
        </div>
        <div className="w-full sm:w-64">
          <SearchField label="Filter repositories" value={query} onChange={setQuery} />
        </div>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3">
        <legend className="sr-only">Content in every indexed repository</legend>
        <span aria-hidden className="text-sm font-medium text-foreground">
          All repositories
        </span>
        {all.map(kind => {
          const state = column(kind);
          return (
            <Label key={kind}>
              <Checkbox
                variant="neutral"
                checked={state.checked}
                indeterminate={state.mixed}
                disabled={!state.eligible}
                onCheckedChange={checked => toggleColumn(kind, checked)}
              />
              {kindNames[kind]}
            </Label>
          );
        })}
      </fieldset>

      <Table
        aria-label="Content indexed from each repository"
        narrow="stack"
        data={rows}
        getRowId={row => row.id}
        rowLabel={row => row.name}
        columns={columns}
        empty={<p className="text-sm text-muted-foreground">No repositories match “{query}”.</p>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
          {status ?? `${indexed.length} of ${repositories.length} repositories indexed`}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={!dirty} onClick={() => setRepositories(saved)}>
            Discard
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setSaved(repositories);
              setStatus('Saved in this prototype only. Nothing was sent to GitHub.');
            }}
          >
            Save changes
          </Button>
        </div>
      </div>
    </section>
  );
}
