import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { githubApi } from '@/lib/github';
import { useIntegrationChanges, useGitHubInvestigation } from '@/features/integrations/queries';
import { useFeatureContext } from '@/lib/query/provider';
import { GitHubAccountCard } from './github-account-card';

type CardProps = {
  workspaceId: string;
  chatId: string;
  slug: string;
  disabled: boolean;
  picked: (name: string) => void;
  task?: boolean;
};

export function GitHubTaskSourceCard({
  requested = false,
  ...props
}: Omit<CardProps, 'task'> & { requested?: boolean }) {
  const read = useGitHubInvestigation(props.workspaceId, props.chatId, true);
  return read.state.kind === 'ready' && !read.state.error && !read.state.data.investigation && !requested ? (
    <GitHubAccountCard
      workspaceId={props.workspaceId}
      chatId={props.chatId}
      slug={props.slug}
      disabled={props.disabled}
      picked={props.picked}
      task
    />
  ) : (
    <GitHubInvestigationCard
      workspaceId={props.workspaceId}
      chatId={props.chatId}
      slug={props.slug}
      disabled={props.disabled}
      picked={props.picked}
      task
    />
  );
}

export function GitHubInvestigationCard({ workspaceId, chatId, slug, disabled, picked, task = false }: CardProps) {
  const read = useGitHubInvestigation(workspaceId, chatId, task);
  const changes = useIntegrationChanges();
  const { runtime, scope, current } = useFeatureContext();
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = read.state;
  async function save(end = false) {
    if (state.kind !== 'ready' || state.error || disabled || busy.current) return;
    const selected = state.data.choices.find(item => `${item.kind}:${item.id}` === choice);
    if (!end && !selected) {
      setError('Choose a GitHub source.');
      return;
    }
    const admitted = runtime.fence(scope, current);
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await githubApi.selectInvestigation(workspaceId, chatId, task, {
        investigation: !end,
        expectedVersion: state.data.version,
        choice: selected && !end ? { kind: selected.kind, id: selected.id, generation: selected.generation } : null,
      });
      await changes.selection(chatId, task);
      if (mounted.current && admitted()) {
        setChoice('');
        if (!end) picked(selected!.name);
      }
    } catch {
      if (mounted.current && admitted())
        setError(
          'The choice is unconfirmed. Check sources before trying again. Finish or pause current work before changing the source.',
        );
      await read.refresh();
    } finally {
      busy.current = false;
      if (mounted.current && admitted()) setSaving(false);
    }
  }
  const retry = (
    <Button variant="outline" disabled={saving} onClick={() => void read.refresh()}>
      Check GitHub sources
    </Button>
  );
  if (state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading GitHub investigation sources">
        <Skeleton />
        <span className="sr-only">Loading GitHub sources…</span>
      </div>
    );
  if (state.kind === 'unavailable')
    return (
      <StatePanel
        kind="unavailable"
        title="Investigation access unavailable"
        description="This private chat or task is no longer available to your current membership."
      >
        {retry}
      </StatePanel>
    );
  if (state.kind === 'error')
    return (
      <StatePanel
        kind="error"
        title="Could not load GitHub sources"
        description="The source list is unknown. Your chat or task stays available."
      >
        {retry}
      </StatePanel>
    );
  const selected = state.data.selected;
  const pendingChoice = state.data.choices.find(item => `${item.kind}:${item.id}` === choice);
  return (
    <section aria-label="GitHub investigation" className="space-y-3 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">GitHub investigation</h3>
        <p className="text-sm text-muted-foreground">
          Read related repositories with one source. Findings stay in this private {task ? 'task' : 'chat'}. Changing
          the source starts fresh context.
        </p>
      </div>
      {selected && (
        <p role="status" className="text-sm">
          {selected.kind === 'personal' ? 'Personal account' : 'Team integration'}:{' '}
          <span className="font-medium">{selected.name}</span> · Read-only
        </p>
      )}
      {state.data.investigation && !selected && (
        <p role="status" className="text-sm">
          Choose an available source to continue. No other account will be used.
        </p>
      )}
      {state.error && (
        <div>
          <p role="alert">GitHub sources could not be refreshed. Check access before making a change.</p>
          {retry}
        </div>
      )}
      {error && state.data.choices.length === 0 && (
        <div>
          <p role="alert">{error}</p>
          {retry}
        </div>
      )}
      {state.data.choices.length === 0 ? (
        <StatePanel
          kind="empty"
          title="No GitHub source available"
          description="Connect a personal account, or ask a team integration manager for integration use and repository read permissions."
        />
      ) : (
        <Form
          label="Choose investigation source"
          disabled={saving || disabled || !!state.error}
          onSubmit={() => {
            if (!pendingChoice) {
              setError('Choose a GitHub source.');
              return 'invalid';
            }
            void save();
          }}
        >
          <Field id={`investigation-source-${chatId}`} label="GitHub source" required error={error}>
            <Select
              value={choice}
              onValueChange={value => {
                setChoice(value ?? '');
                setError(undefined);
              }}
            >
              <SelectTrigger width="full">
                <SelectValue placeholder="Choose a source">
                  {pendingChoice
                    ? `${pendingChoice.kind === 'personal' ? 'Personal' : 'Team'} · ${pendingChoice.name}`
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {state.data.choices.map(item => (
                  <SelectItem key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                    {item.kind === 'personal' ? 'Personal' : 'Team'} · {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FormFooter
            layout="compact"
            dirty={choice !== ''}
            error={error}
            submit={{
              label: selected ? 'Change investigation source' : 'Use for investigation',
              pendingLabel: 'Saving source…',
              state: saving
                ? { kind: 'busy' }
                : disabled
                  ? {
                      kind: 'blocked',
                      reason: task
                        ? 'Pause this task before changing its source.'
                        : 'Finish or cancel the pending reply before choosing a source.',
                    }
                  : state.error
                    ? { kind: 'blocked', reason: 'Check GitHub sources before choosing.' }
                    : { kind: 'ready' },
            }}
          />
        </Form>
      )}
      {state.data.investigation && (
        <Button variant="outline" disabled={saving || disabled || !!state.error} onClick={() => void save(true)}>
          End investigation and clear context
        </Button>
      )}
      <Button
        variant="link"
        nativeButton={false}
        render={
          <Link
            to="/$workspaceSlug/integrations"
            params={{ workspaceSlug: slug }}
            target="_blank"
            rel="noopener noreferrer"
          />
        }
      >
        Manage GitHub integrations
      </Button>
    </section>
  );
}
