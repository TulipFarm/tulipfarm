import { useEffect, useState } from 'react';
import { completionStatuses, evalLimits, type EvalCaseInput, type EvalCheck } from '@tulipfarm/evals/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { formatCredits } from '@/features/chat/subagent-fanout-state';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { familyPlan } from '@/features/models/chatgpt-plan-api';
import { modelName } from '@/features/models/model-name';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { TableRequestError } from '@/features/tables/request-state';
import {
  useEvalRun,
  useEvalRuns,
  useEvalSet,
  useEvalsApi,
  type EvalCaseView,
  type EvalEstimate,
  type EvalRun,
  type EvalRunDetail,
  type EvalsApi,
  type EvalSet,
} from './evals-api';
import { describeCheck, statusLabels, toolLabel } from './eval-labels';

type CheckKind = EvalCheck['kind'];
const checkKinds: readonly { value: CheckKind; label: string }[] = [
  { value: 'tool-called', label: 'Calls a tool' },
  { value: 'tool-not-called', label: 'Does not call a tool' },
  { value: 'approval-requested', label: 'Asks for approval' },
  { value: 'status', label: 'Ends with a status' },
  { value: 'text-contains', label: 'Reply contains text' },
  { value: 'text-excludes', label: 'Reply does not contain text' },
  { value: 'judge', label: 'AI judge' },
];
const runStatus: Record<EvalRun['status'], { label: string; variant: 'secondary' | 'info' | 'success' | 'warning' }> = {
  queued: { label: 'Queued', variant: 'secondary' },
  running: { label: 'Running', variant: 'info' },
  completed: { label: 'Finished', variant: 'success' },
  failed: { label: 'Failed', variant: 'warning' },
  stopped: { label: 'Stopped', variant: 'secondary' },
};
const stopReasons: Partial<Record<string, string>> = {
  'agent-changed': 'The agent was saved again before this run started. Run again to test the new version.',
  credits: 'The workspace ran out of credits. Results so far are kept.',
  'estimate-used': 'The run used its estimated credits and stopped. Results so far are kept.',
  cap: 'The run reached its request limit and stopped. Results so far are kept.',
  cancelled: 'Someone stopped this run. Results so far are kept.',
  interrupted: 'The run stopped unexpectedly. Run again.',
};
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const errorText = (error: unknown) =>
  error instanceof TableRequestError ? error.message : 'Evals could not be updated. Your input is retained. Try again.';

/** The Evals tab: an agent's eval cases, its runs, and the AI judge model. */
export function AgentEvals({
  workspaceId,
  agentId,
  tools,
  enabled,
  onUseModel,
}: {
  workspaceId: string;
  agentId: string;
  tools: readonly string[];
  enabled: boolean;
  onUseModel: (modelFamilyId: string) => void;
}) {
  const api = useEvalsApi(workspaceId, agentId);
  const set = useEvalSet(api, agentId, enabled);
  const runs = useEvalRuns(api, agentId, enabled);
  const catalog = useModelCatalog(workspaceId);
  const families = catalog.state.kind === 'ready' ? catalog.state.data.families : undefined;
  const name = (id: string) => modelName(families, id);
  const [editing, setEditing] = useState<EvalCaseView | 'new' | null>(null);
  const [running, setRunning] = useState<{ models?: string[]; repeats?: 1 | 3 } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const refresh = () => {
    void set.refresh();
    void runs.refresh();
  };
  if (set.state.kind === 'loading')
    return <StatePanel kind="loading" title="Loading evals" description="Finding this agent's eval cases." />;
  if (set.state.kind !== 'ready')
    return (
      <StatePanel kind="error" title="Evals could not load" description="The agent is unaffected.">
        <Button variant="outline" onClick={refresh}>
          Retry
        </Button>
      </StatePanel>
    );
  const data = set.state.data;
  const runList = runs.state.kind === 'ready' ? runs.state.data : [];
  const activeRun = runList.find(run => run.status === 'queued' || run.status === 'running');
  return (
    <div className="grid gap-6">
      <EvalCases
        api={api}
        data={data}
        onAdd={() => setEditing('new')}
        onEdit={setEditing}
        onRun={() => setRunning({})}
        runBlocked={activeRun ? 'An eval run is in progress.' : null}
        refresh={refresh}
      />
      <FormSection
        title="Runs"
        label="Eval runs"
        description={`Results of the last ${evalLimits.runsKept} runs. Runs never change workspace data: writes and messages are simulated.`}
      >
        {runs.state.kind === 'loading' && <p className="text-sm text-muted-foreground">Loading runs…</p>}
        {(runs.state.kind === 'error' || runs.state.kind === 'unavailable') && (
          <Alert variant="destructive">
            <AlertDescription>Runs could not load. Retry in a moment.</AlertDescription>
          </Alert>
        )}
        {runs.state.kind === 'ready' && !runList.length && (
          <p className="text-sm text-muted-foreground">No runs yet. Add an eval case, then run it.</p>
        )}
        {runList.length > 0 && (
          <ul aria-label="Eval runs" className="divide-y divide-border rounded-xl border border-border bg-card">
            {runList.map(run => (
              <RunRow
                key={run.id}
                run={run}
                name={name}
                canEdit={data.canEdit}
                onView={() => setViewing(run.id)}
                onRunAgain={() => setRunning({ models: run.models, repeats: run.repeats === 3 ? 3 : 1 })}
                onStop={async () => {
                  await api.cancel(run.id).catch(() => undefined);
                  void runs.refresh();
                }}
              />
            ))}
          </ul>
        )}
      </FormSection>
      <JudgeSetting api={api} data={data} name={name} families={families} refresh={refresh} />
      {editing && (
        <CaseEditor
          api={api}
          tools={tools}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {running && (
        <RunDialog
          api={api}
          cases={data.cases}
          families={families}
          name={name}
          initial={running}
          onClose={() => setRunning(null)}
          onStarted={run => {
            setRunning(null);
            void runs.refresh();
            setViewing(run.id);
          }}
        />
      )}
      {viewing && (
        <RunDetailDialog
          api={api}
          agentId={agentId}
          runId={viewing}
          cases={data.cases}
          canEdit={data.canEdit}
          name={name}
          onClose={() => setViewing(null)}
          onUseModel={model => {
            setViewing(null);
            onUseModel(model);
          }}
          onRunAgain={run => {
            setViewing(null);
            setRunning({ models: run.models, repeats: run.repeats === 3 ? 3 : 1 });
          }}
        />
      )}
    </div>
  );
}

function EvalCases({
  api,
  data,
  onAdd,
  onEdit,
  onRun,
  runBlocked,
  refresh,
}: {
  api: EvalsApi;
  data: EvalSet;
  onAdd: () => void;
  onEdit: (value: EvalCaseView) => void;
  onRun: () => void;
  runBlocked: string | null;
  refresh: () => void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = data.cases.length >= data.limits.casesPerSet;
  return (
    <FormSection
      title="Eval cases"
      label="Eval cases"
      meta={`${data.cases.length} / ${data.limits.casesPerSet}`}
      description="Each case sends one message to this agent and checks what it does."
    >
      {data.canEdit ? (
        <div className="flex flex-wrap items-start gap-2">
          <Button
            variant="outline"
            onClick={onAdd}
            state={full ? { kind: 'blocked', reason: 'Delete a case before adding another.' } : { kind: 'ready' }}
          >
            Add case
          </Button>
          <Button
            onClick={onRun}
            state={
              !data.cases.length
                ? { kind: 'blocked', reason: 'Add an eval case before running.' }
                : runBlocked
                  ? { kind: 'blocked', reason: runBlocked }
                  : { kind: 'ready' }
            }
          >
            Run evals
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only people who can edit this agent can change or run its evals.
        </p>
      )}
      {!data.cases.length && (
        <p className="text-sm text-muted-foreground">
          No eval cases yet. A case is a message, such as a request your team often sends, and the checks its reply must
          pass.
        </p>
      )}
      {data.cases.length > 0 && (
        <ul aria-label="Eval cases" className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.cases.map(item => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="grid min-w-0 flex-1 gap-1 text-sm">
                <span className="font-medium text-foreground">{item.name}</span>
                <span className="truncate text-muted-foreground">{item.message}</span>
                <span className="text-muted-foreground">
                  {item.checks.length} check{item.checks.length === 1 ? '' : 's'}
                  {item.priorTurns.length ? `, ${item.priorTurns.length} earlier turns` : ''}
                  {item.pinnedReads.length ? `, ${item.pinnedReads.length} pinned results` : ''}
                </span>
              </div>
              {data.canEdit && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => onEdit(item)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${item.name}`}
                    state={deleting === item.id ? { kind: 'busy' } : { kind: 'ready' }}
                    onClick={async () => {
                      setDeleting(item.id);
                      setError(null);
                      try {
                        await api.deleteCase(item.id);
                        refresh();
                      } catch (failure) {
                        setError(errorText(failure));
                      } finally {
                        setDeleting(null);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormSection>
  );
}

function passRate(run: EvalRun) {
  const passed = run.summary.reduce((sum, item) => sum + item.passed, 0);
  const total = run.summary.reduce((sum, item) => sum + item.total, 0);
  return total ? `${passed}/${total} passed` : null;
}

function RunRow({
  run,
  name,
  canEdit,
  onView,
  onRunAgain,
  onStop,
}: {
  run: EvalRun;
  name: (id: string) => string;
  canEdit: boolean;
  onView: () => void;
  onRunAgain: () => void;
  onStop: () => Promise<void>;
}) {
  const status = runStatus[run.status];
  const active = run.status === 'queued' || run.status === 'running';
  const rate = passRate(run);
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="grid min-w-0 flex-1 gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{dateFormat.format(new Date(run.createdAt))}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
          {run.agentChanged && <Badge variant="warning">Agent changed since this run</Badge>}
        </div>
        <span className="text-muted-foreground">
          {run.models.map(name).join(', ')} · {run.caseCount} case{run.caseCount === 1 ? '' : 's'} × {run.repeats}
          {rate ? ` · ${rate}` : ''} · {formatCredits(run.agentCredits + run.judgeCredits)}
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onView}>
          View results
        </Button>
        {canEdit && active && (
          <Button variant="ghost" size="sm" onClick={() => void onStop()}>
            Stop
          </Button>
        )}
        {canEdit && !active && run.agentChanged && (
          <Button variant="ghost" size="sm" onClick={onRunAgain}>
            Run again
          </Button>
        )}
      </div>
    </li>
  );
}

function JudgeSetting({
  api,
  data,
  name,
  families,
  refresh,
}: {
  api: EvalsApi;
  data: EvalSet;
  name: (id: string) => string;
  families: readonly ModelCatalogFamily[] | undefined;
  refresh: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = (families ?? []).filter(family => family.available && !familyPlan(family));
  const fallback = data.defaultJudgeModel ? `Default (${name(data.defaultJudgeModel)})` : 'Default';
  return (
    <FormSection
      title="AI judge"
      label="AI judge model"
      description="The model that grades AI judge checks. Its verdict is a model's opinion, so each result shows its reasoning."
    >
      <Field label="Judge model" optional disabled={!data.canEdit || saving}>
        <Select
          value={data.judgeModel ?? ''}
          onValueChange={async next => {
            setSaving(true);
            setError(null);
            try {
              await api.setJudge(next || null);
              refresh();
            } catch (failure) {
              setError(errorText(failure));
            } finally {
              setSaving(false);
            }
          }}
        >
          <SelectTrigger width="full">
            <SelectValue>{data.judgeModel ? name(data.judgeModel) : fallback}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{fallback}</SelectItem>
            {options.map(family => (
              <SelectItem key={family.id} value={family.id}>
                {family.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormSection>
  );
}

type DraftCheck = { kind: CheckKind; tool: string; args: string; status: string; text: string; rubric: string };
type DraftPin = { tool: string; result: string };
const blankCheck = (): DraftCheck => ({
  kind: 'judge',
  tool: '',
  args: '',
  status: 'completed',
  text: '',
  rubric: '',
});
function draftCheck(check: EvalCheck): DraftCheck {
  const draft = blankCheck();
  draft.kind = check.kind;
  if ('tool' in check) draft.tool = check.tool;
  if (check.kind === 'tool-called' && check.args) draft.args = JSON.stringify(check.args, null, 2);
  if (check.kind === 'status') draft.status = check.status;
  if ('text' in check) draft.text = check.text;
  if (check.kind === 'judge') draft.rubric = check.rubric;
  return draft;
}
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function buildCheck(draft: DraftCheck): EvalCheck | string {
  switch (draft.kind) {
    case 'tool-called': {
      if (!draft.tool) return 'Choose a tool.';
      if (!draft.args.trim()) return { kind: 'tool-called', tool: draft.tool };
      const args = parseJson(draft.args);
      if (!args.ok || typeof args.value !== 'object' || args.value === null || Array.isArray(args.value))
        return 'Arguments must be a JSON object, such as {"table": "Customers"}.';
      return { kind: 'tool-called', tool: draft.tool, args: args.value as Record<string, never> };
    }
    case 'tool-not-called':
      return draft.tool ? { kind: 'tool-not-called', tool: draft.tool } : 'Choose a tool.';
    case 'approval-requested':
      return { kind: 'approval-requested' };
    case 'status':
      return { kind: 'status', status: draft.status as (typeof completionStatuses)[number] };
    case 'text-contains':
    case 'text-excludes':
      return draft.text.trim() ? { kind: draft.kind, text: draft.text } : 'Enter the text to look for.';
    case 'judge':
      return draft.rubric.trim()
        ? { kind: 'judge', rubric: draft.rubric }
        : 'Describe what a good reply does, such as "Names the overdue invoices".';
  }
}

function CaseEditor({
  api,
  tools,
  initial,
  onClose,
  onSaved,
}: {
  api: EvalsApi;
  tools: readonly string[];
  initial: (Partial<EvalCaseInput> & { id?: string }) | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [message, setMessage] = useState(initial?.message ?? '');
  const [turns, setTurns] = useState(initial?.priorTurns ?? []);
  const [checks, setChecks] = useState<DraftCheck[]>(initial?.checks?.map(draftCheck) ?? [blankCheck()]);
  const [pins, setPins] = useState<DraftPin[]>(
    (initial?.pinnedReads ?? []).map(pin => ({ tool: pin.tool, result: JSON.stringify(pin.result, null, 2) })),
  );
  const [overrides, setOverrides] = useState<DraftPin[]>(
    (initial?.effectOverrides ?? []).map(pin => ({ tool: pin.tool, result: JSON.stringify(pin.result, null, 2) })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toolOptions = [...new Set([...tools, ...checks.map(check => check.tool).filter(Boolean)])];
  const toolSelect = (value: string, onChange: (tool: string) => void, label: string) => (
    <Field label={label} required>
      <Select value={value} onValueChange={next => onChange(next ?? '')}>
        <SelectTrigger width="full">
          <SelectValue>{value ? toolLabel(value) : 'Choose a tool'}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {toolOptions.map(tool => (
            <SelectItem key={tool} value={tool}>
              {toolLabel(tool)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  const pinRows = (
    title: string,
    helper: string,
    rows: DraftPin[],
    setRows: (rows: DraftPin[]) => void,
    prefix: string,
  ) => (
    <section aria-label={title} className="grid gap-3">
      <div className="grid gap-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{helper}</p>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-border p-3">
          {toolSelect(
            row.tool,
            tool => setRows(rows.map((item, at) => (at === index ? { ...item, tool } : item))),
            'Tool',
          )}
          <Field label="Result (JSON)" required error={errors[`${prefix}${index}`]}>
            <Textarea
              rows={4}
              value={row.result}
              onChange={event =>
                setRows(rows.map((item, at) => (at === index ? { ...item, result: event.target.value } : item)))
              }
            />
          </Field>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, at) => at !== index))}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length >= evalLimits.pinsPerCase}
          onClick={() => setRows([...rows, { tool: tools[0] ?? '', result: '{}' }])}
        >
          Add result
        </Button>
      </div>
    </section>
  );
  async function save() {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Enter a name.';
    if (!message.trim()) found.message = 'Enter the message to send.';
    const built = checks.map((check, index) => {
      const value = buildCheck(check);
      if (typeof value === 'string') found[`check${index}`] = value;
      return value;
    });
    const pinsOf = (rows: DraftPin[], prefix: string) =>
      rows.flatMap((row, index) => {
        const result = parseJson(row.result);
        if (!row.tool) found[`${prefix}${index}`] = 'Choose a tool.';
        else if (!result.ok) found[`${prefix}${index}`] = 'The result must be valid JSON.';
        return result.ok && row.tool ? [{ tool: row.tool, result: result.value as never }] : [];
      });
    const pinnedReads = pinsOf(pins, 'pin');
    const effectOverrides = pinsOf(overrides, 'override');
    setErrors(found);
    if (Object.keys(found).length) return;
    const input: EvalCaseInput = {
      name,
      message,
      priorTurns: turns.filter(turn => turn.text.trim()),
      checks: built as EvalCheck[],
      pinnedReads,
      effectOverrides,
    };
    setSaving(true);
    setFailure(null);
    try {
      if (initial?.id) await api.updateCase(initial.id, input);
      else await api.createCase(input);
      onSaved();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{initial?.id ? 'Edit eval case' : 'New eval case'}</DialogTitle>
          <DialogDescription>
            The message is sent to the agent as if a person wrote it. Writes and messages are simulated, so nothing in
            your workspace changes.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
            <Field label="Name" required error={errors.name}>
              <Input value={name} maxLength={120} onChange={event => setName(event.target.value)} />
            </Field>
            <section aria-label="Earlier turns" className="grid gap-3">
              <div className="grid gap-1">
                <h3 className="text-sm font-medium text-foreground">Earlier turns</h3>
                <p className="text-sm text-muted-foreground">Optional conversation that comes before the message.</p>
              </div>
              {turns.map((turn, index) => (
                <div key={index} className="grid gap-2 rounded-lg border border-border p-3">
                  <Field label="From" required>
                    <Select
                      value={turn.role}
                      onValueChange={next =>
                        setTurns(
                          turns.map((item, at) =>
                            at === index ? { ...item, role: next === 'assistant' ? 'assistant' : 'user' } : item,
                          ),
                        )
                      }
                    >
                      <SelectTrigger width="full">
                        <SelectValue>{turn.role === 'user' ? 'Person' : 'Agent'}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">Person</SelectItem>
                        <SelectItem value="assistant">Agent</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Text" required>
                    <Textarea
                      rows={3}
                      value={turn.text}
                      maxLength={8000}
                      onChange={event =>
                        setTurns(turns.map((item, at) => (at === index ? { ...item, text: event.target.value } : item)))
                      }
                    />
                  </Field>
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setTurns(turns.filter((_, at) => at !== index))}>
                      Remove turn
                    </Button>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={turns.length >= evalLimits.priorTurns}
                  onClick={() =>
                    setTurns([...turns, { role: turns.at(-1)?.role === 'user' ? 'assistant' : 'user', text: '' }])
                  }
                >
                  Add earlier turn
                </Button>
              </div>
            </section>
            <Field label="Message" required error={errors.message}>
              <Textarea rows={4} value={message} maxLength={8000} onChange={event => setMessage(event.target.value)} />
            </Field>
            <section aria-label="Checks" className="grid gap-3">
              <div className="grid gap-1">
                <h3 className="text-sm font-medium text-foreground">Checks</h3>
                <p className="text-sm text-muted-foreground">
                  The case passes when every check passes. Add up to {evalLimits.checksPerCase}.
                </p>
              </div>
              {checks.map((check, index) => {
                const set = (change: Partial<DraftCheck>) =>
                  setChecks(checks.map((item, at) => (at === index ? { ...item, ...change } : item)));
                return (
                  <div key={index} className="grid gap-2 rounded-lg border border-border p-3">
                    <Field label={`Check ${index + 1}`} required error={errors[`check${index}`]}>
                      <Select value={check.kind} onValueChange={next => next && set({ kind: next as CheckKind })}>
                        <SelectTrigger width="full">
                          <SelectValue>{checkKinds.find(kind => kind.value === check.kind)?.label}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {checkKinds.map(kind => (
                            <SelectItem key={kind.value} value={kind.value}>
                              {kind.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {(check.kind === 'tool-called' || check.kind === 'tool-not-called') &&
                      toolSelect(check.tool, tool => set({ tool }), 'Tool')}
                    {check.kind === 'tool-called' && (
                      <Field label="With arguments (JSON)" optional helper="Leave empty to accept any arguments.">
                        <Textarea rows={3} value={check.args} onChange={event => set({ args: event.target.value })} />
                      </Field>
                    )}
                    {check.kind === 'status' && (
                      <Field label="Status" required>
                        <Select value={check.status} onValueChange={next => next && set({ status: next })}>
                          <SelectTrigger width="full">
                            <SelectValue>
                              {statusLabels[check.status as keyof typeof statusLabels] ?? check.status}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {completionStatuses.map(status => (
                              <SelectItem key={status} value={status}>
                                {statusLabels[status]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                    {(check.kind === 'text-contains' || check.kind === 'text-excludes') && (
                      <Field label="Text" required>
                        <Input
                          value={check.text}
                          maxLength={500}
                          onChange={event => set({ text: event.target.value })}
                        />
                      </Field>
                    )}
                    {check.kind === 'judge' && (
                      <Field label="Rubric" required helper="Describe in plain words what a good reply does.">
                        <Textarea
                          rows={3}
                          value={check.rubric}
                          maxLength={2000}
                          onChange={event => set({ rubric: event.target.value })}
                        />
                      </Field>
                    )}
                    {checks.length > 1 && (
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setChecks(checks.filter((_, at) => at !== index))}
                        >
                          Remove check
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={checks.length >= evalLimits.checksPerCase}
                  onClick={() => setChecks([...checks, blankCheck()])}
                >
                  Add check
                </Button>
              </div>
            </section>
            {pinRows(
              'Pinned read results',
              'Reads use live workspace data unless you pin a result, so the case keeps passing when data changes.',
              pins,
              setPins,
              'pin',
            )}
            {pinRows(
              'Simulated write results',
              'Writes always succeed in a run. Set a result to test how the agent handles something else, such as an error.',
              overrides,
              setOverrides,
              'override',
            )}
            {failure && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{failure}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button state={saving ? { kind: 'busy' } : { kind: 'ready' }} onClick={() => void save()}>
            Save case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Opens the case editor prefilled from a chat, for "Save as eval". */
export function SaveEvalDialog({
  workspaceId,
  agentId,
  tools,
  message,
  priorTurns,
  onClose,
}: {
  workspaceId: string;
  agentId: string;
  tools: readonly string[];
  message: string;
  priorTurns: EvalCaseInput['priorTurns'];
  onClose: () => void;
}) {
  const api = useEvalsApi(workspaceId, agentId);
  const [saved, setSaved] = useState(false);
  if (saved)
    return (
      <Dialog
        open
        onOpenChange={next => {
          if (!next) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eval case saved</DialogTitle>
            <DialogDescription>
              Everyone who can use this agent can see it. Run it from the agent&apos;s Evals tab.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <CaseEditor
      api={api}
      tools={tools}
      initial={{
        name: message.slice(0, 60).trim(),
        message,
        priorTurns: priorTurns?.slice(-evalLimits.priorTurns),
        checks: [{ kind: 'judge', rubric: '' }] as never,
      }}
      onClose={onClose}
      onSaved={() => setSaved(true)}
    />
  );
}

function RunDialog({
  api,
  cases,
  families,
  name,
  initial,
  onClose,
  onStarted,
}: {
  api: EvalsApi;
  cases: readonly EvalCaseView[];
  families: readonly ModelCatalogFamily[] | undefined;
  name: (id: string) => string;
  initial: { models?: string[]; repeats?: 1 | 3 };
  onClose: () => void;
  onStarted: (run: EvalRun) => void;
}) {
  const [selected, setSelected] = useState<string[]>(cases.map(item => item.id));
  const [repeats, setRepeats] = useState<'1' | '3'>(initial.repeats === 3 ? '3' : '1');
  const [models, setModels] = useState<string[]>(initial.models ?? []);
  const [estimate, setEstimate] = useState<EvalEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const options = (families ?? []).filter(family => family.available && !familyPlan(family));
  const request = {
    ...(selected.length === cases.length ? {} : { caseIds: selected }),
    repeats: Number(repeats) as 1 | 3,
    ...(models.length ? { models } : {}),
  };
  const key = JSON.stringify(request);
  useEffect(() => {
    setEstimate(null);
    setError(null);
    if (!selected.length) return;
    let current = true;
    api
      .estimate(JSON.parse(key))
      .then(value => current && setEstimate(value))
      .catch(failure => current && setError(errorText(failure)));
    return () => {
      current = false;
    };
  }, [api, key, selected.length]);
  const tooMany = models.length > evalLimits.modelsCompared;
  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>Run evals</DialogTitle>
          <DialogDescription>
            Runs use workspace credits. Reads use your access, limited by the agent&apos;s permissions. Writes and
            messages are simulated.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
            <ChoiceGroup
              type="checkbox"
              legend="Cases"
              required
              options={cases.map(item => ({ value: item.id, label: item.name }))}
              value={selected}
              onValueChange={setSelected}
              error={selected.length ? undefined : 'Choose at least one case.'}
            />
            <ChoiceGroup
              type="radio"
              legend="Repeats"
              required
              helper="Models can answer differently each time. Three repeats show how often each case passes."
              options={[
                { value: '1', label: 'Once' },
                { value: '3', label: 'Three times' },
              ]}
              value={repeats}
              onValueChange={setRepeats}
            />
            <ChoiceGroup
              type="checkbox"
              legend="Models"
              optional
              helper={`Leave empty to use the agent's own model. Choose up to ${evalLimits.modelsCompared} to compare.`}
              options={options.map(family => ({
                value: family.id,
                label: family.displayName,
                disabled: !models.includes(family.id) && models.length >= evalLimits.modelsCompared,
              }))}
              value={models}
              onValueChange={setModels}
              error={tooMany ? `Choose at most ${evalLimits.modelsCompared} models.` : undefined}
            />
            <p role="status" className="text-sm text-muted-foreground">
              {estimate
                ? `${estimate.replies} agent repl${estimate.replies === 1 ? 'y' : 'ies'} on ${estimate.models.map(name).join(', ')}, graded by ${name(estimate.judgeModel)}. Estimated cost: about ${formatCredits(estimate.credits)}.`
                : selected.length && !error
                  ? 'Estimating credits…'
                  : ''}
            </p>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            state={
              starting
                ? { kind: 'busy' }
                : !estimate || tooMany
                  ? { kind: 'blocked', reason: 'Wait for the estimate.' }
                  : { kind: 'ready' }
            }
            onClick={async () => {
              setStarting(true);
              setError(null);
              try {
                onStarted(await api.start(request));
              } catch (failure) {
                setError(errorText(failure));
              } finally {
                setStarting(false);
              }
            }}
          >
            {estimate ? `Run for about ${formatCredits(estimate.credits)}` : 'Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const modeLabels = { live: 'Live data', pinned: 'Pinned result', simulated: 'Simulated' } as const;

function RunDetailDialog({
  api,
  agentId,
  runId,
  cases,
  canEdit,
  name,
  onClose,
  onUseModel,
  onRunAgain,
}: {
  api: EvalsApi;
  agentId: string;
  runId: string;
  cases: readonly EvalCaseView[];
  canEdit: boolean;
  name: (id: string) => string;
  onClose: () => void;
  onUseModel: (model: string) => void;
  onRunAgain: (run: EvalRunDetail) => void;
}) {
  const read = useEvalRun(api, agentId, runId);
  const run = read.state.kind === 'ready' ? read.state.data : null;
  const comparing = (run?.models.length ?? 0) > 1;
  const groups = run
    ? [...new Set(run.results.map(result => result.caseId))].map(caseId => {
        const results = run.results.filter(result => result.caseId === caseId);
        return {
          caseId,
          name: results[0]?.caseName ?? cases.find(item => item.id === caseId)?.name ?? 'Deleted case',
          byModel: run.models.map(model => ({ model, results: results.filter(result => result.model === model) })),
        };
      })
    : [];
  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="split">
        <DialogHeader>
          <DialogTitle>Eval results</DialogTitle>
          <DialogDescription>
            {run
              ? `${dateFormat.format(new Date(run.createdAt))} · ${runStatus[run.status].label}`
              : 'Loading results…'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
            {(read.state.kind === 'error' || read.state.kind === 'unavailable') && (
              <Alert variant="destructive">
                <AlertDescription>Results could not load. Retry in a moment.</AlertDescription>
              </Alert>
            )}
            {run && (
              <>
                {run.agentChanged && (
                  <Alert>
                    <AlertDescription>
                      Agent changed since this run. These results tested an earlier version of its instructions, skills,
                      tools or model.
                    </AlertDescription>
                  </Alert>
                )}
                {run.stopReason && run.status !== 'completed' && (
                  <Alert variant="destructive">
                    <AlertDescription>{stopReasons[run.stopReason] ?? 'The run stopped early.'}</AlertDescription>
                  </Alert>
                )}
                {(run.status === 'queued' || run.status === 'running') && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {run.status === 'queued' ? 'Waiting to start…' : `Running… ${run.results.length} replies so far.`}
                  </p>
                )}
                <dl className="grid gap-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Agent usage</dt>
                    <dd className="text-foreground">{formatCredits(run.agentCredits)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">AI judge usage ({name(run.judgeModel)})</dt>
                    <dd className="text-foreground">{formatCredits(run.judgeCredits)}</dd>
                  </div>
                </dl>
                {run.summary.length > 0 && (
                  <ul aria-label="Models" className="divide-y divide-border rounded-xl border border-border bg-card">
                    {run.summary.map(item => (
                      <li key={item.model} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <span className="min-w-0 flex-1 font-medium text-foreground">{name(item.model)}</span>
                        <span className="text-foreground">
                          {item.passed}/{item.total} passed
                        </span>
                        <span className="text-muted-foreground">{formatCredits(item.credits)}</span>
                        <span className="text-muted-foreground">{Math.round(item.durationMs / 1000)}s</span>
                        {canEdit && comparing && (
                          <Button variant="outline" size="sm" onClick={() => onUseModel(item.model)}>
                            Use this model
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {groups.map(group => (
                  <section key={group.caseId} aria-label={group.name} className="grid gap-2">
                    <h3 className="text-sm font-medium text-foreground">{group.name}</h3>
                    {group.byModel
                      .filter(item => item.results.length)
                      .map(({ model, results }) => {
                        const passed = results.filter(result => result.pass).length;
                        return (
                          <div key={model} className="grid gap-2 rounded-lg border border-border p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              {comparing && <span className="text-muted-foreground">{name(model)}</span>}
                              <Badge
                                variant={passed === results.length ? 'success' : passed ? 'warning' : 'destructive'}
                              >
                                {results.length > 1
                                  ? `${passed}/${results.length} passed`
                                  : passed
                                    ? 'Passed'
                                    : 'Failed'}
                              </Badge>
                            </div>
                            {results.map(result => (
                              <div key={result.repeat} className="grid gap-2">
                                {results.length > 1 && (
                                  <span className="text-muted-foreground">Attempt {result.repeat + 1}</span>
                                )}
                                {result.error && <p className="text-destructive">{result.error}</p>}
                                <ul className="grid gap-1">
                                  {result.verdicts.map((verdict, index) => (
                                    <li key={index} className="grid gap-0.5">
                                      <span className={verdict.pass ? 'text-foreground' : 'text-destructive'}>
                                        {verdict.pass ? '✓' : '✗'} {describeCheck(verdict.check)}
                                      </span>
                                      {verdict.reason && (
                                        <span className="text-muted-foreground">{verdict.reason}</span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                                {result.transcript && (
                                  <Collapsible>
                                    <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                                      Reply and tool calls
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                      <div className="rounded-md bg-muted/40 p-2">
                                        <p className="whitespace-pre-wrap text-foreground">
                                          {result.transcript.text || 'No reply text.'}
                                        </p>
                                        {result.transcript.calls.length > 0 && (
                                          <ul className="mt-2 grid gap-1">
                                            {result.transcript.calls.map((call, index) => (
                                              <li key={index} className="flex flex-wrap items-center gap-2">
                                                <span className="text-foreground">{toolLabel(call.tool)}</span>
                                                <Badge variant="outline">{modeLabels[call.mode]}</Badge>
                                                {call.approval && <Badge variant="info">Approval requested</Badge>}
                                              </li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    </CollapsibleContent>
                                  </Collapsible>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                  </section>
                ))}
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {run && canEdit && run.status !== 'queued' && run.status !== 'running' && (
            <Button variant="outline" onClick={() => onRunAgain(run)}>
              Run again
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
