import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@tulipfarm/sprout/alert';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { ArrowUpRightIcon, CheckIcon } from '@tulipfarm/icons';
import { useFeatureChanges } from '@/lib/query';
import { githubApi, githubConsent, githubError } from '@/lib/github';
import { startGitHub } from '@/features/integrations/connect';
import { integrationKeys, useGitHubAccounts } from '@/features/integrations/queries';
import { planUsageUrls } from '@/features/chat/reply-failure-copy';
import { TableRequestError } from '@/features/tables/request-state';
import {
  tokenPlanApi,
  tokenPlanErrorMessage,
  type ClaudeSignIn as ClaudeSignInStart,
  type DeviceSignIn,
  type TokenPlanProvider,
} from './token-plan-api';
import { modelKeys } from './queries';
import { tokenConnectionKey, useTokenConnection } from './plan-connections';
import { accountLabel, useOwnPlans, type PlanAccount, type PlanConnector } from './plan-accounts';
import { expectNewPlan, subscriptionsKey } from './subscription-sharing';

const copy = {
  claude: {
    name: 'Claude',
    tokenLabel: 'Paste the token Claude Code printed',
    tokenHelper: 'It starts with sk-ant-oat.',
    placeholder: 'sk-ant-oat…',
  },
  copilot: {
    name: 'GitHub Copilot',
    tokenLabel: 'Personal access token',
    tokenHelper: 'It starts with github_pat_ and needs the Copilot Requests permission.',
    placeholder: 'github_pat_…',
  },
} as const;

type Phase =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'starting' }
  | { kind: 'choosing' }
  | { kind: 'token' }
  | { kind: 'linking'; accountId: string }
  | { kind: 'device'; device: DeviceSignIn; deadline: number }
  | { kind: 'claude'; signIn: ClaudeSignInStart; opened: boolean; finishing: boolean }
  | { kind: 'disconnecting' };

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
      {copied ? <CheckIcon size="sm" aria-hidden="true" /> : null}
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
      <ArrowUpRightIcon size="xs" aria-hidden="true" />
    </a>
  );
}

/**
 * Sign-in for the member's own Claude or GitHub Copilot accounts, up to five. Claude connects with Sign in with Claude,
 * which ends on a Claude page showing a code to paste back, or with a token from `claude setup-token`. Copilot
 * connects with a personal GitHub login, by signing in with GitHub on a code page, or with a pasted token.
 */
export function useTokenPlan(workspaceId: string, provider: TokenPlanProvider): PlanConnector {
  const text = copy[provider];
  const api = useMemo(() => tokenPlanApi(workspaceId, provider), [workspaceId, provider]);
  const read = useTokenConnection(workspaceId, provider);
  // Copilot shares the member's personal GitHub sign-in, so it offers the logins they already connected.
  const githubAccounts = useGitHubAccounts(workspaceId, provider === 'copilot');
  const owns = useOwnPlans(workspaceId, provider);
  const { change } = useFeatureChanges();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [message, setMessage] = useState<PlanConnector['message']>(null);
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  // The account a token, device code or Claude sign-in renews, if any.
  const [reconnecting, setReconnecting] = useState<PlanAccount | null>(null);
  const refreshAll = useCallback(
    () =>
      change({
        keys: [
          tokenConnectionKey(provider),
          subscriptionsKey,
          modelKeys.catalog(),
          integrationKeys.accounts('github-personal'),
        ],
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
  const connected = useCallback(
    (login?: string) => {
      setReconnecting(null);
      setMessage({ tone: 'success', text: `${text.name} is connected${login ? ` with @${login}` : ''}.` });
      void refreshAll();
    },
    [refreshAll, text.name],
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
            if (result.status === 'completed') connected();
            else setMessage({ tone: 'error', text: tokenPlanErrorMessage(provider, result.errorCode) });
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
  }, [api, device, deadline, provider, connected]);

  function expectNew(renewing: PlanAccount | null) {
    if (!renewing) expectNewPlan(workspaceId, provider, owns);
  }

  async function connectToken() {
    const value = token.replace(/\s+/g, '');
    if (!value) {
      setMessage({ tone: 'error', text: tokenPlanErrorMessage(provider, 'token-invalid') });
      return;
    }
    expectNew(reconnecting);
    setPhase({ kind: 'connecting' });
    setMessage(null);
    try {
      await api.connectToken(value, reconnecting?.connectionId, freshSignal());
      setToken('');
      setPhase({ kind: 'idle' });
      connected();
    } catch (error) {
      setPhase({ kind: 'token' });
      fail(error);
    }
  }

  /** Opens Claude's sign-in in a new tab; the panel keeps the field for the code Claude shows. */
  async function beginClaude(renewing: PlanAccount | null) {
    expectNew(renewing);
    setReconnecting(renewing);
    setMessage(null);
    setCode('');
    // Open the tab during the click so the browser does not block it, then point it at Claude.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setPhase({ kind: 'starting' });
    try {
      const started = await api.beginSignIn(renewing?.connectionId, freshSignal());
      if (tab && !tab.closed) tab.location.href = started.authorizeUrl;
      setPhase({ kind: 'claude', signIn: started, opened: !!tab, finishing: false });
    } catch (error) {
      tab?.close();
      setPhase({ kind: 'idle' });
      fail(error);
    }
  }

  async function completeClaude() {
    if (phase.kind !== 'claude') return;
    const value = code.trim();
    if (!value) {
      setMessage({ tone: 'error', text: tokenPlanErrorMessage(provider, 'code-invalid') });
      return;
    }
    setPhase({ ...phase, finishing: true });
    setMessage(null);
    try {
      await api.completeSignIn(value, freshSignal());
      setCode('');
      setPhase({ kind: 'idle' });
      connected();
    } catch (error) {
      const failed = error instanceof TableRequestError ? error.code : 'unavailable';
      // A wrong paste keeps the sign-in open; a used or expired code needs a new sign-in.
      setPhase(
        failed === 'code-invalid' || failed === 'unavailable' ? { ...phase, finishing: false } : { kind: 'idle' },
      );
      fail(error);
    }
  }

  async function beginDevice(renewing: PlanAccount | null) {
    expectNew(renewing);
    setReconnecting(renewing);
    setPhase({ kind: 'starting' });
    setMessage(null);
    try {
      const started = await api.beginDevice(renewing?.connectionId, freshSignal());
      setPhase({ kind: 'device', device: started, deadline: Date.now() + started.expiresInSeconds * 1000 });
    } catch (error) {
      setPhase({ kind: 'idle' });
      fail(error);
    }
  }

  async function connectWithAccount(accountId: string, login: string) {
    expectNew(null);
    setPhase({ kind: 'linking', accountId });
    setMessage(null);
    try {
      await api.useGitHubAccount(accountId, freshSignal());
      setPhase({ kind: 'idle' });
      connected(login);
    } catch (error) {
      setPhase({ kind: 'choosing' });
      if (error instanceof TableRequestError && error.code === 'not-eligible')
        setMessage({ tone: 'error', text: `@${login} has no GitHub Copilot plan.` });
      else fail(error);
    }
  }

  /** Signs in through the personal GitHub connection; coming back connects Copilot with the same login. */
  async function signInWithGitHub(accountId?: string) {
    if (!accountId) expectNew(null);
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

  async function disconnect(account: PlanAccount) {
    setPhase({ kind: 'disconnecting' });
    setMessage(null);
    try {
      await api.disconnect(account.connectionId, freshSignal());
      setMessage({ tone: 'success', text: `${accountLabel(provider, account.account)} is disconnected.` });
      void refreshAll();
    } catch (error) {
      fail(error);
    } finally {
      setPhase({ kind: 'idle' });
    }
  }

  const { state } = read;
  const data = state.kind === 'ready' ? state.data : null;
  const connections = data?.connections ?? [];
  const linkedTo = new Map(
    connections.flatMap(item => (item.githubAccountId ? [[item.connectionId, item.githubAccountId]] : [])),
  );
  const accounts = connections.flatMap((connection): PlanAccount[] =>
    connection.state === 'connected' || connection.state === 'reconnect-required'
      ? [
          {
            connectionId: connection.connectionId,
            state: connection.state,
            account: connection.account,
            ...(connection.state === 'reconnect-required'
              ? {
                  note: connection.githubAccountId
                    ? 'Your GitHub sign-in needs renewing. Reconnecting fixes GitHub and Copilot together.'
                    : tokenPlanErrorMessage(provider, 'reconnect-required'),
                }
              : {}),
          },
        ]
      : [],
  );
  const github = githubAccounts.state.kind === 'ready' ? githubAccounts.state.data : null;
  // The web sign-in through the personal GitHub connection replaces the device code when this server offers it.
  const githubSignIn = provider === 'copilot' && !!github?.configured;
  const deviceSignIn = provider === 'copilot' && !!data?.deviceSignIn;
  const taken = new Set(
    connections.flatMap(item =>
      item.githubAccountId && item.state !== 'signed-out' && item.state !== 'not-connected'
        ? [item.githubAccountId]
        : [],
    ),
  );
  // Each personal GitHub login can become its own Copilot account.
  const usable = (github?.accounts ?? []).flatMap(account =>
    account.state === 'active' && account.identity && !taken.has(account.id)
      ? [{ id: account.id, login: account.identity.login }]
      : [],
  );
  const busy =
    phase.kind === 'connecting' ||
    phase.kind === 'starting' ||
    phase.kind === 'linking' ||
    phase.kind === 'disconnecting' ||
    (phase.kind === 'claude' && phase.finishing);
  const cancel = () => {
    setReconnecting(null);
    setPhase({ kind: 'idle' });
    setMessage(null);
  };
  const cancelButton = (
    <Button size="sm" variant="ghost" type="button" onClick={cancel} disabled={busy}>
      Cancel
    </Button>
  );

  function start() {
    setMessage(null);
    setReconnecting(null);
    if (provider === 'claude') void beginClaude(null);
    else if (githubSignIn) {
      if (usable.length) setPhase({ kind: 'choosing' });
      else void signInWithGitHub();
    } else if (deviceSignIn) void beginDevice(null);
    else setPhase({ kind: 'token' });
  }

  function reconnect(account: PlanAccount) {
    setMessage(null);
    const linked = linkedTo.get(account.connectionId);
    if (provider === 'claude') void beginClaude(account);
    else if (linked && githubSignIn) void signInWithGitHub(linked);
    else if (deviceSignIn) void beginDevice(account);
    else {
      setReconnecting(account);
      setPhase({ kind: 'token' });
    }
  }

  const tokenForm = (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={event => {
        event.preventDefault();
        void connectToken();
      }}
    >
      {reconnecting && (
        <p className="text-sm font-medium">Reconnect {accountLabel(provider, reconnecting.account)} with a new token</p>
      )}
      {provider === 'copilot' && (
        <p className="text-sm text-muted-foreground">
          Create a fine-grained personal access token with the Copilot Requests permission, then paste it here. Classic
          tokens, which start with ghp_, don’t work.{' '}
          <ExternalLink href="https://github.com/settings/personal-access-tokens/new">
            Create a token on GitHub
          </ExternalLink>
        </p>
      )}
      {provider === 'claude' && (
        <ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground">
          <li>
            <ExternalLink href="https://docs.claude.com/en/docs/claude-code/setup">Install Claude Code</ExternalLink> if
            you don’t have it.
          </li>
          <li className="grid gap-1.5">
            <span>In a terminal, run this and sign in with your Claude account:</span>
            <span className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">claude setup-token</code>
              <CopyButton value="claude setup-token" label="Copy" />
            </span>
          </li>
          <li>Paste the token it prints below, then select Connect.</li>
        </ol>
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
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {phase.kind === 'connecting' ? 'Connecting…' : 'Connect'}
        </Button>
        {(phase.kind === 'token' || reconnecting) && cancelButton}
      </div>
    </form>
  );

  const deviceSteps = device && (
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
          <ArrowUpRightIcon size="sm" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Waiting for you to approve on GitHub…</p>
        {cancelButton}
      </div>
    </div>
  );

  const choosing = (phase.kind === 'choosing' || phase.kind === 'linking') && (
    <div className="grid justify-items-start gap-3">
      <p className="text-sm text-muted-foreground">Pick a GitHub login with a Copilot plan, or sign in with another.</p>
      <div className="flex flex-wrap items-center gap-2">
        {usable.map(account => (
          <Button
            key={account.id}
            size="sm"
            variant="outline"
            onClick={() => void connectWithAccount(account.id, account.login)}
            disabled={busy}
          >
            <BrandIcon brand="github" size="inline" />
            {phase.kind === 'linking' && phase.accountId === account.id
              ? `Checking @${account.login}…`
              : `Use @${account.login}`}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => void signInWithGitHub()} disabled={busy}>
          Sign in with another login
        </Button>
        {cancelButton}
      </div>
    </div>
  );

  const claudeSteps = phase.kind === 'claude' && (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={event => {
        event.preventDefault();
        void completeClaude();
      }}
    >
      <p role="status" className="text-sm">
        Approve TulipFarm in the Claude tab, then copy the code Claude shows and paste it here.
      </p>
      {!phase.opened && (
        <p className="text-sm text-muted-foreground">
          Your browser blocked the new tab.{' '}
          <ExternalLink href={phase.signIn.authorizeUrl}>Open Claude sign-in</ExternalLink>
        </p>
      )}
      <Field id="claude-code" required label="Code from Claude">
        <Input
          value={code}
          onChange={event => setCode(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          readOnly={phase.finishing}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={phase.finishing}>
          {phase.finishing ? 'Finishing…' : 'Finish sign-in'}
        </Button>
        {cancelButton}
      </div>
    </form>
  );

  const flow =
    claudeSteps ||
    deviceSteps ||
    choosing ||
    (phase.kind === 'token' || (phase.kind === 'connecting' && !!reconnecting) ? tokenForm : null);
  const signingIn = !!flow;

  const others =
    provider === 'claude' ? (
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">Connect with a token from Claude Code instead of signing in.</p>
        {tokenForm}
      </div>
    ) : githubSignIn || deviceSignIn ? (
      <div className="grid gap-4">
        {githubSignIn && deviceSignIn && (
          <div className="grid justify-items-start gap-2">
            <p className="text-sm text-muted-foreground">
              Sign in on GitHub with a one-time code. This connects Copilot only, not your GitHub repositories.
            </p>
            <Button size="sm" variant="outline" onClick={() => void beginDevice(null)} disabled={busy || signingIn}>
              <BrandIcon brand="github" size="inline" />
              Use a code on GitHub
            </Button>
          </div>
        )}
        {tokenForm}
      </div>
    ) : undefined;

  return {
    provider,
    offered: !(state.kind === 'unavailable' || (state.kind === 'ready' && data === null)),
    read:
      state.kind === 'loading'
        ? { kind: 'loading' }
        : state.kind === 'error'
          ? { kind: 'error', message: state.message, retry: () => void read.refresh() }
          : { kind: 'ready', stale: state.kind === 'ready' && !!state.error },
    accounts,
    message,
    busy,
    signingIn,
    start,
    startLabel:
      phase.kind === 'starting'
        ? provider === 'claude'
          ? 'Opening Claude…'
          : 'Opening GitHub…'
        : provider === 'claude'
          ? 'Connect Claude'
          : 'Connect GitHub Copilot',
    before:
      provider === 'claude' ? (
        <div className="grid gap-3">
          <Alert>
            <AlertTitle>Check Anthropic’s terms</AlertTitle>
            <AlertDescription>
              Anthropic’s consumer terms may not allow a Claude Pro or Max plan to be used in other apps. If you connect
              it, you’re responsible for following those terms. Anthropic API keys are the supported option, and they’re
              coming soon to TulipFarm.
            </AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            Claude opens in a new tab. Approve TulipFarm there, then copy the code Claude shows and paste it here.
          </p>
        </div>
      ) : githubSignIn ? (
        'Sign in with GitHub. If your login has a Copilot plan, Copilot connects too.'
      ) : undefined,
    flow,
    others,
    reconnect,
    disconnect,
    disconnectDescription: account =>
      linkedTo.has(account.connectionId)
        ? `TulipFarm will stop using this ${text.name} plan, and people you shared it with will lose its models. Your GitHub connection stays.`
        : `TulipFarm will remove this sign-in and stop using this ${text.name} plan, and people you shared it with will lose its models.`,
    usageUrl: planUsageUrls[provider],
  };
}

/**
 * Copilot needs no separate account: picking a GitHub login for a Copilot use turns that login into a Copilot account.
 * Returns the Copilot connection the login became.
 */
export async function copilotFromGitHub(workspaceId: string, accountId: string, signal: AbortSignal) {
  const result = await tokenPlanApi(workspaceId, 'copilot').useGitHubAccount(accountId, signal);
  return result.connections.find(item => item.githubAccountId === accountId) ?? null;
}
