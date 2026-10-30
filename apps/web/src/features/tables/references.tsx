import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { AvatarGroup, AvatarGroupCount, EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { useFeatureRead } from '@/lib/query';
import { fileKeys, useFilesApi, type FileSummary } from '@/features/files/api';
import { formatTableValue } from './definition-view';
import { optionTone } from './table-view';
import { MemberPhoto } from './member-profile';
import {
  workspaceMemberAccess,
  workspaceMemberFields,
  workspaceMemberLabel,
} from '@tulipfarm/tables/workspace-members';
import type { TableDataRow } from './api';
import type { ReadState } from './request-state';
import type { TableDefinition, TableValue, TableValues } from './review-contracts';

/** `sessionId` lets an upload refuse to send after the person signs in as someone else. */
export type TableWorkspace = { id: string; slug: string; sessionId: string };
export type LinkedLabels = ReadState<Record<string, string>>;
export type FileNames = ReadState<Record<string, FileSummary>>;
type Reread<T> = { state: ReadState<T>; refresh: () => Promise<void> };

export function useDebouncedValue<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function fileIdsOf(values: readonly (TableValues | null)[]) {
  return values.flatMap(record =>
    Object.values(record ?? {}).flatMap(value => (value?.kind === 'file' ? value.fileIds : [])),
  );
}

const noFiles: FileNames = { kind: 'ready', data: {}, refreshing: false, error: null };
/** One access-checked request per 100 files. Ids the server already marked unavailable are never requested. */
export function useFileNames(workspaceId: string, fileIds: readonly string[], unavailable: readonly string[] = []) {
  const api = useFilesApi(workspaceId);
  const ids = [...new Set(fileIds)].filter(id => !unavailable.includes(id)).sort();
  const read = useFeatureRead({
    key: [...fileKeys.all, 'summaries', ids],
    enabled: ids.length > 0,
    load: async signal => {
      const names: Record<string, FileSummary> = {};
      for (let start = 0; start < ids.length; start += 100) {
        for (const file of await api.summaries(ids.slice(start, start + 100), signal)) names[file.id] = file;
      }
      return names;
    },
  });
  return ids.length ? read : { ...read, state: noFiles };
}

export function fileLabel(files: FileNames, fileId: string) {
  if (files.kind === 'ready') return files.data[fileId]?.name ?? 'File unavailable';
  if (files.kind === 'unavailable') return 'File unavailable';
  return files.kind === 'loading' ? 'Loading file…' : 'File name not loaded';
}

export function linkedLabel(linked: LinkedLabels, recordId: string) {
  if (linked.kind === 'ready') return linked.data[recordId] ?? 'Row unavailable';
  return linked.kind === 'loading' ? 'Loading linked row…' : 'Linked row not loaded';
}

const failed = (state: ReadState<unknown>) => state.kind === 'error' || (state.kind === 'ready' && !!state.error);

export function ReferenceRetry({
  linked,
  files,
  disabled = false,
}: {
  linked?: Reread<Record<string, string>>;
  files?: Reread<Record<string, FileSummary>>;
  disabled?: boolean;
}) {
  const rows = linked && failed(linked.state),
    names = files && failed(files.state);
  if (!rows && !names) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-muted-foreground">
        {rows && names
          ? 'Couldn’t load linked row and file names.'
          : rows
            ? 'Couldn’t load linked row names.'
            : 'Couldn’t load file names.'}
      </p>
      {rows && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void linked.refresh()}>
          Retry linked rows
        </Button>
      )}
      {names && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void files.refresh()}>
          Retry file names
        </Button>
      )}
    </div>
  );
}

function FileName({ fileId, files, workspace }: { fileId: string; files: FileNames; workspace: TableWorkspace }) {
  const file = files.kind === 'ready' ? files.data[fileId] : undefined;
  if (!file) return <span className="text-muted-foreground">{fileLabel(files, fileId)}</span>;
  return (
    <Button
      variant="link"
      nativeButton={false}
      render={<Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug: workspace.slug, fileId }} />}
    >
      {file.name}
    </Button>
  );
}

function LinkedRowName({
  tableId,
  recordId,
  linked,
  workspace,
  compact,
}: {
  compact: boolean;
  tableId: string;
  recordId: string;
  linked: LinkedLabels;
  workspace: TableWorkspace;
}) {
  const label = linked.kind === 'ready' ? linked.data[recordId] : undefined;
  if (label === undefined) return <span className="text-muted-foreground">{linkedLabel(linked, recordId)}</span>;
  return (
    <Button
      variant="link"
      nativeButton={false}
      render={
        <Link
          to="/$workspaceSlug/tables/$tableId"
          params={{ workspaceSlug: workspace.slug, tableId }}
          search={{ row: recordId }}
        />
      }
    >
      {compact ? (
        <span title={label} className="max-w-40 truncate">
          {label}
        </span>
      ) : (
        label
      )}
    </Button>
  );
}

/** Linked rows on one line: two avatars and linked names, and everyone else as a count. Hovering the avatars lists every name. */
function LinkedPeople({
  tableId,
  ids,
  linked,
  workspace,
}: {
  tableId: string;
  ids: readonly string[];
  linked: LinkedLabels;
  workspace: TableWorkspace;
}) {
  const names = ids.map(id => (linked.kind === 'ready' ? linked.data[id] : undefined) ?? linkedLabel(linked, id));
  const rest = ids.length - 2;
  const avatars = (
    // The ring matches the card and grid surface, so overlapping avatars stay distinct.
    <span className="flex shrink-0" style={{ '--sprout-avatar-ring': 'var(--card)' } as CSSProperties}>
      <AvatarGroup>
        {ids.slice(0, 2).map((id, index) => (
          <EntityAvatar key={id} seed={id} name={names[index]!} size="sm" />
        ))}
        {rest > 0 && <AvatarGroupCount>+{rest}</AvatarGroupCount>}
      </AvatarGroup>
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-2">
      {ids.length < 2 ? (
        <span aria-hidden="true" className="flex shrink-0">
          {avatars}
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger aria-hidden="true" tabIndex={-1} render={<span className="flex shrink-0" />}>
            {avatars}
          </TooltipTrigger>
          <TooltipContent>
            <span className="flex flex-col items-start">
              {names.map((name, index) => (
                <span key={ids[index]}>{name}</span>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
      <span className="min-w-0 truncate [&_a]:hover:underline [&_a]:underline-offset-4">
        {ids.slice(0, 2).map((id, index) => (
          <span key={id}>
            {index > 0 && ', '}
            {linked.kind === 'ready' && linked.data[id] !== undefined ? (
              <Link
                to="/$workspaceSlug/tables/$tableId"
                params={{ workspaceSlug: workspace.slug, tableId }}
                search={{ row: id }}
              >
                {names[index]}
              </Link>
            ) : (
              <span className="text-muted-foreground">{names[index]}</span>
            )}
          </span>
        ))}
        {rest > 0 && <span className="sr-only">{` and ${rest} more`}</span>}
      </span>
    </span>
  );
}

const accessTone = (optionId: string) =>
  optionId === workspaceMemberAccess.active
    ? 'success'
    : optionId === workspaceMemberAccess.invited
      ? 'warning'
      : 'outline';

/** Grid cells are compact and truncate long text with a tooltip; detail views wrap the full value. */
export function TableValueView({
  value,
  definition,
  fieldId,
  linked,
  files,
  unavailableFileIds,
  workspace,
  compact = false,
  systemKind,
  record,
  withPhoto = false,
}: {
  compact?: boolean;
  /** Show the member's photo beside their name, for grids that fold the Photo column into Name. */
  withPhoto?: boolean;
  value: TableValue | undefined;
  definition: TableDefinition;
  fieldId: string;
  linked: LinkedLabels;
  files: FileNames;
  unavailableFileIds: readonly string[];
  workspace: TableWorkspace;
  systemKind?: 'workspace-members' | undefined;
  record?: Pick<TableDataRow, 'id' | 'values'> | undefined;
}) {
  if (systemKind === 'workspace-members' && fieldId === workspaceMemberFields.photo)
    return <MemberPhoto workspaceId={workspace.id} value={value} record={record} />;
  if (systemKind === 'workspace-members' && fieldId === workspaceMemberFields.name && record) {
    const label = workspaceMemberLabel(record.values);
    const name = (
      <span title={label} className={compact ? 'block max-w-64 truncate' : 'whitespace-pre-wrap wrap-anywhere'}>
        {label}
      </span>
    );
    if (!withPhoto) return name;
    return (
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="flex shrink-0">
          <MemberPhoto workspaceId={workspace.id} value={record.values[workspaceMemberFields.photo]} record={record} />
        </span>
        {name}
      </span>
    );
  }
  if (compact && systemKind === 'workspace-members' && fieldId === workspaceMemberFields.accountEmail && record) {
    const contact = record.values[workspaceMemberFields.contactEmail];
    if (
      value?.kind === 'text' &&
      contact?.kind === 'text' &&
      value.value.trim().toLowerCase() === contact.value.trim().toLowerCase()
    )
      return (
        <span title={value.value} className="text-muted-foreground">
          Same as contact
        </span>
      );
  }
  if (value?.kind === 'relationship' && value.recordIds.length && compact)
    return <LinkedPeople tableId={value.tableId} ids={value.recordIds} linked={linked} workspace={workspace} />;
  if (value?.kind === 'relationship' && value.recordIds.length)
    return (
      <ul className="space-y-1">
        {value.recordIds.map(id => (
          <li key={id}>
            <LinkedRowName
              tableId={value.tableId}
              recordId={id}
              linked={linked}
              workspace={workspace}
              compact={compact}
            />
          </li>
        ))}
      </ul>
    );
  if (value?.kind === 'file' && value.fileIds.length)
    return (
      <ul className="space-y-1">
        {value.fileIds.map(id => (
          <li key={id} className="wrap-anywhere">
            {unavailableFileIds.includes(id) ? (
              <span className="text-muted-foreground">File unavailable</span>
            ) : (
              <FileName fileId={id} files={files} workspace={workspace} />
            )}
          </li>
        ))}
      </ul>
    );
  const field = definition.fields.find(item => item.id === fieldId);
  const options = field?.kind === 'single-select' || field?.kind === 'multi-select' ? field.options : [];
  const label = (id: string) => options.find(option => option.id === id)?.label ?? id;
  const ids =
    value?.kind === 'single-select' ? [value.optionId] : value?.kind === 'multi-select' ? value.optionIds : [];
  const shown = compact && ids.length > 2 ? ids.slice(0, 1) : ids;
  if (ids.length)
    return (
      <span
        title={ids.map(label).join(', ')}
        className={compact ? 'flex max-w-full min-w-0 gap-1' : 'flex flex-wrap gap-1'}
      >
        {shown.map(id => (
          <span key={id} className="flex min-w-0">
            <Badge
              variant={
                systemKind === 'workspace-members' && fieldId === workspaceMemberFields.access
                  ? accessTone(id)
                  : optionTone(label(id))
              }
            >
              <span className="min-w-0 truncate">{label(id)}</span>
            </Badge>
          </span>
        ))}
        {shown.length < ids.length && <Badge variant="outline">+{ids.length - shown.length}</Badge>}
      </span>
    );
  const text = compact && value == null ? '—' : formatTableValue(value, definition, fieldId);
  return (
    <span
      title={text}
      className={
        value == null
          ? 'text-muted-foreground'
          : compact
            ? 'block max-w-64 truncate'
            : 'whitespace-pre-wrap wrap-anywhere'
      }
    >
      {text}
    </span>
  );
}
