import { useMemo, useState } from 'react';
import { SlackChannelName, slackChannelMatches } from '@/components/slack-channel-name';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Switch } from '@tulipfarm/sprout/switch';
import { Table, type TableColumn } from '@tulipfarm/sprout/table';

type Kind = 'threads' | 'files';
const kindNames: Record<Kind, string> = { threads: 'Thread replies', files: 'Files' };
const all: Kind[] = ['threads', 'files'];

type Progress = { kind: 'indexed'; messages: number; synced: string } | { kind: 'indexing'; percent: number } | null;
type Channel = {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  members: number;
  progress: Progress;
  on: boolean;
  kinds: Kind[];
};

const seed: Channel[] = [
  {
    id: 'C1',
    name: 'general',
    visibility: 'public',
    members: 48,
    progress: { kind: 'indexed', messages: 12_840, synced: '2 min ago' },
    on: true,
    kinds: all,
  },
  {
    id: 'C2',
    name: 'eng',
    visibility: 'public',
    members: 21,
    progress: { kind: 'indexing', percent: 74 },
    on: true,
    kinds: all,
  },
  {
    id: 'C3',
    name: 'founders',
    visibility: 'private',
    members: 3,
    progress: { kind: 'indexed', messages: 2_115, synced: '9 min ago' },
    on: true,
    kinds: ['threads'],
  },
  {
    id: 'C4',
    name: 'incidents',
    visibility: 'private',
    members: 9,
    progress: { kind: 'indexed', messages: 640, synced: '1 hr ago' },
    on: true,
    kinds: all,
  },
  { id: 'C5', name: 'design-crit', visibility: 'public', members: 14, progress: null, on: true, kinds: ['threads'] },
  { id: 'C6', name: 'random', visibility: 'public', members: 46, progress: null, on: false, kinds: all },
  { id: 'C7', name: 'hiring', visibility: 'private', members: 4, progress: null, on: false, kinds: all },
];

const summary = (channel: Channel) =>
  !channel.on
    ? 'Not indexed'
    : channel.progress?.kind === 'indexing'
      ? `Indexing · ${channel.progress.percent}%`
      : channel.progress?.kind === 'indexed'
        ? `${channel.progress.messages.toLocaleString()} messages · synced ${channel.progress.synced}`
        : 'Queued for import';

// Prototype only: the API stores whole conversations, without per-channel content types.
export function SlackChannelContentPrototype() {
  const [channels, setChannels] = useState(seed);
  const [saved, setSaved] = useState(seed);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const shown = useMemo(() => channels.filter(channel => slackChannelMatches(channel.name, query)), [channels, query]);
  const dirty = JSON.stringify(channels) !== JSON.stringify(saved);
  const update = (id: string, change: (channel: Channel) => Channel) => {
    setStatus(null);
    setChannels(current => current.map(channel => (channel.id === id ? change(channel) : channel)));
  };
  const withKind = (kinds: Kind[], kind: Kind, checked: boolean) =>
    checked ? all.filter(item => item === kind || kinds.includes(item)) : kinds.filter(item => item !== kind);
  const column = (kind: Kind) => {
    const eligible = shown.filter(channel => channel.on);
    const count = eligible.filter(channel => channel.kinds.includes(kind)).length;
    return {
      eligible: eligible.length,
      checked: eligible.length > 0 && count === eligible.length,
      mixed: count > 0 && count < eligible.length,
    };
  };
  const toggleColumn = (kind: Kind, checked: boolean) => {
    setStatus(null);
    setChannels(current =>
      current.map(channel =>
        channel.on && shown.some(item => item.id === channel.id)
          ? { ...channel, kinds: withKind(channel.kinds, kind, checked) }
          : channel,
      ),
    );
  };

  type Row = { id: string; name: string; channel: Channel } & Record<Kind, boolean>;
  const rows: Row[] = shown.map(channel => ({
    id: channel.id,
    name: channel.name,
    channel,
    threads: channel.on && channel.kinds.includes('threads'),
    files: channel.on && channel.kinds.includes('files'),
  }));
  const columns: TableColumn<Row>[] = [
    {
      key: 'name',
      header: 'Channel',
      cell: ({ channel }) => (
        <span className="flex items-center gap-3 py-1">
          <Switch
            size="sm"
            checked={channel.on}
            aria-label={`Index #${channel.name}`}
            onCheckedChange={on => update(channel.id, item => ({ ...item, on }))}
          />
          <span className="min-w-0">
            <span className="flex font-medium text-foreground">
              <SlackChannelName title={channel.name} private={channel.visibility === 'private'} />
            </span>
            <span className="block text-xs tabular-nums text-muted-foreground">
              {channel.members} members · {summary(channel)}
            </span>
          </span>
        </span>
      ),
    },
    ...all.map((kind): TableColumn<Row> => ({
      key: kind,
      header: kindNames[kind],
      cell: row => (
        <Checkbox
          aria-label={`${kindNames[kind]} from #${row.name}`}
          checked={row[kind]}
          disabled={!row.channel.on}
          onCheckedChange={checked =>
            update(row.id, channel => ({ ...channel, kinds: withKind(channel.kinds, kind, checked) }))
          }
        />
      ),
    })),
  ];
  return (
    <section aria-labelledby="slack-channels-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="slack-channels-title" className="text-base font-semibold text-foreground">
              Channels
            </h2>
            <Badge variant="outline">Prototype</Badge>
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">
            Channels you’ve joined. Choose which to index and whether to include thread replies and shared files.
            Messages in the channel are always included when it’s on.
          </p>
        </div>
        <div className="w-full sm:w-64">
          <SearchField label="Filter channels" value={query} onChange={setQuery} />
        </div>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3">
        <legend className="sr-only">Content in every indexed channel</legend>
        <span aria-hidden className="text-sm font-medium text-foreground">
          All channels
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
        aria-label="Content indexed from each Slack channel"
        variant="plain"
        narrow="stack"
        data={rows}
        getRowId={row => row.id}
        rowLabel={row => `#${row.name}`}
        columns={columns}
        empty={<p className="text-sm text-muted-foreground">No channels match “{query}”.</p>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
          {status ?? `${channels.filter(channel => channel.on).length} of ${channels.length} channels indexed`}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty} onClick={() => setChannels(saved)}>
            Discard
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setSaved(channels);
              setStatus('Saved in this prototype only. Nothing was sent to Slack.');
            }}
          >
            Save changes
          </Button>
        </div>
      </div>
    </section>
  );
}
