import { useMemo, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { tableApi } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';

export function BuilderTablePicker({
  workspaceId,
  teams,
  value,
  onChange,
  disabled,
  hideLegend = false,
}: {
  workspaceId: string;
  teams: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  hideLegend?: boolean;
}) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const [search, setSearch] = useState('');
  if (read.state.kind === 'loading')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading accessible tables…
      </p>
    );
  if (read.state.kind !== 'ready')
    return (
      <div className="grid justify-items-start gap-2">
        <p role="alert" className="text-sm">
          Could not load table choices.
        </p>
        <Button variant="outline" disabled={disabled} onClick={() => void read.refresh()}>
          Retry table choices
        </Button>
      </div>
    );
  const tables = read.state.data;
  const shown = tables.filter(table => table.definition.label.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="grid min-w-0 gap-3">
      <SearchField
        label="Search business tables"
        placeholder="Find a table by name"
        value={search}
        onChange={setSearch}
      />
      {shown.length > 0 && (
        <div className="max-h-64 overflow-y-auto">
          <ChoiceGroup
            type="checkbox"
            optional
            legend="Business tables"
            legendVisibility={hideLegend ? 'screen-reader' : 'visible'}
            helper="Only tables you can access are listed."
            disabled={disabled}
            value={value.filter(id => shown.some(table => table.id === id))}
            options={shown.map(table => ({
              value: table.id,
              label: table.definition.label,
              ...(tables.filter(other => other.definition.label === table.definition.label).length > 1
                ? {
                    description:
                      teams.find(team => team.id === table.definition.owningTeamId)?.name ?? 'Team name unavailable',
                  }
                : {}),
            }))}
            onValueChange={next => onChange([...value.filter(id => !shown.some(table => table.id === id)), ...next])}
          />
        </div>
      )}
      {!tables.length && (
        <p className="text-sm text-muted-foreground">No tables are available to you. Ask an admin for table access.</p>
      )}
      {!!tables.length && !shown.length && (
        <p className="text-sm text-muted-foreground">No matching tables. Clear the search to see your choices.</p>
      )}
    </div>
  );
}
