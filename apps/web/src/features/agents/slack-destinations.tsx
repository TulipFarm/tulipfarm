import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ActionButton, ActionGroup, type ActionState } from '@/components/action-button';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadError } from '@/components/read-feedback';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { useAgentSlackApi, useAgentSlackDestinations, type Destination, type DestinationInput } from './slack-queries';
import type { AgentContext } from './api';
import { destinationErrors, fixSummary } from './administration';

const blank = { teamId: '', name: '', channel: '' };

export function SlackDestinations({
  workspaceId,
  slug,
  teams,
  administration,
  addLimit,
}: {
  workspaceId: string;
  slug: string;
  teams: AgentContext['teams'];
  administration: ActionState;
  addLimit: (id: string, permissions: Destination['permissions']) => void;
}) {
  const api = useAgentSlackApi(workspaceId);
  const read = useAgentSlackDestinations(api);
  const [draft, setDraft] = useState(blank);
  const [checked, setChecked] = useState(false);
  const write = useTableWrite(
    async (change: { kind: 'add' | 'update'; input: DestinationInput }) => {
      await api.saveDestination(change.input);
      return change.kind;
    },
    kind => {
      if (kind === 'add') {
        setDraft(blank);
        setChecked(false);
      }
    },
  );
  const update = (change: Partial<typeof blank>) => setDraft(current => ({ ...current, ...change }));
  const available: ActionState =
    administration.kind === 'busy' || write.state.kind === 'sending'
      ? { kind: 'busy' }
      : administration.kind === 'blocked'
        ? administration
        : write.state.kind === 'uncertain'
          ? { kind: 'blocked', reason: 'Check whether the last change went through first.' }
          : { kind: 'ready' };
  const withTeam: ActionState =
    available.kind !== 'ready' || draft.teamId
      ? available
      : {
          kind: 'blocked',
          reason: 'Choose a destination team below first.',
          fix: { kind: 'jump', label: 'Choose a team', target: 'slack-destination-team' },
        };
  const errors = destinationErrors(draft);
  const adding = write.state.kind === 'sending' && write.state.input.kind === 'add';
  function add(): 'invalid' | undefined {
    if (fixSummary(errors, 'add the destination')) {
      setChecked(true);
      return 'invalid';
    }
    setChecked(false);
    void write.submit({
      kind: 'add',
      input: {
        id: crypto.randomUUID(),
        channel: draft.channel,
        name: draft.name.trim(),
        teamId: draft.teamId,
        expectedVersion: 0,
        enabled: true,
      },
    });
  }
  const revoke = (item: Destination) =>
    void write.submit({
      kind: 'update',
      input: {
        id: item.id,
        channel: item.channel,
        name: item.name,
        expectedVersion: item.version,
        teamId: draft.teamId,
        enabled: false,
      },
    });
  const body = useRef<HTMLDivElement>(null);
  const reload = () => void read.refresh();
  const retry = () => {
    body.current?.focus();
    reload();
  };
  const state = read.state;
  return (
    <FormSection
      id="agent-slack-destinations"
      title="Slack destinations"
      description="Channels this agent may post to directly."
    >
      <div ref={body} tabIndex={-1} className="grid min-w-0 gap-4">
        {state.kind === 'loading' ? (
          <div role="status" aria-label="Loading Slack destinations" className="grid gap-3">
            <Skeleton shape="panel" aria-hidden="true" />
            <Skeleton shape="panel" aria-hidden="true" />
            <span className="sr-only">Loading Slack destinations…</span>
          </div>
        ) : state.kind === 'unavailable' ? (
          <StatePanel
            kind="unavailable"
            heading="h3"
            title="Slack destinations unavailable"
            description="Slack isn’t connected to this workspace, or your access to its Slack settings changed. A workspace admin can connect Slack in Integrations. Your other agent settings still work."
          >
            <Button
              nativeButton={false}
              role="link"
              render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />}
            >
              Open Integrations
            </Button>
            <Button variant="ghost" onClick={retry}>
              Check Slack access again
            </Button>
          </StatePanel>
        ) : state.kind === 'error' ? (
          <StatePanel
            kind="error"
            heading="h3"
            title="Couldn’t load Slack destinations"
            description="Slack settings didn’t respond. Your other agent settings still work."
          >
            <Button onClick={retry}>Reload Slack destinations</Button>
          </StatePanel>
        ) : (
          <>
            {state.error && (
              <ReadError message="We couldn’t refresh Slack destinations. Showing the last loaded list." />
            )}
            {state.data.destinations.length ? (
              <ul className="grid gap-3">
                {state.data.destinations.map(item => (
                  <li key={item.id} className="grid gap-3 rounded-lg border p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-sm font-medium text-foreground">{item.name}</p>
                      <p className="break-all text-sm text-muted-foreground">{item.channel}</p>
                    </div>
                    <div className="grid gap-3">
                      <ActionButton
                        state={available}
                        variant="outline"
                        onClick={() => addLimit(item.id, item.permissions)}
                      >{`Add ${item.name} to execution limits`}</ActionButton>
                      <ActionGroup
                        state={withTeam}
                        actions={[{ label: 'Revoke destination', variant: 'outline', onClick: () => revoke(item) }]}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No Slack destinations"
                description="Add a channel below. The bot and your linked account must already belong to it."
              />
            )}
            <ActionButton
              state={state.refreshing ? { kind: 'busy' } : { kind: 'ready' }}
              variant="outline"
              pendingLabel="Reloading Slack destinations…"
              onClick={reload}
            >
              Reload Slack destinations
            </ActionButton>
            <Form disabled={available.kind !== 'ready'} onSubmit={add}>
              <div className="grid gap-5">
                <Field
                  id="slack-destination-team"
                  label="Destination team"
                  required
                  helper="Saving replaces the channel's earlier team."
                  error={checked ? errors.team : undefined}
                >
                  <Select value={draft.teamId} onValueChange={value => update({ teamId: value ?? '' })}>
                    <SelectTrigger>
                      <SelectValue>{teams.find(team => team.id === draft.teamId)?.name ?? 'Choose a team'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {teams.map(team => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    id="slack-destination-name"
                    label="Destination name"
                    required
                    error={checked ? errors.name : undefined}
                  >
                    <Input
                      value={draft.name}
                      maxLength={120}
                      onChange={event => update({ name: event.target.value })}
                    />
                  </Field>
                  <Field
                    id="slack-destination-channel"
                    label="Channel ID"
                    required
                    helper="Starts with C or G; copy it from the channel details in Slack."
                    error={checked ? errors.channel : undefined}
                  >
                    <Input value={draft.channel} onChange={event => update({ channel: event.target.value.trim() })} />
                  </Field>
                </div>
                <FormFooter
                  dirty={!!(draft.teamId || draft.name || draft.channel)}
                  error={checked ? fixSummary(errors, 'add the destination') : undefined}
                  submit={{
                    label: 'Add Slack destination',
                    pendingLabel: adding ? 'Adding Slack destination…' : 'Add Slack destination',
                    state: available,
                  }}
                >
                  <WriteFeedback
                    state={write.state}
                    checkStatus={() => {
                      write.reset();
                      void read.refresh();
                    }}
                    retry={change => void write.submit(change)}
                  />
                </FormFooter>
              </div>
            </Form>
          </>
        )}
      </div>
    </FormSection>
  );
}
