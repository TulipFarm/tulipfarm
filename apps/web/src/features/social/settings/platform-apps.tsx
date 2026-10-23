import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  accessTiersByPlatform,
  platforms,
  type AccessTier,
  type Platform,
  type PlatformAppCreate,
  type PlatformAppMetadata,
  type PlatformAvailability,
} from '@tulipfarm/social/contracts';
import { platformNames } from '../presentation';
import { accessTiers, appSources, settingsError } from './labels';

export type PlatformAppActions = {
  create: (input: PlatformAppCreate) => Promise<PlatformAppMetadata>;
  replaceSecret: (appId: string, clientSecret: string) => Promise<PlatformAppMetadata>;
};

/**
 * A workspace's own platform apps, for admins (PRODUCT 3–6). Client secrets are write-only: the API never returns
 * one, and a typed secret is cleared once it is sent.
 */
export function PlatformApps({
  availability,
  apps,
  redirectUri,
  actions,
}: {
  availability: readonly PlatformAvailability[];
  apps: readonly PlatformAppMetadata[];
  redirectUri: string;
  actions: PlatformAppActions;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className="space-y-8">
      <section aria-labelledby="social-redirect" className="space-y-2">
        <h2 id="social-redirect" className="text-base font-semibold">
          Redirect URL
        </h2>
        <p className="text-sm text-muted-foreground">
          Add this URL to each app in the platform’s developer console before you register it here.
        </p>
        <div className="flex max-w-2xl flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input id="social-redirect-url" aria-label="Redirect URL" readOnly value={redirectUri} />
          </div>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(redirectUri).then(
                () => setCopied('Redirect URL copied.'),
                () => setCopied('Could not copy. Select the URL and copy it.'),
              )
            }
          >
            Copy URL
          </Button>
        </div>
        <p role="status" className="text-sm empty:hidden">
          {copied}
        </p>
      </section>
      <section aria-labelledby="social-apps-in-use" className="space-y-3">
        <h2 id="social-apps-in-use" className="text-base font-semibold">
          Apps by platform
        </h2>
        <p className="text-sm text-muted-foreground">
          New connections use the TulipFarm or server app when there is one. People can pick a workspace app instead
          when they connect.
        </p>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {availability.map(item => (
            <PlatformRow
              key={item.platform}
              availability={item}
              apps={apps.filter(app => app.platform === item.platform)}
              actions={actions}
            />
          ))}
        </ul>
      </section>
      <AddApp actions={actions} />
    </div>
  );
}

function PlatformRow({
  availability,
  apps,
  actions,
}: {
  availability: PlatformAvailability;
  apps: readonly PlatformAppMetadata[];
  actions: PlatformAppActions;
}) {
  const inUse =
    availability.available && availability.appSource
      ? `${appSources[availability.appSource]}${availability.accessTier ? ` · ${accessTiers[availability.accessTier]} access` : ''}`
      : availability.reason === 'workspace-app-required'
        ? 'Needs a workspace app'
        : 'Not available';
  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{platformNames[availability.platform]}</p>
        <Badge variant={availability.available ? 'success' : 'secondary'}>{inUse}</Badge>
      </div>
      {availability.reason === 'workspace-app-required' && (
        <p className="text-sm text-muted-foreground">
          {platformNames[availability.platform]} charges for API use, so this workspace must register its own app.
        </p>
      )}
      {apps.length > 0 && (
        <ul className="space-y-3">
          {apps.map(app => (
            <WorkspaceApp key={app.id} app={app} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkspaceApp({ app, actions }: { app: PlatformAppMetadata; actions: PlatformAppActions }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const field = `social-secret-${app.id}`;
  async function replace() {
    setBusy(true);
    setMessage(null);
    try {
      await actions.replaceSecret(app.id, secret);
      setSecret('');
      setOpen(false);
      setMessage({ text: 'Secret replaced. Connections made through this app must reconnect.', ok: true });
    } catch (failure) {
      setMessage({ text: settingsError(failure), ok: false });
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }
  return (
    <li className="space-y-3 rounded-md bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <dl className="grid min-w-0 flex-1 grid-cols-3 gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Workspace app</dt>
          <dd className="col-span-2 font-medium">{app.name}</dd>
          <dt className="text-muted-foreground">Client ID</dt>
          <dd className="col-span-2 break-all font-mono">{app.clientId}</dd>
          <dt className="text-muted-foreground">Access</dt>
          <dd className="col-span-2">{accessTiers[app.accessTier]}</dd>
          <dt className="text-muted-foreground">Client secret</dt>
          <dd className="col-span-2">Saved. It cannot be shown.</dd>
        </dl>
        <Button
          variant="outline"
          aria-expanded={open}
          aria-label={`Replace secret for ${app.name}`}
          onClick={() => {
            setOpen(!open);
            setSecret('');
          }}
        >
          Replace secret
        </Button>
      </div>
      {open && (
        <form
          className="space-y-2"
          onSubmit={event => {
            event.preventDefault();
            if (secret) setConfirming(true);
          }}
        >
          <Label htmlFor={field}>New client secret</Label>
          <Input
            id={field}
            type="password"
            autoComplete="new-password"
            value={secret}
            maxLength={4096}
            onChange={event => setSecret(event.target.value)}
          />
          <p className="text-muted-foreground">
            Every connection made through this app must reconnect, and its channels must be added again.
          </p>
          <Button type="submit" disabled={!secret || busy}>
            Replace secret
          </Button>
        </form>
      )}
      <AlertDialog open={confirming} onOpenChange={value => !busy && setConfirming(value)}>
        <AlertDialogContent>
          <AlertDialogTitle>Replace the secret for {app.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every connection made through this app stops working until someone reconnects it. Its channels must then be
            added again, and scheduled posts on them need a new approval.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep current secret</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={() => void replace()}>
              Replace secret
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {message && (
        <Alert variant={message.ok ? 'default' : 'destructive'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </li>
  );
}

function AddApp({ actions }: { actions: PlatformAppActions }) {
  const [platform, setPlatform] = useState<Platform>('linkedin');
  const [tier, setTier] = useState<AccessTier>(accessTiersByPlatform.linkedin[0]);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const tiers: readonly AccessTier[] = accessTiersByPlatform[platform];
  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const app = await actions.create({ platform, name, clientId, clientSecret: secret, accessTier: tier });
      setSecret('');
      setName('');
      setClientId('');
      setMessage({
        text: `${app.name} added. Existing ${platformNames[platform]} connections keep their app; pick this one when you connect.`,
        ok: true,
      });
    } catch (failure) {
      setMessage({ text: settingsError(failure), ok: false });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="social-add-app" className="space-y-3">
      <h2 id="social-add-app" className="text-base font-semibold">
        Add a workspace app
      </h2>
      <form
        className="max-w-2xl space-y-4"
        onSubmit={event => {
          event.preventDefault();
          void add();
        }}
      >
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="social-app-platform">Platform</Label>
            <Select
              value={platform}
              onValueChange={value => {
                const next = platforms.find(item => item === value);
                if (!next) return;
                setPlatform(next);
                setTier(accessTiersByPlatform[next][0]);
              }}
            >
              <SelectTrigger id="social-app-platform" width="full">
                <SelectValue>{platformNames[platform]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {platforms.map(item => (
                  <SelectItem key={item} value={item}>
                    {platformNames[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="social-app-tier">Approved access</Label>
            <Select
              value={tier}
              onValueChange={value => {
                const next = tiers.find(item => item === value);
                if (next) setTier(next);
              }}
            >
              <SelectTrigger id="social-app-tier" width="full">
                <SelectValue>{accessTiers[tier]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {tiers.map(item => (
                  <SelectItem key={item} value={item}>
                    {accessTiers[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="social-app-name">Name</Label>
            <Input
              id="social-app-name"
              value={name}
              maxLength={120}
              required
              onChange={event => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="social-app-client">Client ID</Label>
            <Input
              id="social-app-client"
              value={clientId}
              maxLength={512}
              required
              autoComplete="off"
              onChange={event => setClientId(event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="social-app-secret">Client secret</Label>
            <Input
              id="social-app-secret"
              type="password"
              value={secret}
              maxLength={4096}
              required
              autoComplete="new-password"
              aria-describedby="social-app-secret-note"
              onChange={event => setSecret(event.target.value)}
            />
            <p id="social-app-secret-note" className="text-sm text-muted-foreground">
              Stored encrypted. No one can view it after you save.
            </p>
          </div>
        </fieldset>
        {message && (
          <Alert variant={message.ok ? 'default' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy || !name || !clientId || !secret} aria-busy={busy}>
          Add app
        </Button>
      </form>
    </section>
  );
}
