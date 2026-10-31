import { useEffect, useMemo } from 'react';
import type { Definition } from '@tulipfarm/workflows/contracts';
import { slackDestinationViewSchema } from '@tulipfarm/slack/action-contracts';
import { Label } from '@tulipfarm/sprout/label';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { agentApi } from '@/features/agents/api';
import { SlackAction } from '@/features/agents/slack-action';
import { useAgentSlackApi, useAgentSlackDestinations } from '@/features/agents/slack-queries';
import { useFeatureRead } from '@/lib/query';
import { slackSenderLabel } from '@/features/agents/administration';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import { workspaceRoute } from '@/router';
import { ValueControl } from './table-step-controls';

type SlackStep = Extract<Definition['steps'][number], { kind: 'slack-message' }>;

export function SlackStepControls({
  step,
  earlier,
  disabled,
  onChange,
  onValidityChange,
}: {
  step: SlackStep;
  earlier: Definition['steps'];
  disabled: boolean;
  onChange: (step: SlackStep) => void;
  onValidityChange: (ready: boolean) => void;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useAgentSlackApi(workspace.id);
  const read = useAgentSlackDestinations(api);
  const destinations =
    read.state.kind === 'ready'
      ? read.state.data.destinations.filter(item => item.permissions.includes('slack.message.send'))
      : [];
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <Label htmlFor={`slack-destination-${step.id}`}>Slack destination</Label>
      <Select
        value={step.destinationId}
        disabled={read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error}
        onValueChange={destinationId => {
          if (destinationId) onChange({ ...step, destinationId });
        }}
      >
        <SelectTrigger id={`slack-destination-${step.id}`}>
          <SelectValue>
            {destinations.find(item => item.id === step.destinationId)?.name ?? 'Choose a Slack destination'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {destinations.map(item => (
            <SelectItem key={item.id} value={item.id}>
              {item.name} · {item.channel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {read.state.kind === 'loading' ? (
        <p role="status">Loading Slack destinations…</p>
      ) : read.state.kind === 'error' || read.state.kind === 'unavailable' || read.state.error ? (
        <StatePanel
          kind="unavailable"
          title="Slack destinations unavailable"
          description="Your destination and message are retained. Check your Slack integration and channel access."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Reload Slack destinations
          </Button>
        </StatePanel>
      ) : destinations.length === 0 ? (
        <p>No authorized destinations. Resolve a channel with Slack lookup in chat, then reload this list.</p>
      ) : null}
      <WorkflowSlackDestinationLabel
        workspaceId={workspace.id}
        id={step.destinationId}
        onReady={(_id, ready) => onValidityChange(ready)}
      />
      <Button variant="ghost" onClick={() => void read.refresh()}>
        Refresh Slack destinations
      </Button>
      <>
        <Label htmlFor={`slack-sender-${step.id}`}>Post as</Label>
        <Select
          value={step.sender ?? 'user'}
          onValueChange={sender => {
            if (sender === 'app' || sender === 'user') onChange({ ...step, sender });
          }}
        >
          <SelectTrigger id={`slack-sender-${step.id}`}>
            <SelectValue>{slackSenderLabel(step.sender)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="app">{slackSenderLabel('app')}</SelectItem>
            <SelectItem value="user">{slackSenderLabel('user')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {step.sender === 'app'
            ? 'Posts as the TulipFarm app. Add the app to the channel first.'
            : 'Posts under the Slack account of the person who starts the run, or its sponsor.'}
        </p>
      </>
      <Label>Message text</Label>
      <ValueControl
        id={`slack-text-${step.id}`}
        value={step.text}
        earlier={earlier}
        onChange={text => onChange({ ...step, text })}
      />
      <p className="text-sm text-muted-foreground">
        The value must be text, from 1 to 4,000 characters. Each send needs the requester’s or sponsor’s approval within
        24 hours. Saving or activating this workflow does not approve messages.
      </p>
    </fieldset>
  );
}

export function workflowSlackDestinationQuery(workspaceId: string, id: string) {
  return {
    key: ['workflows', 'slack-destination', id],
    enabled: !!id,
    load: async (signal: AbortSignal) => {
      const response = await jsonResponse(
        `${apiOrigin}/v1/workspaces/${workspaceId}/slack/destinations/${encodeURIComponent(id)}`,
        { method: 'GET', signal, cache: 'no-store' },
      );
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'slack-destination-unavailable',
          'The exact Slack destination could not be checked. Your input is retained.',
        );
      return slackDestinationViewSchema.parse(await readJson(response));
    },
  };
}
export function useWorkflowSlackDestination(workspaceId: string, id: string) {
  return useFeatureRead(workflowSlackDestinationQuery(workspaceId, id));
}
export function WorkflowSlackCheck({
  workspaceId,
  id,
  onReady,
}: {
  workspaceId: string;
  id: string;
  onReady: (id: string, ready: boolean) => void;
}) {
  const read = useWorkflowSlackDestination(workspaceId, id);
  const ready = read.state.kind === 'ready' && !read.state.refreshing && !read.state.error;
  useEffect(() => {
    onReady(id, ready);
    return () => onReady(id, false);
  }, [id, ready, onReady]);
  if (ready)
    return (
      <Button size="sm" variant="ghost" onClick={() => void read.refresh()}>
        Check Slack destination
      </Button>
    );
  if (read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing))
    return (
      <p role="status" className="text-sm">
        Checking the exact Slack channel...
      </p>
    );
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm">
        Check this Slack destination before saving. The channel is not verified.
      </p>
      <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
        Check Slack destination
      </Button>
    </div>
  );
}
export function WorkflowSlackDestinationLabel({
  workspaceId,
  id,
  onReady,
}: {
  workspaceId: string;
  id: string;
  onReady?: (id: string, ready: boolean) => void;
}) {
  const read = useWorkflowSlackDestination(workspaceId, id);
  const ready = read.state.kind === 'ready' && !read.state.refreshing && !read.state.error;
  useEffect(() => {
    onReady?.(id, ready);
  }, [id, ready, onReady]);
  if (!id) return <p>Choose a Slack destination to check its exact channel.</p>;
  return (
    <section aria-label="Verified Slack destination" className="space-y-2">
      {read.state.kind === 'loading' ? (
        <p role="status">Checking the exact Slack channel…</p>
      ) : read.state.kind === 'ready' ? (
        <>
          <p className="font-medium">
            #{read.state.data.name} · Slack workspace {read.state.data.teamId}
          </p>
          <p className="text-sm text-muted-foreground">Channel {read.state.data.channel}</p>
          {read.state.refreshing && <p role="status">Checking Slack access…</p>}
          {read.state.error && <p role="alert">The channel could not be refreshed. Check it again before saving.</p>}
        </>
      ) : (
        <StatePanel
          kind={read.state.kind === 'error' ? 'error' : 'unavailable'}
          title="Exact Slack destination unavailable"
          description="Do not guess the channel. Check your Slack integration and channel access. The destination ID and message are retained."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Check Slack destination
          </Button>
        </StatePanel>
      )}
      <p className="break-all text-xs text-muted-foreground">Destination ID: {id}</p>
      {read.state.kind === 'ready' && (
        <Button variant="outline" onClick={() => void read.refresh()}>
          Check Slack destination
        </Button>
      )}
    </section>
  );
}

export function WorkflowSlackAction({
  workspaceId,
  output,
  refresh,
}: {
  workspaceId: string;
  output: unknown;
  refresh: () => Promise<void>;
}) {
  const api = useMemo(() => agentApi(workspaceId), [workspaceId]);
  if (
    !output ||
    typeof output !== 'object' ||
    !('provider' in output) ||
    output.provider !== 'slack' ||
    !('actionId' in output) ||
    typeof output.actionId !== 'string'
  )
    return null;
  return <SlackAction api={api} id={output.actionId} refresh={refresh} />;
}
