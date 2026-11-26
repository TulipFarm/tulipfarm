import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { ArrowUpRightIcon, KeyIcon, RefreshIcon } from '@tulipfarm/icons';
import { useFeatureChanges } from '@/lib/query';
import { byokPlanApi, isByokProvider, type ByokProvider } from './byok-plan-api';
import { modelKeys } from './queries';
import {
  PlanModels,
  ShareDialog,
  audience,
  planStates,
  subscriptionsKey,
  usePeople,
  useSubscriptions,
  type Subscription,
} from './subscription-sharing';

type ProviderMeta = {
  id: ByokProvider;
  name: string;
  brand: Brand | null;
  url: string | null;
  keyPlaceholder: string;
  endpointPlaceholder?: string;
  endpointRequired?: boolean;
};

const keyProviders: readonly ProviderMeta[] = [
  {
    id: 'byok-anthropic',
    name: 'Anthropic',
    brand: 'claude',
    url: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-api03-...',
  },
  {
    id: 'byok-openai',
    name: 'OpenAI',
    brand: 'openai',
    url: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'byok-google',
    name: 'Google AI Studio',
    brand: 'gemini',
    url: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'byok-xai',
    name: 'xAI',
    brand: 'grok',
    url: 'https://console.x.ai',
    keyPlaceholder: 'xai-...',
  },
  {
    id: 'byok-openai-compatible',
    name: 'OpenAI-compatible endpoint',
    brand: null,
    url: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-...',
    endpointPlaceholder: 'https://openrouter.ai/api/v1',
    endpointRequired: true,
  },
];

const providerById = new Map(keyProviders.map(item => [item.id, item]));

export function ApiKeysPane({ workspaceId }: { workspaceId: string }) {
  const api = useMemo(() => byokPlanApi(workspaceId), [workspaceId]);
  const { read } = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const { change } = useFeatureChanges();
  const [connectTarget, setConnectTarget] = useState<{
    provider: ByokProvider;
    connectionId?: string | undefined;
    label?: string | undefined;
    endpoint?: string | undefined;
  } | null>(null);
  const [sharing, setSharing] = useState<Subscription | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const ownKeys =
    read.state.kind === 'ready'
      ? read.state.data.filter(item => item.mine && isByokProvider(item.provider) && item.state !== 'signed-out')
      : [];

  const invalidate = () => change({ keys: [subscriptionsKey, modelKeys.catalog()] });

  async function refreshConnection(sub: Subscription) {
    if (!isByokProvider(sub.provider)) return;
    setBusyId(sub.connectionId);
    setFeedback(null);
    try {
      const updated = await api.refreshModels(sub.provider, sub.connectionId);
      await invalidate();
      setFeedback({
        kind: 'info',
        text: `Discovered ${updated.models.length} ${updated.models.length === 1 ? 'model' : 'models'} for ${updated.account ?? 'this key'}.`,
      });
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not refresh models. Try again.',
      });
    } finally {
      setBusyId(null);
    }
  }

  async function disconnectConnection(sub: Subscription) {
    if (!isByokProvider(sub.provider)) return;
    setBusyId(sub.connectionId);
    setFeedback(null);
    try {
      await api.disconnect(sub.provider, sub.connectionId);
      await invalidate();
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not disconnect this API key. Try again.',
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-6">
      <header>
        <h2 className="text-lg font-medium">API keys</h2>
        <p className="text-sm text-muted-foreground">
          Connect your own API keys from AI providers or any OpenAI-compatible server. TulipFarm discovers the models
          your key can access automatically, and requests are billed to your provider account instead of workspace
          credits.
        </p>
      </header>

      {feedback && (
        <Alert variant={feedback.kind === 'error' ? 'destructive' : 'default'}>
          <AlertDescription>{feedback.text}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Add a provider key</h3>
        <ul className="divide-y rounded-md border px-3">
          {keyProviders.map(provider => (
            <li key={provider.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              {provider.brand ? (
                <BrandIcon brand={provider.brand} size="inline" />
              ) : (
                <span className="text-muted-foreground">
                  <KeyIcon size="sm" aria-hidden="true" />
                </span>
              )}
              <span className="min-w-0 flex-1 font-medium">{provider.name}</span>
              {provider.url && (
                <a
                  href={provider.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Get a key <ArrowUpRightIcon size="xs" aria-hidden="true" />
                </a>
              )}
              <Button size="sm" variant="outline" onClick={() => setConnectTarget({ provider: provider.id })}>
                Connect
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {ownKeys.length > 0 && (
        <section className="grid gap-4">
          <h3 className="text-sm font-medium">Connected API keys</h3>
          <div className="grid gap-4">
            {ownKeys.map(sub => {
              const meta = isByokProvider(sub.provider) ? providerById.get(sub.provider) : undefined;
              const busy = busyId === sub.connectionId;
              return (
                <div key={sub.connectionId} className="grid gap-4 rounded-md border p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    {meta?.brand ? (
                      <BrandIcon brand={meta.brand} size="sm" />
                    ) : (
                      <span className="pt-0.5 text-muted-foreground">
                        <KeyIcon size="sm" aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{sub.account ?? meta?.name ?? 'API key'}</span>
                        <Badge variant={planStates[sub.state].variant}>{planStates[sub.state].label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {meta?.name}
                        {sub.endpoint ? ` · ${sub.endpoint}` : ''}
                        {` · ${sub.models.length} ${sub.models.length === 1 ? 'model' : 'models'}`}
                      </p>
                      {sub.grants && (
                        <p className="text-xs text-muted-foreground">Shared with: {audience(sub.grants, people)}</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || sub.state !== 'connected'}
                        onClick={() => void refreshConnection(sub)}
                      >
                        <RefreshIcon size="xs" aria-hidden="true" />
                        Refresh models
                      </Button>
                      {sub.canShare && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setSharing(sub)}>
                          Share
                        </Button>
                      )}
                      {isByokProvider(sub.provider) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            setConnectTarget({
                              provider: sub.provider as ByokProvider,
                              connectionId: sub.connectionId,
                              label: sub.account ?? undefined,
                              endpoint: sub.endpoint ?? undefined,
                            })
                          }
                        >
                          Update key
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnectConnection(sub)}>
                        Disconnect
                      </Button>
                    </div>
                  </div>
                  <PlanModels workspaceId={workspaceId} subscription={sub} people={people} />
                </div>
              );
            })}
          </div>
        </section>
      )}

      {connectTarget && (
        <ConnectByokDialog
          api={api}
          target={connectTarget}
          onConnected={async count => {
            await invalidate();
            setConnectTarget(null);
            setFeedback({
              kind: 'info',
              text: `API key connected. Discovered ${count} ${count === 1 ? 'model' : 'models'}.`,
            });
          }}
          close={() => setConnectTarget(null)}
        />
      )}

      {sharing && (
        <ShareDialog workspaceId={workspaceId} subscription={sharing} people={people} close={() => setSharing(null)} />
      )}
    </div>
  );
}

function ConnectByokDialog({
  api,
  target,
  onConnected,
  close,
}: {
  api: ReturnType<typeof byokPlanApi>;
  target: {
    provider: ByokProvider;
    connectionId?: string | undefined;
    label?: string | undefined;
    endpoint?: string | undefined;
  };
  onConnected: (modelCount: number) => Promise<void>;
  close: () => void;
}) {
  const meta = providerById.get(target.provider)!;
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(target.endpoint ?? '');
  const [label, setLabel] = useState(target.label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!apiKey.trim()) {
      setError('Enter your API key.');
      return;
    }
    if (meta.endpointRequired && !endpoint.trim()) {
      setError('Enter the API base URL.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const connection = await api.connect(target.provider, {
        apiKey: apiKey.trim(),
        ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(target.connectionId ? { connectionId: target.connectionId } : {}),
      });
      await onConnected(connection.models.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not verify this API key. Try again.');
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => !open && !saving && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target.connectionId ? `Update ${meta.name} API key` : `Connect ${meta.name}`}</DialogTitle>
          <DialogDescription>
            Your key is encrypted at rest and verified by fetching your live model list.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="byok-api-key">API key</Label>
            <Input
              id="byok-api-key"
              type="password"
              autoComplete="off"
              placeholder={meta.keyPlaceholder}
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              disabled={saving}
            />
          </div>
          {meta.endpointRequired && (
            <div className="grid gap-1.5">
              <Label htmlFor="byok-endpoint">API base URL</Label>
              <Input
                id="byok-endpoint"
                type="url"
                placeholder={meta.endpointPlaceholder ?? 'https://api.example.com/v1'}
                value={endpoint}
                onChange={event => setEndpoint(event.target.value)}
                disabled={saving}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="byok-label">Label (optional)</Label>
            <Input
              id="byok-label"
              type="text"
              placeholder={`My ${meta.name} key`}
              value={label}
              onChange={event => setLabel(event.target.value)}
              disabled={saving}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? 'Verifying…' : target.connectionId ? 'Save key' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
