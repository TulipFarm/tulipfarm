import { useState } from 'react';
import { CodeIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import type { z } from 'zod';
import { stepValues, workflowSchema, type Definition } from '@tulipfarm/workflows/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { workflowRequest, WorkflowRequestError } from './api';
import { codeLanguageOrder, codeLanguages, type CodeLanguage } from './code-languages';
import { describeValue } from './definition-description';
import {
  addCodeStep,
  codeSourceBytes,
  codeStepId,
  maxCodeSource,
  maxSteps,
  removeCodeStep,
  replaceCodeStep,
} from './code-step-edits';

type Workflow = z.infer<typeof workflowSchema>;
type Step = Definition['steps'][number];
type CodeStep = Extract<Step, { kind: 'code' }>;
type Draft = { originalId: string | null; id: string; language: CodeLanguage; source: string; input: string };

const idPattern = /^[a-z][a-z0-9_]{0,47}$/;

/** Adds, edits and removes a workflow's code steps by saving a new revision, like the trigger list does. */
export function CodeSteps({
  workspaceId,
  workflow,
  blocked,
  onSaved,
  onDenied,
}: {
  workspaceId: string;
  workflow: Workflow;
  blocked: boolean;
  onSaved: (workflow: Workflow, action: 'saved' | 'removed') => void;
  onDenied: () => void;
}) {
  const steps = workflow.definition.steps;
  const codeSteps = steps.flatMap((step, index) => (step.kind === 'code' ? [{ step, index }] : []));
  const editable = workflow.capabilities.manage && !workflow.archivedAt && workflow.codeStepsAvailable;
  const [draft, setDraft] = useState<Draft | null>(null),
    [removing, setRemoving] = useState<CodeStep | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null),
    [removeFailure, setRemoveFailure] = useState<string | null>(null);
  if (!editable && !codeSteps.length) return null;
  const full = steps.length >= maxSteps;
  const locked = blocked || busy;
  const readers = (id: string) => steps.filter(step => stepValues(step).some(v => v.kind === 'step' && v.step === id));

  async function save(definition: Definition, action: 'saved' | 'removed') {
    const result = await workflowRequest(`/workspaces/${workspaceId}/workflows/${workflow.id}`, 'PUT', {
      revision: crypto.randomUUID(),
      expectedRevision: workflow.revision,
      definition,
    });
    onSaved(workflowSchema.parse(result), action);
  }
  async function submit() {
    if (!draft || draftProblem(draft, steps)) return;
    setBusy(true);
    setFailure(null);
    try {
      const step: CodeStep = {
        id: draft.id,
        kind: 'code',
        language: draft.language,
        source: draft.source,
        input: inputValue(draft, steps),
      };
      await save(
        {
          ...workflow.definition,
          steps: draft.originalId ? replaceCodeStep(steps, draft.originalId, step) : addCodeStep(steps, step),
        },
        'saved',
      );
      setDraft(null);
    } catch (error) {
      if (error instanceof WorkflowRequestError && [401, 403, 404].includes(error.status)) return onDenied();
      setFailure(saveFailure(error, 'saved'));
    } finally {
      setBusy(false);
    }
  }
  async function remove(step: CodeStep) {
    setBusy(true);
    setRemoveFailure(null);
    try {
      await save({ ...workflow.definition, steps: removeCodeStep(steps, step.id) }, 'removed');
      setRemoving(null);
    } catch (error) {
      if (error instanceof WorkflowRequestError && [401, 403, 404].includes(error.status)) return onDenied();
      setRemoveFailure(saveFailure(error, 'removed'));
    } finally {
      setBusy(false);
    }
  }
  const startAdding = (language: CodeLanguage) => {
    setFailure(null);
    setDraft({
      originalId: null,
      id: codeStepId(steps.map(step => step.id)),
      language,
      source: codeLanguages[language].starter,
      input: steps.length ? `step:${steps.at(-1)!.id}` : 'run',
    });
  };
  const edit = (next: Draft) => {
    setDraft(next);
    setFailure(null);
  };
  const problem = draft ? draftProblem(draft, steps) : null;

  return (
    <section aria-labelledby="workflow-code-steps" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="workflow-code-steps" className="me-auto font-medium">
          Code steps
        </h2>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  state={
                    full
                      ? { kind: 'blocked', reason: `A workflow can have up to ${maxSteps} steps.` }
                      : locked
                        ? { kind: 'blocked', reason: 'Wait for the current request to finish.' }
                        : { kind: 'ready' }
                  }
                />
              }
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add code step
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {codeLanguageOrder.map(language => (
                  <DropdownMenuItem key={language} onClick={() => startAdding(language)}>
                    {codeLanguages[language].name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!codeSteps.length ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          No code steps yet. Add one to run JavaScript, TypeScript, Python or Bash.
        </p>
      ) : (
        <ol className="space-y-2">
          {codeSteps.map(({ step, index }) => {
            const usedBy = readers(step.id);
            const only = steps.length === 1;
            return (
              <li
                key={step.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
              >
                <CodeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-medium break-words">
                    Step {index + 1}: {step.id}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {codeLanguages[step.language].name} ·{' '}
                    {step.input.kind === 'literal' && step.input.value === null
                      ? 'no input'
                      : `reads ${describeValue(step.input)}`}
                  </p>
                </div>
                {editable && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${step.id}`}
                      disabled={locked}
                      onClick={() => {
                        setFailure(null);
                        setDraft({
                          originalId: step.id,
                          id: step.id,
                          language: step.language,
                          source: step.source,
                          input: inputChoice(step.input),
                        });
                      }}
                    >
                      <PencilIcon aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${step.id}`}
                      state={
                        only
                          ? { kind: 'blocked', reason: 'A workflow needs at least one step.' }
                          : usedBy.length
                            ? {
                                kind: 'blocked',
                                reason:
                                  usedBy.length > 1
                                    ? `Steps ${list(usedBy.map(reader => reader.id))} read this step’s output. Update them in chat before removing this step.`
                                    : `Step ${usedBy[0]!.id} reads this step’s output. Update it in chat before removing this step.`,
                              }
                            : locked
                              ? { kind: 'blocked', reason: 'Wait for the current request to finish.' }
                              : { kind: 'ready' }
                      }
                      onClick={() => {
                        setRemoveFailure(null);
                        setRemoving(step);
                      }}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <AlertDialog open={removing !== null} onOpenChange={next => !next && !busy && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Remove {removing?.id ?? 'code step'}?</AlertDialogTitle>
          <AlertDialogDescription>
            This saves a new revision without {removing?.id}. Runs keep using {removing?.id} until you activate that
            revision.
          </AlertDialogDescription>
          {removeFailure && (
            <Alert variant="destructive">
              <AlertDescription>{removeFailure}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep step</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              aria-busy={busy}
              onClick={event => {
                event.preventDefault();
                if (removing) void remove(removing);
              }}
            >
              {busy ? 'Removing…' : 'Remove step'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={draft !== null} onOpenChange={next => !next && !busy && setDraft(null)}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{draft?.originalId ? `Edit ${draft.originalId}` : 'Add a code step'}</DialogTitle>
            <DialogDescription>
              Each run uses a fresh sandbox with public internet access and no secrets. The step stops after 20 seconds.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="flex min-h-0 flex-col gap-4"
              onSubmit={event => {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }}
            >
              <DialogBody>
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="code-step-id">Step ID</Label>
                      <Input
                        id="code-step-id"
                        value={draft.id}
                        disabled={busy || draft.originalId !== null}
                        aria-invalid={problem?.field === 'id' || undefined}
                        aria-describedby="code-step-id-hint"
                        onChange={event => edit({ ...draft, id: event.target.value })}
                      />
                      <p id="code-step-id-hint" className="text-xs text-muted-foreground">
                        {draft.originalId
                          ? 'Later steps use this ID, so it can’t change.'
                          : 'Start with a lowercase letter, then use a–z, 0–9 or _. Later steps use this ID, so you can’t change it.'}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="code-step-language">Language</Label>
                      <Select
                        value={draft.language}
                        disabled={busy}
                        onValueChange={value => {
                          if (!value || !(value in codeLanguages)) return;
                          const language = value as CodeLanguage;
                          const untouched = draft.source === codeLanguages[draft.language].starter;
                          edit({
                            ...draft,
                            language,
                            source: untouched ? codeLanguages[language].starter : draft.source,
                          });
                        }}
                      >
                        <SelectTrigger id="code-step-language">
                          <SelectValue>{codeLanguages[draft.language].name}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {codeLanguageOrder.map(language => (
                            <SelectItem key={language} value={language}>
                              {codeLanguages[language].name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="code-step-input">Input</Label>
                    <Select
                      value={draft.input}
                      disabled={busy}
                      onValueChange={value => value && edit({ ...draft, input: value })}
                    >
                      <SelectTrigger id="code-step-input">
                        <SelectValue>{inputLabel(draft.input, steps)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {inputChoices(draft, steps).map(choice => (
                          <SelectItem key={choice} value={choice}>
                            {inputLabel(choice, steps)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="code-step-source">Code</Label>
                    <div className="font-mono">
                      <Textarea
                        id="code-step-source"
                        rows={14}
                        spellCheck={false}
                        value={draft.source}
                        disabled={busy}
                        aria-invalid={problem?.field === 'source' || undefined}
                        aria-describedby="code-step-source-hint"
                        onChange={event => edit({ ...draft, source: event.target.value })}
                      />
                    </div>
                    <p id="code-step-source-hint" className="text-xs text-muted-foreground">
                      {draft.language === 'bash' ? (
                        <>
                          Read the input JSON from <code>$INPUT</code>. What you print is the step’s output, parsed as
                          JSON if valid.
                        </>
                      ) : (
                        <>
                          Read <code>input</code> and return a JSON value. That value is the step’s output.
                        </>
                      )}{' '}
                      {codeSourceBytes(draft.source).toLocaleString()} of {maxCodeSource.toLocaleString()} bytes used.
                    </p>
                  </div>
                </div>
              </DialogBody>
              {(problem || failure) && (
                <Alert variant="destructive">
                  <AlertDescription>{failure ?? problem?.message}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || problem !== null} aria-busy={busy}>
                  {busy ? 'Saving…' : draft.originalId ? 'Save step' : 'Add step'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Earlier steps a code step may read: everything before it, or every step when it is added at the end. */
function earlierSteps(draft: Draft, steps: readonly Step[]) {
  const index = draft.originalId ? steps.findIndex(step => step.id === draft.originalId) : steps.length;
  return steps.slice(0, index);
}
function inputChoices(draft: Draft, steps: readonly Step[]) {
  const choices = ['run', ...earlierSteps(draft, steps).map(step => `step:${step.id}`), 'none'];
  return draft.input.startsWith('keep:') ? [draft.input, ...choices] : choices;
}
function inputChoice(value: CodeStep['input']) {
  if (value.kind === 'input' && !value.path.length) return 'run';
  if (value.kind === 'step' && !value.path.length) return `step:${value.step}`;
  if (value.kind === 'literal' && value.value === null) return 'none';
  return `keep:${JSON.stringify(value)}`;
}
function inputValue(draft: Draft, steps: readonly Step[]): CodeStep['input'] {
  if (draft.input === 'run') return { kind: 'input', path: [] };
  if (draft.input.startsWith('step:')) return { kind: 'step', step: draft.input.slice(5), path: [] };
  if (draft.input.startsWith('keep:')) {
    const original = steps.find(step => step.id === draft.originalId);
    if (original?.kind === 'code') return original.input;
  }
  return { kind: 'literal', value: null };
}
function inputLabel(choice: string, steps: readonly Step[]) {
  if (choice === 'run') return 'The run’s input';
  if (choice === 'none') return 'No input';
  if (choice.startsWith('step:')) {
    const id = choice.slice(5);
    const index = steps.findIndex(step => step.id === id);
    return `Output of step ${index + 1}: ${id}`;
  }
  return `Current input: ${describeValue(JSON.parse(choice.slice(5)) as CodeStep['input'])}`;
}
function draftProblem(draft: Draft, steps: readonly Step[]): { field: 'id' | 'source'; message: string } | null {
  if (!draft.originalId) {
    if (!idPattern.test(draft.id))
      return {
        field: 'id',
        message: 'Start the ID with a lowercase letter. Use only a–z, 0–9 and _, up to 48 characters.',
      };
    if (steps.some(step => step.id === draft.id))
      return { field: 'id', message: 'Another step already uses this ID. Choose another.' };
  }
  if (!draft.source.trim()) return { field: 'source', message: 'Write some code for this step to run.' };
  if (codeSourceBytes(draft.source) > maxCodeSource)
    return { field: 'source', message: `Code can be up to ${maxCodeSource.toLocaleString()} bytes. Shorten it.` };
  return null;
}
function saveFailure(error: unknown, action: 'saved' | 'removed') {
  const verb = action === 'saved' ? 'saved' : 'removed';
  if (!(error instanceof WorkflowRequestError) || error.status >= 500)
    return `The step may not have been ${verb}. Refresh workflows before trying again.`;
  switch (error.code) {
    case 'code-steps-unavailable':
      return 'Code steps aren’t available on this server yet.';
    case 'stale-revision':
    case 'revision-conflict':
      return 'This workflow changed. Refresh workflows and make your change again.';
    default:
      return error.issues[0]
        ? `The step couldn’t be ${verb}: ${error.issues[0]}`
        : `The step couldn’t be ${verb}. ${action === 'saved' ? 'Check it and try again.' : 'Try again.'}`;
  }
}
function list(parts: string[]) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join('');
}
