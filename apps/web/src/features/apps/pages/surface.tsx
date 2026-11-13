import { createContext, use, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { A2uiSurface, sproutAdapters, type A2uiAdapterProps, type A2uiOutgoingMessage } from '@tulipfarm/sprout/a2ui';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Status } from '@tulipfarm/sprout/status';
import {
  appAllowUrl,
  appsCatalog,
  appsCatalogId,
  layoutVersion,
  type AppEmbedReference,
} from '@tulipfarm/conversations/layout-contracts';
import { workspaceRoute } from '@/router';
import { ConversationFileReference } from '@/features/chat/file-mentions';
import { componentStatus, sourcesRead, type PageAction, type PageData, type Press, type SourceStatus } from './state';

type SurfaceState = {
  data: PageData;
  actions: ReadonlyMap<string, PageAction>;
  presses: Record<string, Press>;
  retry: (actionId: string) => void;
};
const Surface = createContext<SurfaceState | null>(null);

const sourceNotes: Record<
  Exclude<SourceStatus, 'ready' | 'loading'>,
  { text: string; tone: 'default' | 'destructive' | null }
> = {
  empty: { text: 'Nothing to show.', tone: null },
  restricted: { text: 'Some content here isn’t available to you.', tone: 'default' },
  unavailable: { text: 'This content is no longer available.', tone: 'default' },
  failed: { text: 'This content couldn’t load. Refresh to try again.', tone: 'destructive' },
};

/** Draws a component only when every source it reads is ready, and says why otherwise. */
function SourceGate({ status, children }: { status: SourceStatus; children: ReactNode }) {
  if (status === 'ready') return children;
  // The page's own status line announces loading once, so each placeholder stays silent.
  if (status === 'loading') return <Skeleton aria-hidden="true" />;
  const note = sourceNotes[status];
  if (note.tone === null) return <p className="text-sm text-muted-foreground">{note.text}</p>;
  return (
    <Alert variant={note.tone}>
      <AlertDescription>{note.text}</AlertDescription>
    </Alert>
  );
}

function gated(Adapter: ComponentType<A2uiAdapterProps>) {
  return function Gated(props: A2uiAdapterProps) {
    const state = use(Surface)!;
    const ids = useMemo(() => sourcesRead(props.props), [props.props]);
    return (
      <SourceGate status={ids.length ? componentStatus(state.data, ids) : 'ready'}>
        <Adapter props={props.props} context={props.context} />
      </SourceGate>
    );
  };
}

const pressNotes: Record<Press['state'], { state: 'running' | 'success' | 'error'; text: string } | null> = {
  confirming: null,
  sent: { state: 'running', text: 'Sending…' },
  running: { state: 'running', text: 'Workflow started. Refresh later to see its changes.' },
  succeeded: { state: 'success', text: 'Done.' },
  failed: { state: 'error', text: 'This didn’t go through.' },
};

const availabilityNotes = {
  restricted: 'You don’t have permission to run this.',
  unavailable: 'This action is no longer available.',
};

/** A page button: disabled with the reason when the viewer can't run its action, and the state of its last press. */
function ActionButton(props: A2uiAdapterProps<Parameters<typeof sproutAdapters.Button>[0]['props']>) {
  const state = use(Surface)!;
  const actionId = 'event' in props.props.action ? props.props.action.event.name : null;
  const action = actionId ? state.actions.get(actionId) : undefined;
  // A button that opens a link or calls a local function has no page action behind it.
  const availability = actionId === null ? 'available' : (action?.availability ?? 'unavailable');
  const press = actionId ? state.presses[actionId] : undefined;
  const note = press && pressNotes[press.state];
  const context = availability === 'available' ? props.context : { ...props.context, readOnly: true, canAct: false };
  return (
    <div className="space-y-1">
      <sproutAdapters.Button props={props.props} context={context} />
      {availability !== 'available' ? (
        <p className="text-sm text-muted-foreground">{availabilityNotes[availability]}</p>
      ) : note ? (
        <p role="status" className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <Status state={note.state} size="sm" aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1">
            {press.state === 'failed' && press.message ? `${note.text} ${press.message}` : note.text}
          </span>
          {press.state === 'failed' && (
            <Button variant="link" size="sm" onClick={() => state.retry(press.actionId)}>
              Try again
            </Button>
          )}
        </p>
      ) : null}
    </div>
  );
}

function EmbedAdapter({ props }: A2uiAdapterProps<{ ref: AppEmbedReference }>) {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  if (props.ref.kind === 'workspace-file')
    return <ConversationFileReference workspaceId={workspace.id} slug={workspace.slug} fileId={props.ref.fileId} />;
  const { workflowId, name } = props.ref.reference;
  return (
    <ResultCard
      title={name}
      kind="Workflow"
      apps={[]}
      status="Saved in Workflows"
      action={{
        label: 'Open workflow',
        onClick: () =>
          void navigate({
            to: '/$workspaceSlug/workflows/$workflowId',
            params: { workspaceSlug: workspace.slug, workflowId },
          }),
      }}
    />
  );
}

const adapters = {
  [appsCatalogId]: {
    ...Object.fromEntries(Object.entries(sproutAdapters).map(([name, adapter]) => [name, gated(adapter)])),
    Button: gated(ActionButton),
    Embed: gated(EmbedAdapter),
  },
};
const catalogs = [appsCatalog];

/** One app page drawn by the generative UI renderer, with its sources at `/sources` and its row at `/params/row`. */
export function PageSurface({
  surface,
  row,
  locked,
  onAction,
  ...state
}: SurfaceState & {
  surface: unknown[];
  row: string | undefined;
  locked: boolean;
  onAction: (action: Extract<A2uiOutgoingMessage, { action: unknown }>['action'], messages: unknown[]) => void;
}) {
  const [lookups, setLookups] = useState<unknown[]>([]);
  const surfaceId = (surface[0] as { createSurface?: { surfaceId?: string } } | undefined)?.createSurface?.surfaceId;
  const messages = useMemo(
    () => [
      ...surface,
      { version: layoutVersion, updateDataModel: { surfaceId, path: '/params', value: { row: row ?? null } } },
      ...(state.data.model ? [state.data.model] : []),
      ...lookups,
    ],
    [surface, surfaceId, row, state.data.model, lookups],
  );
  const onMessage = (message: A2uiOutgoingMessage) => {
    if ('action' in message) onAction(message.action, messages);
    // Pages have no lookup service yet, so a field that searches rows or members says so instead of waiting.
    else if ('callAgentFunction' in message)
      setLookups(current => [
        ...current,
        {
          version: layoutVersion,
          agentFunctionResponse: {
            functionCallId: message.callAgentFunction.functionCallId,
            error: { code: 'EXECUTION_ERROR', message: 'Search isn’t available on app pages.' },
          },
        },
      ]);
  };
  return (
    <Surface value={state}>
      <A2uiSurface
        messages={messages}
        catalogs={catalogs}
        adapters={adapters}
        size="full"
        readOnly={locked}
        onMessage={onMessage}
        allowUrl={appAllowUrl}
      />
    </Surface>
  );
}
