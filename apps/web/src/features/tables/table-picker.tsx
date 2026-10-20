import { useMemo, useState } from 'react';
import { tableApi } from './api';
import { useTablePicker } from './hooks';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';

export function TablePicker({
  workspaceId,
  teams,
  id,
  label,
  required,
  value,
  disabled,
  error,
  onChange,
}: {
  workspaceId: string;
  teams: { id: string; name: string }[];
  id: string;
  label: string;
  required: boolean;
  value: string;
  disabled: boolean;
  error?: string | undefined;
  onChange: (id: string) => void;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const [search, setSearch] = useState('');
  const read = useTablePicker(api);
  const tables = read.state.kind === 'ready' ? read.state.data : [];
  const matches = (name: string) => name.toLowerCase().includes(search.toLowerCase());
  const tableLabel = (item: (typeof tables)[number]) =>
    `${item.definition.label} · ${teams.find(team => team.id === item.definition.owningTeamId)?.name ?? `Team ${item.definition.owningTeamId.slice(0, 8)}`} · ${item.id.slice(0, 8)}`;
  const selected = tables.find(item => item.id === value);
  const control =
    read.state.kind === 'loading' ? (
      <p role="status" className="text-sm text-muted-foreground">
        Loading accessible tables…
      </p>
    ) : read.state.kind !== 'ready' ? (
      <div className="grid justify-items-start gap-2">
        <p role="alert" className="text-sm">
          Could not load table choices.
        </p>
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry table choices
        </Button>
      </div>
    ) : (
      <div className="grid min-w-0 gap-2 sm:max-w-md">
        <Input
          aria-label={`Search ${label.toLowerCase()}`}
          value={search}
          disabled={disabled}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          placeholder="Find a table by name"
        />
        <Select value={value} disabled={disabled} onValueChange={next => onChange(next ?? '')}>
          <SelectTrigger id={id}>
            <SelectValue>
              {selected ? tableLabel(selected) : value ? 'Unavailable table' : 'Choose a table'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Choose a table</SelectItem>
            {tables
              .filter(item => item.id === value || matches(item.definition.label))
              .map(item => (
                <SelectItem key={item.id} value={item.id}>
                  {tableLabel(item)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {!tables.length && (
          <p className="text-sm text-muted-foreground">
            No tables are available to you. Ask an admin for table access.
          </p>
        )}
        {!!tables.length && !tables.some(item => matches(item.definition.label)) && (
          <p className="text-sm text-muted-foreground">No matching tables. Clear the search to see your choices.</p>
        )}
      </div>
    );
  const helper = 'Only tables you can access are listed.';
  return required ? (
    <Field id={id} label={label} required helper={helper} error={error} disabled={disabled}>
      {control}
    </Field>
  ) : (
    <Field id={id} label={label} optional helper={helper} error={error} disabled={disabled}>
      {control}
    </Field>
  );
}
