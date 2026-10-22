import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { workspaceMemberFields, workspaceMemberLabel } from '@tulipfarm/tables/workspace-members';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { useCursorPages } from '@/lib/use-cursor-pages';
import { tableApi, type TableDefinition } from './api';
import { TableRead } from './feedback';
import { useMemberDirectory, useTableQueryResult, useTableRowsById } from './hooks';
import { useDebouncedValue } from './references';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  id: string;
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  error?: string | undefined;
};

export function WorkspaceMemberPicker(props: Props) {
  const read = useMemberDirectory(props.workspaceId);
  return (
    <TableRead state={read.state} refresh={read.refresh}>
      {data => (
        <MemberChoices
          workspaceId={props.workspaceId}
          workspaceSlug={props.workspaceSlug}
          id={props.id}
          value={props.value}
          onChange={props.onChange}
          error={props.error}
          disabled={props.disabled || read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing}
          table={{ id: data.tableId, revision: data.revision }}
        />
      )}
    </TableRead>
  );
}

function MemberChoices({
  workspaceId,
  workspaceSlug,
  id,
  value,
  onChange,
  disabled,
  error,
  table,
}: Props & { table: Pick<TableDefinition, 'id' | 'revision'> }) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const [term, setTerm] = useState('');
  const search = useDebouncedValue(term.trim());
  const pages = useCursorPages(`${table.revision}/${search}`);
  const read = useTableQueryResult(api, table, {
    query: {
      version: 2,
      mode: 'rows',
      where: null,
      sort: [{ fieldId: workspaceMemberFields.name, direction: 'asc' }],
      limit: 50,
      ...(search ? { search } : {}),
      ...(pages.after ? { after: pages.after } : {}),
    },
  });
  const selected = useTableRowsById(api, table, value ? [value] : []);
  const current = selected.state.kind === 'ready' ? selected.state.data[0] : undefined;
  const label = current
    ? workspaceMemberLabel(current.values)
    : value
      ? selected.state.kind === 'loading'
        ? 'Loading member…'
        : 'Selected member unavailable'
      : 'Choose a workspace member';
  const data = read.state.kind === 'ready' && read.state.data.mode === 'rows' ? read.state.data : null;
  const locked = disabled || !data || read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing;
  return (
    <div className="space-y-2">
      <Field
        id={id}
        label="Workspace member"
        required
        disabled={disabled}
        error={error}
        helper="Choose the person this invitation grants access to. Email alone never links a member."
      >
        <Select value={value} disabled={locked} onValueChange={next => onChange(next ?? '')}>
          <SelectTrigger width="full">
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Choose a member</SelectItem>
            {value && !data?.records.some(record => record.id === value) && (
              <SelectItem value={value}>{label}</SelectItem>
            )}
            {data?.records.map(record => {
              const email = record.values[workspaceMemberFields.contactEmail];
              return (
                <SelectItem key={record.id} value={record.id}>
                  {workspaceMemberLabel(record.values)}
                  {email?.kind === 'text' ? ` · ${email.value}` : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </Field>
      <SearchField
        id={`${id}-search`}
        label="Find a workspace member"
        placeholder="Search member names or contact details"
        value={term}
        maxLength={255}
        onChange={setTerm}
      />
      <TableRead state={read.state} refresh={read.refresh}>
        {result =>
          result.mode !== 'rows' ? (
            <p role="alert" className="text-sm text-destructive">
              The member list changed.{' '}
              <Button variant="link" size="sm" onClick={pages.first}>
                Load first page
              </Button>
            </p>
          ) : !result.records.length ? (
            <p className="text-sm text-muted-foreground">
              {search
                ? 'No members match this search. Clear it or try another name.'
                : 'No member rows are ready on this page.'}
            </p>
          ) : null
        }
      </TableRead>
      {value && selected.state.kind !== 'ready' && selected.state.kind !== 'loading' && (
        <Button variant="outline" size="sm" onClick={() => void selected.refresh()}>
          Retry selected member
        </Button>
      )}
      {(pages.after || data?.nextCursor) && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={locked || !pages.after} onClick={pages.previous}>
            Previous members
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={locked || !data?.nextCursor}
            onClick={() => {
              if (data?.nextCursor) pages.next(data.nextCursor);
            }}
          >
            Next members
          </Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Not listed?{' '}
        <Button
          variant="link"
          size="sm"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/tables/$tableId" params={{ workspaceSlug, tableId: table.id }} />}
        >
          Create a member first
        </Button>
      </p>
    </div>
  );
}
