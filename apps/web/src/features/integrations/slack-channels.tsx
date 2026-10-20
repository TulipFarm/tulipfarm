import { HashIcon, LockIcon } from 'lucide-react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { apiOrigin } from '@/lib/auth';
import { IntegrationRequestError } from '@/lib/integrations';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { integrationKeys } from './queries';

const channelsSchema = z.object({
  channels: z.array(z.object({ id: z.string(), name: z.string(), private: z.boolean() })),
  complete: z.boolean(),
  missingScopes: z.array(z.string()),
});

async function loadSlackBotChannels(workspaceId: string, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/channels`, {
    signal: requestSignal(signal),
    cache: 'no-store',
  });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return channelsSchema.parse(await readJson(response));
}

export function SlackBotChannels({ workspaceId }: { workspaceId: string }) {
  const read = useFeatureRead({
    key: [...integrationKeys.content('slack'), 'bot-channels'],
    load: signal => loadSlackBotChannels(workspaceId, signal),
  });
  const state = read.state;
  const refreshing = state.kind === 'ready' && state.refreshing;
  return (
    <section className="space-y-3" aria-labelledby="slack-bot-channels">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 id="slack-bot-channels" className="text-sm font-medium">
            Channels
          </h3>
          {state.kind === 'ready' && state.data.missingScopes.length < 2 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {state.data.channels.length}
              {!state.data.complete && '+'}
            </span>
          )}
        </div>
        {state.kind !== 'unavailable' && state.kind !== 'error' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={state.kind === 'loading' || refreshing}
            aria-busy={refreshing}
            onClick={() => void read.refresh()}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
      </div>
      {state.kind === 'loading' ? (
        <StatePanel
          kind="loading"
          heading="h3"
          title="Loading channels"
          description="Checking which Slack channels TulipFarm belongs to."
        />
      ) : state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Channels unavailable"
          description="A Slack integration manager can grant you access to this integration."
        />
      ) : state.kind === 'error' ? (
        <StatePanel
          kind="error"
          heading="h3"
          title="Could not load channels"
          description="Slack did not return the channel list. Refresh to try again."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Refresh
          </Button>
        </StatePanel>
      ) : state.data.missingScopes.length === 2 ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Channel access not granted"
          description="This Slack integration cannot read channel lists. An integration manager can reconnect Slack with channel read access."
        />
      ) : state.data.channels.length === 0 ? (
        <StatePanel
          kind="empty"
          heading="h3"
          title="Not in any channels yet"
          description="Invite TulipFarm to a Slack channel with /invite @TulipFarm, then refresh."
        />
      ) : (
        <>
          <ul className="divide-y divide-border" aria-label="Slack channels with TulipFarm">
            {state.data.channels.map(channel => (
              <li key={channel.id} className="flex min-h-9 items-center gap-2 py-2 text-sm">
                {channel.private ? (
                  <LockIcon role="img" aria-label="Private channel" className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <HashIcon role="img" aria-label="Public channel" className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 break-words">{channel.name}</span>
              </li>
            ))}
          </ul>
          {!state.data.complete && (
            <p className="text-sm text-muted-foreground">Showing the first {state.data.channels.length} channels.</p>
          )}
        </>
      )}
      {state.kind === 'ready' && state.data.missingScopes.length === 1 && (
        <p className="text-sm text-muted-foreground">
          {state.data.missingScopes.includes('groups:read') ? 'Private' : 'Public'} channels are hidden because Slack
          did not grant read access to them.
        </p>
      )}
      {state.kind === 'ready' && state.error && (
        <Alert variant="destructive">
          <AlertDescription>Channels could not refresh. Showing the last loaded list.</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
