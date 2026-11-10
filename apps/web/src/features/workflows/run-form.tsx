import { useEffect, useState } from 'react';
import type { Definition } from '@tulipfarm/workflows/contracts';
import { Button, jumpTo } from '@tulipfarm/sprout/button';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Label } from '@tulipfarm/sprout/label';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { useWorkflowDefinition } from './queries';
import { runInputExample, runInputFields } from './run-input';
import { WorkflowRead } from './workflow-detail';

export function WorkflowRunForm({
  workspaceId,
  workflowId,
  revision,
  blocked,
  enabled,
  onRun,
  onClose,
}: {
  workspaceId: string;
  workflowId: string;
  revision: string;
  blocked: boolean;
  enabled: boolean;
  onRun: (input: unknown) => void;
  onClose: () => void;
}) {
  const read = useWorkflowDefinition(workspaceId, workflowId, revision);
  return (
    <WorkflowRead state={read.state} refresh={read.refresh}>
      {(detail, notice) => (
        <>
          <RunForm
            key={detail.revision}
            definition={detail.definition}
            blocked={blocked || !!notice}
            enabled={enabled}
            onRun={onRun}
            onClose={onClose}
            notice={notice}
          />
          {notice && (
            <Button variant="outline" disabled={blocked} onClick={() => void read.refresh()}>
              Retry loading run input
            </Button>
          )}
        </>
      )}
    </WorkflowRead>
  );
}

function RunForm({
  definition,
  blocked,
  enabled,
  onRun,
  onClose,
  notice,
}: {
  definition: Definition;
  blocked: boolean;
  enabled: boolean;
  onRun: (input: unknown) => void;
  onClose: () => void;
  notice: string | undefined;
}) {
  const fields = runInputFields(definition);
  const [values, setValues] = useState<Record<string, unknown>>(() => runInputExample(definition));
  const [json, setJson] = useState(() => JSON.stringify(runInputExample(definition), null, 2));
  const [advanced, setAdvanced] = useState(!fields);
  const [error, setError] = useState('');
  useEffect(() => {
    jumpTo('run-input');
  }, []);
  const toggle = () => {
    setError('');
    if (!advanced) {
      setJson(JSON.stringify(values, null, 2));
      setAdvanced(true);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !fields?.every(key => typeof Reflect.get(parsed, key) === 'string')
      ) {
        setError('Use a JSON object with text values for the shown fields, or keep using JSON input.');
        return;
      }
      setValues(parsed as Record<string, unknown>);
      setAdvanced(false);
    } catch {
      setError('Enter valid JSON input.');
    }
  };
  return (
    <fieldset className="min-w-0">
      <form
        aria-label="Run workflow"
        className="space-y-3 rounded-xl border border-border bg-card p-4"
        onSubmit={event => {
          event.preventDefault();
          setError('');
          if (blocked || !enabled) return;
          try {
            onRun(advanced ? JSON.parse(json) : values);
          } catch {
            setError('Enter valid JSON input.');
          }
        }}
      >
        <h2 className="font-medium">Run manually</h2>
        {notice && <p role="alert">{notice}</p>}
        {advanced ? (
          <div className="space-y-2">
            <Label htmlFor="run-input">Input JSON</Label>
            <Textarea id="run-input" value={json} disabled={blocked} onChange={event => setJson(event.target.value)} />
            {!fields && (
              <p className="text-sm text-muted-foreground">
                This workflow needs JSON input. Fill in the values its steps use.
              </p>
            )}
          </div>
        ) : (
          fields?.map((field, index) => (
            <div key={field} className="space-y-2">
              <Label htmlFor={index ? `run-input-${index}` : 'run-input'}>{field}</Label>
              <Textarea
                id={index ? `run-input-${index}` : 'run-input'}
                value={String(values[field] ?? '')}
                disabled={blocked}
                onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))}
              />
            </div>
          ))
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {fields && (
            <Button type="button" variant="ghost" disabled={blocked} onClick={toggle}>
              {advanced ? 'Use fields' : 'Advanced JSON input'}
            </Button>
          )}
          <Button type="submit" disabled={blocked || !enabled}>
            Run workflow
          </Button>
          <Button type="button" variant="ghost" disabled={blocked} onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Runs continue after you leave. A response resumes the run right away.
        </p>
      </form>
    </fieldset>
  );
}
