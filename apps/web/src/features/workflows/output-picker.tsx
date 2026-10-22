import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import {
  outputAt,
  outputChoices,
  sampledOutputChoices,
  stepOutputShapes,
  type Definition,
  type OutputShape,
  type OutputTable,
} from '@tulipfarm/workflows/contracts';
import { tableApi } from '@/features/tables/api';
import { useTablePicker } from '@/features/tables/hooks';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { fieldPath } from './definition-edits';
import type { useWorkflowRuns } from './queries';

type Reference = Exclude<Extract<Definition['steps'][number], { kind: 'wait-until' }>['at'], { kind: 'literal' }>;
type History = ReturnType<typeof useWorkflowRuns>;
type OutputContext = {
  shapes: Map<string, OutputShape>;
  revision: string | null;
  runs: Parameters<typeof sampledOutputChoices>[3];
  hintsReady: boolean;
};
const Outputs = createContext<OutputContext | null>(null);
type ProviderProps = {
  workspaceId: string;
  steps: Definition['steps'];
  revision: string | null;
  history: History;
  children: ReactNode;
};

function OutputData({
  steps,
  revision,
  history,
  tables,
  children,
}: Omit<ProviderProps, 'workspaceId'> & { tables: readonly OutputTable[] }) {
  const shapes = useMemo(() => stepOutputShapes(steps, tables), [steps, tables]);
  const runs = history.state.kind === 'ready' ? history.state.data.runs : [];
  const hintsReady = revision === null || history.state.kind === 'ready';
  const value = useMemo(() => ({ shapes, revision, runs, hintsReady }), [shapes, revision, runs, hintsReady]);
  const failed = history.state.kind === 'error' || (history.state.kind === 'ready' && !!history.state.error);
  return (
    <Outputs value={value}>
      {revision && history.state.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading run hints. Known fields and manual paths are ready.
        </p>
      )}
      {revision && failed && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>Run hints could not be loaded. Keep editing, or retry the read.</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            disabled={history.state.kind === 'ready' && history.state.refreshing}
            onClick={() => void history.refresh()}
          >
            Retry run hints
          </Button>
        </div>
      )}
      {children}
    </Outputs>
  );
}

function TableOutputs({ workspaceId, steps, revision, history, children }: ProviderProps) {
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const read = useTablePicker(api);
  const tables = useMemo(
    () =>
      read.state.kind === 'ready'
        ? read.state.data.map(table => ({ id: table.id, fields: table.definition.fields }))
        : [],
    [read.state],
  );
  const failed = read.state.kind === 'error' || (read.state.kind === 'ready' && !!read.state.error);
  return (
    <>
      {read.state.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading table fields. Other output fields and manual paths are ready.
        </p>
      )}
      {failed && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>Table fields could not be loaded. Your paths are kept.</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            disabled={read.state.kind === 'ready' && read.state.refreshing}
            onClick={() => void read.refresh()}
          >
            Retry output table fields
          </Button>
        </div>
      )}
      {read.state.kind === 'unavailable' && (
        <p className="text-sm text-muted-foreground">
          Table fields are unavailable. Ask a workspace admin to check your table access.
        </p>
      )}
      {read.state.kind === 'ready' && !tables.length && (
        <p className="text-sm text-muted-foreground">
          No readable tables. Use another output source, or ask a workspace admin for table access.
        </p>
      )}
      <OutputData steps={steps} revision={revision} history={history} tables={tables}>
        {children}
      </OutputData>
    </>
  );
}

const noTables: readonly OutputTable[] = [];
export function WorkflowOutputs({ workspaceId, steps, revision, history, children }: ProviderProps) {
  return steps.some(step => step.kind === 'find-rows') ? (
    <TableOutputs workspaceId={workspaceId} steps={steps} revision={revision} history={history}>
      {children}
    </TableOutputs>
  ) : (
    <OutputData steps={steps} revision={revision} history={history} tables={noTables}>
      {children}
    </OutputData>
  );
}

export function OutputPathControl({
  id,
  value,
  earlier,
  label = `Value path for ${id}`,
  disabled = false,
  onChange,
}: {
  id: string;
  value: Reference;
  earlier: Definition['steps'];
  label?: string;
  disabled?: boolean;
  onChange: (value: Reference) => void;
}) {
  const data = useContext(Outputs);
  const controlId = useId();
  const [text, setText] = useState<string | null>(null);
  const shape = value.kind === 'step' ? (data?.shapes ?? stepOutputShapes(earlier)).get(value.step) : undefined;
  const choices = shape
    ? [
        ...outputChoices(shape),
        ...sampledOutputChoices(
          shape,
          value.kind === 'step' ? value.step : '',
          data?.revision ?? null,
          data?.runs ?? [],
        ),
      ]
    : [];
  const chosen = choices.find(choice => JSON.stringify(choice.path) === JSON.stringify(value.path));
  const invalid = shape && !outputAt(shape, value.path);
  const shown = value.path.some(part => part.includes('/') || part !== part.trim() || !part)
    ? JSON.stringify(value.path)
    : value.path.join(' / ');
  return (
    <div className="min-w-0 flex-1 basis-full space-y-2 sm:basis-0">
      {value.kind === 'step' && shape && (
        <Field id={`output-picker-${controlId}`} label={`Available fields for ${id}`} optional disabled={disabled}>
          <Select
            value={chosen ? JSON.stringify(chosen.path) : ''}
            onValueChange={encoded => {
              const choice = choices.find(choice => JSON.stringify(choice.path) === encoded);
              if (choice) {
                setText(null);
                onChange({ ...value, path: choice.path });
              }
            }}
          >
            <SelectTrigger>
              <SelectValue>{chosen?.label ?? 'Choose an output field'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {choices.map(choice => (
                <SelectItem key={JSON.stringify(choice.path)} value={JSON.stringify(choice.path)}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field
        id={`output-path-${controlId}`}
        label={label}
        optional
        disabled={disabled}
        error={
          invalid
            ? `Step "${value.kind === 'step' ? value.step : ''}" has no field ${JSON.stringify(value.path)}. Choose an available field.`
            : undefined
        }
        helper="Separate nested fields with /. A blank path uses the whole output. Use a JSON string array for names containing /."
      >
        <Input
          value={text ?? shown}
          onFocus={() => setText(shown)}
          onBlur={() => setText(null)}
          onChange={event => {
            setText(event.target.value);
            onChange({ ...value, path: fieldPath(event.target.value) });
          }}
        />
      </Field>
      {value.kind === 'step' && shape?.kind === 'unknown' && (
        <p className="text-sm text-muted-foreground">
          {choices.some(choice => choice.hint)
            ? 'Run hints are examples, not guaranteed fields. You can enter a different path.'
            : data && !data.hintsReady
              ? 'This output can change. Enter a path while run hints are unavailable.'
              : 'No known fields or matching run hints. Enter a path, or use the whole output.'}
        </p>
      )}
      {value.kind === 'step' && shape?.kind === 'scalar' && (
        <p className="text-sm text-muted-foreground">This step has no nested fields. Use the whole output.</p>
      )}
    </div>
  );
}
