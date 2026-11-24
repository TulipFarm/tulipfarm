import { useId, useRef, useState } from 'react';
import { browserSiteSchema } from '@tulipfarm/browser/contracts';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@tulipfarm/sprout/dialog';
import { Input } from '@tulipfarm/sprout/input';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { describedBy, Labelled } from '@/features/secrets/fields';
import type { BrowserSessionState } from './api';
import {
  browserLoginErrorMessage,
  useBrowserLoginChanges,
  useBrowserLogins,
  useBrowserLoginsApi,
  type BrowserLoginSummary,
} from './logins';

export const loadedLoginPrompt = (site: string) => `I’ve loaded a saved login for ${site}. Continue.`;

/**
 * Shown while the agent waits for someone to sign in to a site: the saved logins the member may use for it, or
 * taking over to sign in themselves.
 */
export function SignInPicker({
  workspaceId,
  chatId,
  site,
  reason,
  busy,
  onTakeOver,
  onLoaded,
}: {
  workspaceId: string;
  chatId: string;
  site: string;
  reason: string;
  busy: boolean;
  onTakeOver: () => void;
  onLoaded: (state: BrowserSessionState) => void;
}) {
  const api = useBrowserLoginsApi(workspaceId);
  const read = useBrowserLogins(workspaceId, site);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const usable =
    read.state.kind === 'ready' ? read.state.data.logins.filter(login => login.status !== 'suspended') : [];
  const load = async (login: BrowserLoginSummary) => {
    setLoading(login.id);
    setError('');
    try {
      onLoaded(await api.load(chatId, login.id));
    } catch (failure) {
      setError(browserLoginErrorMessage(failure));
    } finally {
      setLoading(null);
    }
  };
  return (
    <Alert>
      <AlertTitle>Sign in to {site}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col gap-2">
          <p>{reason} Use a saved login, or take over and sign in yourself.</p>
          {read.state.kind === 'loading' && <Skeleton />}
          {usable.length > 0 && (
            <ul aria-label={`Saved logins for ${site}`} className="flex flex-col gap-1">
              {usable.map(login => (
                <li key={login.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{login.name}</span>
                    {login.status === 'needs-sign-in' && <Badge variant="warning">Signed out</Badge>}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || loading !== null}
                    aria-busy={loading === login.id}
                    onClick={() => void load(login)}
                  >
                    {loading === login.id ? 'Loading…' : 'Use this login'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {read.state.kind === 'ready' && !usable.length && (
            <p className="text-muted-foreground">You have no saved logins for {site}.</p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button size="sm" variant="outline" disabled={busy || loading !== null} onClick={onTakeOver}>
              Sign in yourself
            </Button>
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Saves what the chat's browser holds for a site as a login the member owns. */
export function SaveLoginDialog({
  workspaceId,
  chatId,
  site: initialSite,
  close,
}: {
  workspaceId: string;
  chatId: string;
  site: string;
  close: (saved: boolean) => void;
}) {
  const api = useBrowserLoginsApi(workspaceId);
  const changes = useBrowserLoginChanges();
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialSite ? `${initialSite} login` : '');
  const [site, setSite] = useState(initialSite);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const nameError = checked && !name.trim() ? 'Enter a name.' : null;
  const siteError = checked && !browserSiteSchema.safeParse(site).success ? 'Use a site such as amazon.com.' : null;
  const submit = async () => {
    setChecked(true);
    if (!name.trim() || !browserSiteSchema.safeParse(site).success) return;
    setSending(true);
    setError('');
    try {
      await api.save(chatId, { name: name.trim(), site: browserSiteSchema.parse(site) });
      await changes.changed();
      close(true);
    } catch (failure) {
      setError(browserLoginErrorMessage(failure));
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) close(false);
      }}
    >
      <DialogContent size="form" initialFocus={nameRef}>
        <DialogHeader>
          <DialogTitle>Save login</DialogTitle>
          <DialogDescription>
            Saves this browser’s sign-in for the site, so agents can use it in later chats without signing in again.
            Nobody can read it back. Only you can use it until you share it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <Labelled id={`${id}-name`} label="Name" error={nameError}>
            <Input
              ref={nameRef}
              id={`${id}-name`}
              value={name}
              maxLength={80}
              aria-invalid={!!nameError}
              aria-describedby={describedBy(`${id}-name`, null, nameError)}
              onChange={event => setName(event.target.value)}
            />
          </Labelled>
          <Labelled
            id={`${id}-site`}
            label="Site"
            helper="Its cookies and saved data are kept, including for its subdomains."
            error={siteError}
          >
            <Input
              id={`${id}-site`}
              value={site}
              placeholder="amazon.com"
              aria-invalid={!!siteError}
              aria-describedby={describedBy(`${id}-site`, true, siteError)}
              onChange={event => setSite(event.target.value)}
            />
          </Labelled>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={sending} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending} aria-busy={sending}>
              {sending ? 'Saving…' : 'Save login'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
