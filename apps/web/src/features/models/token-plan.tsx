import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { Check } from 'reicon-react/icons/Check';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { githubApi, githubConsent, githubError } from '@/lib/github';
import { startGitHub } from '@/features/integrations/connect';
import { planUsageUrls } from '@/features/chat/reply-failure-copy';
import { TableRequestError } from '@/features/tables/request-state';
import {
  tokenPlanApi,
  tokenPlanErrorMessage,
  type DeviceSignIn,
  type TokenConnection,
  type TokenPlanProvider,
} from './token-plan-api';
import { modelKeys } from './queries';
import {
  PlanModels,
  ShareDialog,
  expectNewPlan,
  useAskToShare,
  audience,
  subscriptionsKey,
  usePeople,
  useSubscriptions,
} from './subscription-sharing';

export const tokenConnectionKey = (provider: TokenPlanProvider) => ['models', `${provider}-connection`] as const;
const githubAccountsKey = (provider: TokenPlanProvider) => ['models', `${provider}-github-accounts`] as const;

const copy = {
  claude: {
    name: 'Claude',
    brand: 'claude',
    intro: 'Use your Claude Pro or Max plan in chats. Usage counts against your Claude plan, not workspace credits.',
    tokenLabel: 'Claude Code token',
    tokenHelper: 'It starts with sk-ant-oat.',
    placeholder: 'sk-ant-oat…',
    connected:
      'Pick these models in chats, from the model menu under Claude plan. Agents can’t use them. If your plan hits its limit and the workspace has a fallback model, that model answers instead and uses workspace credits.',
  },
  copilot: {
    name: 'GitHub Copilot',
    brand: 'github',
    intro: 'Use your GitHub Copilot plan in chats. Messages use your Copilot premium requests, not workspace credits.',
    tokenLabel: 'Personal access token',
    tokenHelper: 'It starts with github_pat_ and needs the Copilot Requests permission.',
    placeholder: 'github_pat_…',
    connected:
      'Pick these models in chats, from the model menu under GitHub Copilot plan. Agents can’t use them. Each reply uses premium requests, multiplied by the model’s rate. A simple reply uses one. A reply that uses tools, like searching tables or files, usually uses two, because TulipFarm checks that the answer is complete. If your plan hits its limit and the workspace has a fallback model, that model answers instead and uses workspace credits.',
  },
} as const;

type Phase =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'starting' }
  | { kind: 'linking'; accountId: string }
  | { kind: 'device'; device: DeviceSignIn; deadline: number }
  | { kind: 'disconnecting' };

/** The member's own Claude or Copilot connection, or null when this server doesn't offer that plan. */
export function useTokenConnection(workspaceId: string, provider: TokenPlanProvider) {
  const api = useMemo(() => tokenPlanApi(workspaceId, provider), [workspaceId, provider]);
  return useFeatureRead({ key: tokenConnectionKey(provider), load: api.connection });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="outline"
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? <Check size={14} aria-hidden="true" /> : null}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="inline-flex items-center gap-0.5 underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  );
}

/**
 * A member's own Claude or GitHub Copilot plan: connect it, see its models and share it. Claude connects with a token
 * from `claude setup-token`. Copilot connects by signing in with GitHub on a code page, or with a pasted token.
 */
export function TokenPlanPane({ workspaceId, provider }: { workspaceId: string; provider: TokenPlanProvider }) {
  const text = copy[provider];
  const api = useMemo(() => tokenPlanApi(workspaceId, provider), [workspaceId, provider]);
  const read = useTokenConnection(workspaceId, provider);
  // Copilot shares the member's personal GitHub sign-in, so the card offers the accounts they already connected.
  const githubAccounts = useFeatureRead({
    key: githubAccountsKey(provider),
    load: (signal: AbortSignal) =>
      provider === 'copilot' ? githubApi.list(workspaceId, signal) : Promise.resolve(null),
  });
  const subscriptions = useSubscriptions(workspaceId);
  const people = usePeople(workspaceId);
  const { change } = useFeatureChanges();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [token, setToken] = useState('');
  const [pasting, setPasting] = useState(provider === 'claude');
  const [sharing, setSharing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const own =
    subscriptions.read.state.kind === 'ready'
      ? subscriptions.read.state.data.find(item => item.provider === provider && item.mine)
      : undefined;
  const [asking, stopAsking] = useAskToShare(workspaceId, provider, own);
  const refreshAll = useCallback(
    () =>
      change({
        keys: [tokenConnectionKey(provider), subscriptionsKey, modelKeys.catalog(), githubAccountsKey(provider)],
      }),
    [change, provider],
  );
  const fail = useCallback(
    (error: unknown) =>
      setMessage({
        tone: 'error',
        text: error instanceof TableRequestError ? error.message : tokenPlanErrorMessage(provider, 'unavailable'),
      }),
    [provider],
  );

  const signal = useRef<AbortController | null>(null);
  useEffect(() => () => signal.current?.abort(), []);
  function freshSignal() {
    signal.current?.abort();
    signal.current = new AbortController();
    // Claude checks a token by sending it a short message, which can take a while.
    return AbortSignal.any([signal.current.signal, AbortSignal.timeout(90_000)]);
  }

  const device = phase.kind === 'device' ? phase.device : null;
  const deadline = phase.kind === 'device' ? phase.deadline : 0;
  useEffect(() => {
    if (!device) return;
    const controller = new AbortController();
    const timer = setInterval(
      () => {
        if (Date.now() > deadline) {
          setPhase({ kind: 'idle' });
          setMessage({ tone: 'error', text: tokenPlanErrorMessage(provider, 'attempt-expired') });
          return;
        }
        void api.attempt(device.attemptId, controller.signal).then(
          result => {
            if (controller.signal.aborted || result.status === 'pending') return;
            setPhase({ kind: 'idle' });
            setMessage(
              result.status === 'completed'
                ? { tone: 'success', text: `${text.name} is connected.` }
                : { tone: 'error', text: tokenPlanErrorMessage(provider, result.errorCode) },
            );
            void refreshAll();
          },
          // A missed check is retried on the next tick.
          () => undefined,
        );
      },
      Math.max(device.intervalSeconds, 2) * 1000,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, device, deadline, provider, refreshAll, text.name]);

  async function connect() {
    expectNewPlan(workspaceId, provider, own);
    const value = token.replace(/\s+/g, '');
    if (!value) {
      setMessage({ tone: 'error', text: tokenPlanErrorMessage(provider, 'token-invalid') });
      return;
    }
    setPhase({ kind: 'connecting' });
    setMessage(null);
    try {
      await api.connectToken(value, freshSignal());
      setToken('');
      setMessage({ tone: 'success', text: `${text.name} is connected.` });
      void refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  async function beginDevice() {
    expectNewPlan(workspaceId, provider, own);
    setPhase({ kind: 'starting' });
    setMessage(null);
    try {
      const started = await api.beginDevice(freshSignal());
      setPhase({ kind: 'device', device: started, deadline: Date.now() + started.expiresInSeconds * 1000 });
    } catch (error) {
      setPhase({ kind: 'idle' });
      fail(error);
    }
  }

  async function connectWithAccount(accountId: string, login: string) {
    expectNewPlan(workspaceId, provider, own);
    setPhase({ kind: 'linking', accountId });
    setMessage(null);
    try {
      await api.useGitHubAccount(accountId, freshSignal());
      setMessage({ tone: 'success', text: `${text.name} is connected with @${login}.` });
      void refreshAll();
    } catch (error) {
      if (error instanceof TableRequestError && error.code === 'not-eligible')
        setMessage({ tone: 'error', text: `@${login} has no GitHub Copilot plan.` });
      else fail(error);
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  /** Signs in through the personal GitHub connection; coming back connects Copilot with the same account. */
  async function signInWithGitHub(accountId?: string) {
    expectNewPlan(workspaceId, provider, own);
    setPhase({ kind: 'starting' });
    setMessage(null);
    try {
      if (accountId) githubConsent((await githubApi.reconnect(workspaceId, accountId)).url);
      else await startGitHub(workspaceId);
    } catch (error) {
      setPhase({ kind: 'idle' });
      setMessage({ tone: 'error', text: githubError(error) });
    }
  }

  async function disconnect() {
    setPhase({ kind: 'disconnecting' });
    setMessage(null);
    try {
      await api.disconnect(freshSignal());
      setMessage({ tone: 'success', text: `${text.name} is disconnected.` });
      void refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  const { state } = read;
  if (state.kind === 'unavailable' || (state.kind === 'ready' && state.data === null)) return null;
  const connection: TokenConnection | null = state.kind === 'ready' ? state.data : null;
  const busy = phase.kind !== 'idle' && phase.kind !== 'device';
  const live = connection && (connection.state === 'connected' || connection.state === 'reconnect-required');
  const signIn = !!connection && connection.state !== 'connected';
  const github = githubAccounts.state.kind === 'ready' ? githubAccounts.state.data : null;
  // The web sign-in through the personal GitHub connection replaces the device code when this server offers it.
  const githubSignIn = provider === 'copilot' && !!github?.configured;
  const usable = (github?.accounts ?? []).flatMap(account =>
    account.state === 'active' && account.identity ? [{ id: account.id, login: account.identity.login }] : [],
  );
  const linked = connection?.githubAccountId ?? null;

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-start gap-3">
        <BrandIcon brand={text.brand} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-medium">
            {text.name} plan
            {connection?.state === 'connected' && <Badge variant="success">Connected</Badge>}
            {connection?.state === 'reconnect-required' && <Badge variant="warning">Needs reconnecting</Badge>}
          </h2>
          <p className="text-sm text-muted-foreground">
            {live && connection.account
              ? `Signed in as ${provider === 'copilot' ? '@' : ''}${connection.account}`
              : text.intro}
          </p>
          {live && own?.grants && (
            <p className="text-sm text-muted-foreground">Shared with: {audience(own.grants, people)}</p>
          )}
        </div>
        {live && (
          <div className="flex flex-wrap items-center gap-2">
            {own?.canShare && (
              <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
                Share
              </Button>
            )}
            {connection.state === 'connected' && (
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<a href={planUsageUrls[provider]} target="_blank" rel="noopener noreferrer" />}
              >
                Manage usage
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            )}
            <Button size="sm" variant="ghost-destructive" onClick={() => setConfirming(true)} disabled={busy}>
              {phase.kind === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        )}
      </header>
      {state.kind === 'loading' && (
        <div role="status" aria-label={`Checking your ${text.name} connection`} className="grid gap-2">
          <Skeleton />
          <Skeleton shape="action" />
        </div>
      )}
      {state.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>
            Couldn’t check your {text.name} connection. {state.message}
          </AlertDescription>
          <Button size="sm" variant="outline" onClick={() => void read.refresh()}>
            Retry
          </Button>
        </Alert>
      )}
      {message && (
        <Alert variant={message.tone === 'error' ? 'destructive' : 'default'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      {connection?.state === 'connected' && <p className="text-sm text-muted-foreground">{text.connected}</p>}
      {connection?.state === 'reconnect-required' && (
        <Alert>
          <AlertTitle>Reconnect {text.name}</AlertTitle>
          <AlertDescription>
            {linked
              ? 'Your GitHub sign-in needs renewing. Reconnecting fixes GitHub and Copilot together.'
              : tokenPlanErrorMessage(provider, 'reconnect-required')}
          </AlertDescription>
          {linked && githubSignIn && (
            <Button size="sm" onClick={() => void signInWithGitHub(linked)} disabled={busy}>
              {phase.kind === 'starting' ? 'Opening GitHub…' : 'Reconnect'}
            </Button>
          )}
        </Alert>
      )}
      {signIn && provider === 'claude' && (
        <div className="grid gap-4">
          <Alert>
            <AlertTitle>Check Anthropic’s terms</AlertTitle>
            <AlertDescription>
              Anthropic’s consumer terms may not allow a Claude Pro or Max plan to be used in other apps. If you connect
              it, you’re responsible for following those terms. Anthropic API keys are the supported option, and they’re
              coming soon to TulipFarm.
            </AlertDescription>
          </Alert>
          <ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground">
            <li>
              <ExternalLink href="https://docs.claude.com/en/docs/claude-code/setup">Install Claude Code</ExternalLink>{' '}
              if you don’t have it.
            </li>
            <li className="grid gap-1.5">
              <span>In a terminal, run this and sign in with your Claude account:</span>
              <span className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">claude setup-token</code>
                <CopyButton value="claude setup-token" label="Copy command" />
              </span>
            </li>
            <li>Paste the token it prints below, then select Connect.</li>
            <li>Share it with others if you like. Until you do, only you can use it.</li>
          </ol>
        </div>
      )}
      {signIn && provider === 'copilot' && device && (
        <div className="grid gap-3">
          <p role="status" className="text-sm">
            Open {device.verificationUri.replace(/^https:\/\//, '')}, enter this code and approve TulipFarm.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md border bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">
              {device.userCode}
            </code>
            <CopyButton value={device.userCode} label="Copy code" />
            <Button
              size="sm"
              nativeButton={false}
              render={<a href={device.verificationUri} target="_blank" rel="noopener noreferrer" />}
            >
              Open {device.verificationUri.replace(/^https:\/\//, '')}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Waiting for you to approve on GitHub…</p>
          <div>
            <Button size="sm" variant="outline" onClick={() => setPhase({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {signIn && githubSignIn && !device && (
        <div className="grid justify-items-start gap-3">
          <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
            <li>
              {usable.length
                ? 'Use a GitHub account you already connected, or sign in with another.'
                : 'Select Sign in with GitHub and approve TulipFarm. It connects your GitHub account too.'}
            </li>
            <li>Share it with others if you like. Until you do, only you can use it.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            {usable.map(account => (
              <Button
                key={account.id}
                size="sm"
                onClick={() => void connectWithAccount(account.id, account.login)}
                disabled={busy}
              >
                <BrandIcon brand="github" size="inline" />
                {phase.kind === 'linking' && phase.accountId === account.id
                  ? `Checking @${account.login}…`
                  : `Use @${account.login}`}
              </Button>
            ))}
            <Button
              size="sm"
              variant={usable.length ? 'outline' : 'default'}
              onClick={() => void signInWithGitHub()}
              disabled={busy}
            >
              {!usable.length && <BrandIcon brand="github" size="inline" />}
              {phase.kind === 'starting'
                ? 'Opening GitHub…'
                : usable.length
                  ? 'Sign in with another account'
                  : 'Sign in with GitHub'}
            </Button>
            {!pasting && (
              <Button size="sm" variant="ghost" onClick={() => setPasting(true)} disabled={busy}>
                Use a personal access token instead
              </Button>
            )}
          </div>
        </div>
      )}
      {signIn && !githubSignIn && provider === 'copilot' && !device && connection.deviceSignIn && (
        <div className="grid justify-items-start gap-3">
          <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
            <li>Select Sign in with GitHub, then enter the code on GitHub and approve TulipFarm.</li>
            <li>Share it with others if you like. Until you do, only you can use it.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void beginDevice()} disabled={busy}>
              <BrandIcon brand="github" size="inline" />
              {phase.kind === 'starting' ? 'Starting sign-in…' : 'Sign in with GitHub'}
            </Button>
            {!pasting && (
              <Button size="sm" variant="ghost" onClick={() => setPasting(true)} disabled={busy}>
                Use a personal access token instead
              </Button>
            )}
          </div>
        </div>
      )}
      {signIn && !device && (pasting || (provider === 'copilot' && !githubSignIn && !connection.deviceSignIn)) && (
        <form
          className="grid gap-2"
          onSubmit={event => {
            event.preventDefault();
            void connect();
          }}
        >
          {provider === 'copilot' && (
            <p className="text-sm text-muted-foreground">
              {connection.deviceSignIn || githubSignIn ? '' : 'This server can’t use GitHub sign-in. '}Create a
              fine-grained personal access token with the Copilot Requests permission, then paste it here. Classic
              tokens, which start with ghp_, don’t work.{' '}
              <ExternalLink href="https://github.com/settings/personal-access-tokens/new">
                Create a token on GitHub
              </ExternalLink>
            </p>
          )}
          <Field id={`${provider}-token`} required label={text.tokenLabel} helper={text.tokenHelper}>
            <Input
              type="password"
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder={text.placeholder}
              autoComplete="off"
              spellCheck={false}
              readOnly={phase.kind === 'connecting'}
            />
          </Field>
          <div>
            <Button size="sm" type="submit" disabled={busy}>
              {phase.kind === 'connecting' ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </form>
      )}
      {live && own && <PlanModels workspaceId={workspaceId} subscription={own} people={people} />}
      {confirming && (
        <Dialog open onOpenChange={open => !open && setConfirming(false)}>
          <DialogContent size="form">
            <DialogHeader>
              <DialogTitle>Disconnect {text.name}?</DialogTitle>
              <DialogDescription>
                {linked
                  ? `TulipFarm will stop using your ${text.name} plan, and people you shared it with will lose its models. Your GitHub connection stays.`
                  : `TulipFarm will remove your token and stop using your ${text.name} plan, and people you shared it with will lose its models.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  void disconnect();
                }}
              >
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {(sharing || asking) && own && (
        <ShareDialog
          workspaceId={workspaceId}
          subscription={own}
          people={people}
          asking={asking && !sharing}
          close={() => {
            setSharing(false);
            stopAsking();
          }}
        />
      )}
    </div>
  );
}
