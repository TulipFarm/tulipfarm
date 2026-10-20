import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Field, ChoiceGroup } from '@tulipfarm/sprout/field';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { useFeatureRead } from '@/lib/query';
import { formatFileSize } from '@/lib/file-viewer';
import { fileKeys, maxUploadBytes, useFilesApi, useFilesChanges } from '@/features/files/api';
import { TableRead } from './feedback';
import { useLinkedRows, useTableDetail, useTableRelationship } from './hooks';
import { rowLabel } from './definition-view';
import {
  fileLabel,
  linkedLabel,
  ReferenceRetry,
  useDebouncedValue,
  useFileNames,
  type FileNames,
  type TableWorkspace,
} from './references';
import { useTableWrite } from './use-table-write';
import type { TableField, TableValue } from './review-contracts';
import type { TableApi } from './api';
import { localDateTime, utcTimestamp } from './row-query';
import { fieldHint } from './record-validation';

function RowField({
  field,
  error,
  disabled,
  helper,
  children,
}: {
  field: TableField;
  error: string | undefined;
  disabled: boolean;
  helper?: string;
  children: ReactElement;
}) {
  const id = `record-field-${field.id}`;
  return field.required ? (
    <Field id={id} label={field.label} required disabled={disabled} error={error} helper={helper}>
      {children}
    </Field>
  ) : (
    <Field id={id} label={field.label} optional disabled={disabled} error={error} helper={helper}>
      {children}
    </Field>
  );
}

function RowFieldGroup({
  field,
  error,
  disabled,
  children,
}: {
  field: TableField;
  error: string | undefined;
  disabled: boolean;
  children: ReactNode;
}) {
  const id = `record-field-${field.id}`;
  return (
    <fieldset
      id={id}
      disabled={disabled}
      tabIndex={-1}
      aria-invalid={!!error}
      aria-describedby={error ? `${id}-error` : undefined}
      className="min-w-0 space-y-3"
    >
      <legend className="mb-2 text-sm font-medium">
        {field.label}{' '}
        <span className="text-xs font-normal text-muted-foreground">{field.required ? 'Required' : 'Optional'}</span>
      </legend>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function FieldInput({
  field,
  value,
  error,
  disabled,
  change,
  api,
  workspace,
  unavailableFileIds,
}: {
  field: TableField;
  value: TableValue | undefined;
  error: string | undefined;
  disabled: boolean;
  change: (value: TableValue) => void;
  api: TableApi;
  workspace: TableWorkspace;
  unavailableFileIds: readonly string[];
}) {
  const id = `record-field-${field.id}`;
  if (field.kind === 'file')
    return (
      <RowFieldGroup field={field} error={error} disabled={disabled}>
        <FileReferenceInput
          field={field}
          value={value}
          disabled={disabled}
          change={change}
          workspace={workspace}
          unavailableFileIds={unavailableFileIds}
        />
      </RowFieldGroup>
    );
  if (field.kind === 'relationship')
    return (
      <RowFieldGroup field={field} error={error} disabled={disabled}>
        <RelationshipInput
          field={field}
          value={value}
          disabled={disabled}
          change={change}
          api={api}
          workspace={workspace}
        />
      </RowFieldGroup>
    );
  if (field.kind === 'single-select' || field.kind === 'boolean') {
    const current =
      value?.kind === 'single-select' ? value.optionId : value?.kind === 'boolean' ? String(value.value) : '';
    const selectedOption =
      field.kind === 'single-select' ? field.options.find(option => option.id === current) : undefined;
    const selectedLabel = !current
      ? 'Not set'
      : field.kind === 'boolean'
        ? current === 'true'
          ? 'Yes'
          : 'No'
        : selectedOption
          ? `${selectedOption.label}${selectedOption.retired ? ' (retired)' : ''}`
          : 'Unavailable option';
    return (
      <RowField field={field} error={error} disabled={disabled}>
        <Select
          value={current}
          disabled={disabled}
          onValueChange={next =>
            change(
              !next
                ? null
                : field.kind === 'boolean'
                  ? { kind: 'boolean', value: next === 'true' }
                  : { kind: 'single-select', optionId: next },
            )
          }
        >
          <SelectTrigger width="full">
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Not set</SelectItem>
            {field.kind === 'boolean' ? (
              <>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </>
            ) : (
              field.options.map(option => (
                <SelectItem key={option.id} value={option.id} disabled={option.retired}>
                  {option.label}
                  {option.retired ? ' (retired)' : ''}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </RowField>
    );
  }
  if (field.kind === 'multi-select') {
    const selected = value?.kind === 'multi-select' ? value.optionIds : [];
    const options = field.options.map(option => ({
      value: option.id,
      label: `${option.label}${option.retired ? ' (retired)' : ''}`,
      disabled: option.retired && !selected.includes(option.id),
    }));
    const update = (optionIds: string[]) => change({ kind: 'multi-select', optionIds });
    return field.required ? (
      <ChoiceGroup
        id={id}
        legend={field.label}
        required
        type="checkbox"
        options={options}
        value={selected}
        onValueChange={update}
        disabled={disabled}
        error={error}
      />
    ) : (
      <ChoiceGroup
        id={id}
        legend={field.label}
        optional
        type="checkbox"
        options={options}
        value={selected}
        onValueChange={update}
        disabled={disabled}
        error={error}
      />
    );
  }
  const text = value && 'value' in value ? String(value.value) : '';
  const timestamp = field.kind === 'timestamp';
  const zone = timestamp ? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC') : '';
  if (field.kind === 'text' && field.maxLength > 255)
    return (
      <RowField field={field} error={error} disabled={disabled} helper={fieldHint(field)}>
        <Textarea
          value={text}
          rows={3}
          onChange={event => change(event.target.value === '' ? null : { kind: 'text', value: event.target.value })}
        />
      </RowField>
    );
  return (
    <RowField
      field={field}
      error={error}
      disabled={disabled}
      helper={timestamp ? `Your time zone: ${zone}. Saved in UTC.` : fieldHint(field)}
    >
      <Input
        type={field.kind === 'date' ? 'date' : timestamp ? 'datetime-local' : 'text'}
        inputMode={field.kind === 'numeric' ? 'decimal' : undefined}
        value={timestamp ? localDateTime(text) : text}
        onChange={event => {
          const next = timestamp ? utcTimestamp(event.target.value) : event.target.value;
          change(next === '' ? null : { kind: field.kind, value: next });
        }}
      />
    </RowField>
  );
}

type FileField = Extract<TableField, { kind: 'file' }>;

function FileReferenceInput({
  field,
  value,
  disabled,
  change,
  workspace,
  unavailableFileIds,
}: {
  field: FileField;
  value: TableValue | undefined;
  disabled: boolean;
  change: (value: TableValue) => void;
  workspace: TableWorkspace;
  unavailableFileIds: readonly string[];
}) {
  const id = `record-field-${field.id}`;
  const ids = value?.kind === 'file' ? value.fileIds : [];
  const attach = (fileId: string) =>
    change({ kind: 'file', fileIds: field.cardinality === 'one' ? [fileId] : [...new Set([...ids, fileId])] });
  const detach = (fileId: string) => {
    const remaining = ids.filter(item => item !== fileId);
    change(remaining.length ? { kind: 'file', fileIds: remaining } : null);
  };
  const files = useFileNames(workspace.id, ids, unavailableFileIds);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {field.cardinality === 'one' ? 'Attach one file.' : 'Attach files.'} Saving checks your access to each file.
        Table access does not share files.
      </p>
      {ids.length ? (
        <ul aria-label={`Files attached to ${field.label}`} className="space-y-1">
          {ids.map((fileId, index) => (
            <AttachedFile
              key={fileId}
              fileId={fileId}
              position={index + 1}
              files={unavailableFileIds.includes(fileId) ? { kind: 'unavailable', status: 404 } : files.state}
              field={field}
              disabled={disabled}
              remove={() => detach(fileId)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No files attached.</p>
      )}
      <ReferenceRetry files={files} disabled={disabled} />
      <FileSearch id={id} field={field} workspace={workspace} attached={ids} disabled={disabled} attach={attach} />
      <FileUpload field={field} workspace={workspace} disabled={disabled} attach={attach} />
    </div>
  );
}

function AttachedFile({
  fileId,
  position,
  files,
  field,
  disabled,
  remove,
}: {
  fileId: string;
  position: number;
  files: FileNames;
  field: FileField;
  disabled: boolean;
  remove: () => void;
}) {
  const file = files.kind === 'ready' ? files.data[fileId] : undefined;
  const name = fileLabel(files, fileId);
  return (
    <li className="flex flex-wrap items-center gap-2">
      {file && <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />}
      <span className={`min-w-0 break-all text-sm${file ? '' : ' text-muted-foreground'}`}>{name}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-label={file ? `Remove ${name} from ${field.label}` : `Remove file ${position} from ${field.label}`}
        onClick={remove}
      >
        Remove
      </Button>
    </li>
  );
}

function FileSearch({
  id,
  field,
  workspace,
  attached,
  disabled,
  attach,
}: {
  id: string;
  field: FileField;
  workspace: TableWorkspace;
  attached: readonly string[];
  disabled: boolean;
  attach: (fileId: string) => void;
}) {
  const api = useFilesApi(workspace.id);
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim());
  const read = useFeatureRead({
    key: [...fileKeys.all, 'table-attach', settled],
    load: signal => api.suggestions(settled, signal),
  });
  const replace = field.cardinality === 'one' && attached.length > 0;
  return (
    <div className="space-y-2">
      <SearchField
        id={`${id}-search`}
        label={`Search files for ${field.label}`}
        placeholder="Search your files"
        value={query}
        maxLength={255}
        onChange={setQuery}
      />
      {read.state.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Searching files…
        </p>
      )}
      {read.state.kind === 'unavailable' && (
        <p className="text-sm text-muted-foreground">
          Files are unavailable to you. Upload a file instead, or ask a workspace admin for access.
        </p>
      )}
      {read.state.kind === 'error' && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t search files. {read.state.message}</AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void read.refresh()}>
            Retry file search
          </Button>
        </div>
      )}
      {read.state.kind === 'ready' &&
        (read.state.data.items.length === 0 ? (
          settled ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-muted-foreground">No files match “{settled}”.</p>
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => setQuery('')}>
                Clear search
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent files. Upload a file or search by name.</p>
          )
        ) : (
          <ul aria-label={settled ? 'Matching files' : 'Recent files'} className="space-y-1">
            {read.state.data.items.map(file => (
              <li key={file.id} className="flex min-w-0 items-center gap-2">
                <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                  {file.name}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || attached.includes(file.id)}
                  aria-label={
                    attached.includes(file.id)
                      ? `${file.name} attached`
                      : `${replace ? 'Replace with' : 'Attach'} ${file.name}`
                  }
                  onClick={() => attach(file.id)}
                >
                  {attached.includes(file.id) ? 'Attached' : replace ? 'Replace' : 'Attach'}
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

type UploadInput = { id: string; file: File };

function FileUpload({
  field,
  workspace,
  disabled,
  attach,
}: {
  field: FileField;
  workspace: TableWorkspace;
  disabled: boolean;
  attach: (fileId: string) => void;
}) {
  const api = useFilesApi(workspace.id);
  const files = useFilesChanges();
  const chooser = useRef<HTMLInputElement>(null);
  const transfer = useRef<AbortController | null>(null);
  useEffect(() => () => transfer.current?.abort(), []);
  const [sent, setSent] = useState(0);
  const [problem, setProblem] = useState('');
  const [uploaded, setUploaded] = useState('');
  const upload = useTableWrite(
    (input: UploadInput) => {
      transfer.current = new AbortController();
      setSent(0);
      return api.upload(input.id, input.file, null, workspace.sessionId, transfer.current.signal, setSent);
    },
    file => {
      attach(file.id);
      setUploaded(file.name);
      void files.changed();
    },
  );
  const state = upload.state;
  function choose(file: File | undefined) {
    setUploaded('');
    if (!file) return;
    if (file.size === 0) {
      setProblem(`${file.name} is empty. Choose a file with content.`);
      return;
    }
    if (file.size > maxUploadBytes) {
      setProblem(`${file.name} is ${formatFileSize(file.size)}. The upload limit is 10 MB.`);
      return;
    }
    setProblem('');
    void upload.submit({ id: crypto.randomUUID(), file });
  }
  return (
    <div className="space-y-2">
      <Input
        ref={chooser}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={event => {
          choose(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || state.kind === 'sending'}
          aria-busy={state.kind === 'sending'}
          onClick={() => chooser.current?.click()}
        >
          {state.kind === 'sending' ? `Uploading file to ${field.label}…` : `Upload file to ${field.label}`}
        </Button>
        <span className="text-xs text-muted-foreground">Uploads go to My files. Up to 10 MB.</span>
      </div>
      {state.kind === 'sending' && (
        <p role="status" className="text-sm text-muted-foreground">
          {sent >= state.input.file.size
            ? `Saving ${state.input.file.name}…`
            : `Uploading ${state.input.file.name}: ${formatFileSize(sent)} of ${formatFileSize(state.input.file.size)}`}
        </p>
      )}
      {uploaded && state.kind === 'accepted' && (
        <p role="status" className="text-sm">
          Uploaded and attached {uploaded}. Save the row to keep it.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {state.kind === 'rejected' && (
        <Alert variant="destructive">
          <AlertDescription>The file was not uploaded. {state.message}</AlertDescription>
        </Alert>
      )}
      {state.kind === 'uncertain' && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>
              We couldn’t confirm the upload of {state.input.file.name}. Retrying sends the same file without creating a
              copy.
            </AlertDescription>
          </Alert>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => void upload.submit(state.input)}>
            Retry upload
          </Button>
        </div>
      )}
    </div>
  );
}

function RelationshipInput({
  field,
  value,
  disabled,
  change,
  api,
  workspace,
}: {
  field: Extract<TableField, { kind: 'relationship' }>;
  value: TableValue | undefined;
  disabled: boolean;
  change: (value: TableValue) => void;
  api: TableApi;
  workspace: TableWorkspace;
}) {
  const [after, setAfter] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query.trim());
  const selected = value?.kind === 'relationship' ? value.recordIds : [];
  const linked = useLinkedRows(api, value?.kind === 'relationship' ? [{ [field.id]: value }] : []);
  const target = useTableDetail(api, field.targetTableId);
  const searchable =
    target.state.kind === 'ready' && !!target.state.data.applied?.definition.fields.some(item => item.kind === 'text');
  const read = useTableRelationship(api, field.targetTableId, after, searchable && search ? search : undefined);
  const locked = disabled || read.state.kind !== 'ready' || !!read.state.error || read.state.refreshing;
  const select = (recordIds: string[]) =>
    change(recordIds.length ? { kind: 'relationship', tableId: field.targetTableId, recordIds } : null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {field.cardinality === 'one' ? 'Choose one row.' : 'Choose linked rows.'} Incoming links block deletion.
      </p>
      {selected.length > 0 && (
        <ul aria-label={`Rows linked from ${field.label}`} className="space-y-1">
          {selected.map((id, index) => {
            const label = linkedLabel(linked.state, id);
            const known = linked.state.kind === 'ready' && id in linked.state.data;
            return (
              <li key={id} className="flex flex-wrap items-center gap-2">
                {known ? (
                  <span className="min-w-0 break-all text-sm underline">
                    <Link
                      to="/$workspaceSlug/tables/$tableId"
                      params={{ workspaceSlug: workspace.slug, tableId: field.targetTableId }}
                      search={{ row: id }}
                    >
                      {label}
                    </Link>
                  </span>
                ) : (
                  <span className="min-w-0 break-all text-sm text-muted-foreground">{label}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={known ? `Remove link to ${label}` : `Remove linked row ${index + 1} from ${field.label}`}
                  onClick={() => select(selected.filter(item => item !== id))}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ReferenceRetry linked={linked} disabled={disabled} />
      {searchable && (
        <SearchField
          id={`record-field-${field.id}-search`}
          label={`Search rows for ${field.label}`}
          placeholder="Search rows"
          value={query}
          maxLength={255}
          onChange={next => {
            setQuery(next);
            setAfter(undefined);
          }}
        />
      )}
      <TableRead state={read.state} refresh={read.refresh}>
        {({ target, records, nextCursor }) => (
          <div className="space-y-2">
            {records.length === 0 &&
              (search && searchable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm">No rows match “{search}”.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => {
                      setQuery('');
                      setAfter(undefined);
                    }}
                  >
                    Clear search
                  </Button>
                </div>
              ) : (
                <p className="text-sm">
                  {after ? 'No rows on this page.' : `${target.definition.label} has no rows you can read yet.`}
                </p>
              ))}
            {field.cardinality === 'one' ? (
              <Select value={selected[0] ?? ''} disabled={locked} onValueChange={id => select(id ? [id] : [])}>
                <SelectTrigger width="full" aria-label={`Choose ${field.label.toLowerCase()}`}>
                  <SelectValue>{selected[0] ? linkedLabel(linked.state, selected[0]) : 'Choose a row'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Not set</SelectItem>
                  {selected[0] && !records.some(record => record.id === selected[0]) && (
                    <SelectItem value={selected[0]}>{linkedLabel(linked.state, selected[0])}</SelectItem>
                  )}
                  {records.map((record, index) => {
                    const label = rowLabel(target.definition, record.values, target.systemKind);
                    const repeated = records.some(
                      other =>
                        other.id !== record.id &&
                        rowLabel(target.definition, other.values, target.systemKind) === label,
                    );
                    return (
                      <SelectItem key={record.id} value={record.id}>
                        {label}
                        {repeated ? ` (row ${index + 1} on this page)` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : (
              records.map((record, index) => {
                const label = rowLabel(target.definition, record.values, target.systemKind);
                const repeated = records.some(
                  other =>
                    other.id !== record.id && rowLabel(target.definition, other.values, target.systemKind) === label,
                );
                const control = `link-${field.id}-${record.id}`;
                return (
                  <div key={record.id} className="flex items-start gap-2">
                    <Checkbox
                      id={control}
                      aria-describedby={repeated ? `${control}-position` : undefined}
                      disabled={locked}
                      checked={selected.includes(record.id)}
                      onCheckedChange={checked => {
                        select(checked ? [...selected, record.id] : selected.filter(id => id !== record.id));
                      }}
                    />
                    <Label htmlFor={control}>{label}</Label>
                    {repeated && (
                      <span id={`${control}-position`} className="text-xs text-muted-foreground">
                        Row {index + 1} on this page
                      </span>
                    )}
                  </div>
                );
              })
            )}
            {(after || nextCursor) && (
              <div className="flex gap-2">
                <Button variant="outline" disabled={locked || !after} onClick={() => setAfter(undefined)}>
                  First rows
                </Button>
                <Button
                  variant="outline"
                  disabled={locked || !nextCursor}
                  onClick={() => setAfter(nextCursor ?? undefined)}
                >
                  Next rows
                </Button>
              </div>
            )}
          </div>
        )}
      </TableRead>
      {after && read.state.kind === 'error' && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => setAfter(undefined)}>
          First rows
        </Button>
      )}
    </div>
  );
}
