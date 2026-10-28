import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CirclePauseIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Status } from '@tulipfarm/sprout/status';
import { consentUrl } from '@/features/atlassian/accounts';
import { useFlag } from '@/lib/feature-flags';
import { atlassianApi, atlassianError } from '@/lib/atlassian';
import { githubApi, githubConsent } from '@/lib/github';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import {
  defaultKnowledgeApi,
  defaultKnowledgeKeys,
  type DefaultKnowledgeAction,
  type DefaultKnowledgeIntent,
  type DefaultKnowledgeProduct,
} from './default-knowledge-api';
import { integrations } from './catalog';
import { connector } from './connect';
import { useAtlassianAccounts, useIntegrationChanges, useGitHubAccounts, useSlackIntegration } from './queries';
import { startSlackInstall } from './slack';
import { CommandFeedback, useCommand } from './slack-knowledge-shared';
import { KnowledgeMeter, searchablePercent } from './knowledge-meter';

type Disclosure = { name: string; scope: string; coverage: string; excluded: string; scopes: string; sources: string };
export const disclosures: Record<DefaultKnowledgeProduct, Disclosure> = {
  'google-drive': {
    name: 'Google Drive',
    scopes: 'drives and shared files',
    sources: 'the source list below',
    scope:
      'Every Drive file you can open: My Drive, shared drives and files shared with you, including files added later.',
    coverage: 'The current version of each file.',
    excluded: 'Files Google can’t export and files over size limits are skipped and listed as skipped.',
  },
  gmail: {
    name: 'Gmail',
    scopes: 'mailboxes',
    sources: 'the source list below',
    scope: 'Your mailbox, including new mail.',
    coverage: 'Mail from the last 90 days. Older mail leaves Knowledge as the window moves.',
    excluded: 'Spam and Trash. Attachments are not imported.',
  },
  slack: {
    name: 'Slack',
    scopes: 'channels',
    sources: 'the source list below',
    scope:
      'Public and private channels you’ve joined, including channels you join later. TulipFarm never joins channels for you.',
    coverage: 'Messages from the last 90 days. Older messages leave Knowledge as the window moves.',
    excluded: 'Direct and group messages stay out unless you add them yourself.',
  },
  github: {
    name: 'GitHub',
    scopes: 'repositories',
    sources: 'Repositories in Knowledge',
    scope:
      'Every repository this GitHub account can read, including new ones: docs, code, issues, pull requests, discussions and commits.',
    coverage:
      'Docs and code at the latest default-branch version, and the full default-branch commit history. Issues, pull requests and discussions active in the last 90 days.',
    excluded:
      'Other branches and diffs. Secret-like, generated, binary and oversized files are skipped and listed as skipped.',
  },
  jira: {
    name: 'Jira',
    scopes: 'projects',
    sources: 'the source list below',
    scope: 'Issues in every project you can see on each connected site, including new projects.',
    coverage: 'The current content of each issue.',
    excluded: 'Restricted comments, attachments, worklogs and change history.',
  },
  confluence: {
    name: 'Confluence',
    scopes: 'spaces',
    sources: 'the source list below',
    scope: 'Pages in every space you can see on each connected site, including new spaces.',
    coverage: 'The current version of each page.',
    excluded: 'Attachments, blog posts, whiteboards and page history.',
  },
};

const authorization = new Set([
  'not-linked',
  'reconnect-required',
  'unauthenticated',
  'insufficient-scope',
  'forbidden',
  'stale-integration',
  'consent-required',
  'account-changed',
]);
const retrying = new Set(['rate-limited', 'transient', 'provider', 'unavailable', 'invalid-cursor']);
const quota = new Set(['quota', 'resource-limited']);

type Problem = { badge: string; message: string; recovery: 'reconnect' | 'check' | 'retry' };
/** Discovery failures come first; otherwise a source-wide provider import failure is the problem to show. */
function failureOf(intent: DefaultKnowledgeIntent) {
  if (intent.syncState === 'failed' && intent.failure) return { failure: intent.failure, importing: false };
  if (intent.ingestion.state === 'failed') return { failure: intent.ingestion.failure ?? 'provider', importing: true };
  return null;
}
export function problem(intent: DefaultKnowledgeIntent, name: string, scopes: string): Problem | null {
  const found = failureOf(intent);
  if (!found) return null;
  const { failure, importing } = found;
  if (failure === 'account-changed')
    return {
      badge: 'Needs authorization',
      recovery: 'reconnect',
      message: `A different ${name} account is connected now. Sign in as ${intent.accountLabel} when you reconnect. Content already imported stays as it is.`,
    };
  if (authorization.has(failure))
    return {
      badge: 'Needs authorization',
      recovery: 'reconnect',
      message: `TulipFarm can’t reach ${name} with this account. Content already imported stays as it is.`,
    };
  if (quota.has(failure))
    return {
      badge: 'Limit reached',
      recovery: 'check',
      message:
        'Workspace Knowledge limits or credits are used up. Imported content stays searchable and new content waits. TulipFarm never buys credits or raises limits for you.',
    };
  if (importing)
    return {
      badge: 'Sync failed',
      recovery: 'retry',
      message: `${intent.ingestion.failed === 1 ? 'One source' : `${intent.ingestion.failed} sources`} stopped importing from ${name}. Content already imported is kept. Choose Retry now to try again.`,
    };
  if (retrying.has(failure))
    return {
      badge: 'Retrying',
      recovery: 'retry',
      message: `${name} is busy or unavailable. TulipFarm retries automatically at ${new Date(intent.nextAttemptAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`,
    };
  if (failure === 'scope-limit')
    return {
      badge: 'Partly imported',
      recovery: 'retry',
      message: `More than 2,000 ${scopes} were found. The rest are not imported.`,
    };
  return {
    badge: 'Sync failed',
    recovery: 'retry',
    message: 'Automatic Knowledge stopped. Content already imported is kept.',
  };
}

type Repair =
  | { kind: 'run'; label: string; run: () => Promise<void> }
  | { kind: 'link'; label: string; eventId: string }
  | { kind: 'hint'; text: string; recheck?: () => Promise<void> }
  | null;

/** The provider's own repair flow for the exact account behind an intent, or where to repair it when this person can't. */
function useRepair(workspaceId: string, product: DefaultKnowledgeProduct, accountKey: string, wanted: boolean): Repair {
  const atlassianProduct = product === 'jira' || product === 'confluence';
  const github = useGitHubAccounts(workspaceId, wanted && product === 'github');
  const atlassian = useAtlassianAccounts(workspaceId, wanted && atlassianProduct);
  const slack = useSlackIntegration(workspaceId, wanted && product === 'slack');
  if (!wanted) return null;
  if (product === 'google-drive' || product === 'gmail') {
    const app = integrations.find(item => item.id === product);
    const run = app && connector(app, workspaceId);
    return app && run ? { kind: 'run', label: `Reconnect ${app.name}`, run } : null;
  }
  if (product === 'github') {
    if (github.state.kind === 'loading') return null;
    const data = github.state.kind === 'ready' ? github.state.data : null;
    const account = data?.configured ? data.accounts.find(item => item.id === accountKey && item.identity) : undefined;
    if (account)
      return {
        kind: 'run',
        label: `Reconnect @${account.identity!.login}`,
        run: async () => githubConsent((await githubApi.reconnect(workspaceId, account.id)).url),
      };
    return {
      kind: 'hint',
      text: data
        ? 'This GitHub login is no longer connected here. Connect it again in Accounts, then choose Retry now.'
        : 'Check Accounts, reconnect this login, then choose Retry now.',
    };
  }
  if (atlassianProduct) {
    if (atlassian.state.kind === 'loading') return null;
    if (atlassian.state.kind !== 'ready')
      return {
        kind: 'hint',
        text: 'Couldn’t check Atlassian Knowledge access. Choose Check Atlassian again.',
        recheck: atlassian.refresh,
      };
    const { accounts, providers } = atlassian.state.data;
    if (!providers.some(provider => provider.protocol === 'atlassian-rest' && provider.configured))
      return {
        kind: 'hint',
        text: 'Knowledge access for Atlassian isn’t configured on this server yet. Contact your workspace admin.',
      };
    const account = accounts.find(
      item =>
        item.id === accountKey &&
        item.protocol === 'atlassian-rest' &&
        item.ownership === 'personal' &&
        item.capabilities.manage,
    );
    return {
      kind: 'run',
      label: 'Reconnect Atlassian Knowledge access',
      run: async () => {
        const value = account
          ? await atlassianApi.reconnect(workspaceId, account.id)
          : await atlassianApi.begin(workspaceId, { protocol: 'atlassian-rest', ownership: { kind: 'personal' } });
        window.location.assign(consentUrl(value.url));
      },
    };
  }
  if (slack.state.kind === 'loading') return null;
  const value = slack.state.kind === 'ready' ? slack.state.data : 'unavailable';
  if (value === 'unavailable')
    return {
      kind: 'hint',
      text: 'Couldn’t check your Slack access. Ask an integration manager to check Slack, then choose Retry now.',
    };
  if (value.recoveryEventId)
    return { kind: 'link', label: 'Reconnect my Slack account', eventId: value.recoveryEventId };
  if (value.state !== 'active' && value.canManage)
    return { kind: 'run', label: 'Reconnect Slack workspace', run: () => startSlackInstall(workspaceId) };
  if (value.state !== 'active')
    return { kind: 'hint', text: 'Ask a workspace admin to reconnect Slack, then choose Retry now.' };
  return { kind: 'hint', text: 'Message TulipFarm in Slack to link your Slack account again, then choose Retry now.' };
}

const groupFailureLabels: Record<string, string> = {
  forbidden: 'no access',
  'not-found': 'no access',
  'insufficient-scope': 'missing permission',
};

function statusBadge(intent: DefaultKnowledgeIntent, issue: Problem | null) {
  if (intent.state === 'opted-out') return <Badge variant="outline">Automatic Knowledge off</Badge>;
  if (issue) return <Badge variant={issue.badge === 'Sync failed' ? 'destructive' : 'warning'}>{issue.badge}</Badge>;
  if (intent.syncState === 'queued') return <Badge variant="secondary">Queued for indexing</Badge>;
  if (intent.syncState === 'discovering')
    return (
      <Badge variant="secondary">
        <Spinner aria-hidden="true" />
        Finding sources
      </Badge>
    );
  const { counts } = intent;
  if (counts.queued > 0 || intent.ingestion.state === 'pending')
    return <Badge variant="secondary">Queued for indexing</Badge>;
  if (counts.failed + counts.skipped + counts.quotaLimited > 0 || intent.groupFailures.length > 0)
    return <Badge variant="warning">Partly searchable</Badge>;
  return <Badge variant="success">Sync complete</Badge>;
}

export const indexing = (intent: DefaultKnowledgeIntent) =>
  intent.state === 'active' &&
  (intent.syncState === 'queued' ||
    intent.syncState === 'discovering' ||
    intent.counts.queued > 0 ||
    intent.ingestion.state === 'pending');

/** A ring that fills as items become searchable, or spins while TulipFarm is still finding them. */
function IntentMark({ intent, issue }: { intent: DefaultKnowledgeIntent; issue: Problem | null }) {
  if (intent.state === 'opted-out') return <Status state="stopped" aria-hidden="true" tooltip={false} />;
  if (issue)
    return <Status state={issue.badge === 'Sync failed' ? 'error' : 'warning'} aria-hidden="true" tooltip={false} />;
  if (indexing(intent))
    return (
      <Status
        state="running"
        value={intent.counts.total > 0 ? searchablePercent(intent.counts) : undefined}
        aria-hidden="true"
        tooltip={false}
      />
    );
  return (
    <Status
      state={
        intent.counts.failed + intent.counts.skipped + intent.counts.quotaLimited > 0 || intent.groupFailures.length
          ? 'warning'
          : 'success'
      }
      aria-hidden="true"
      tooltip={false}
    />
  );
}

/** Automatic Knowledge for one product, polled while anything is still indexing. */
export function useDefaultKnowledge(workspaceId: string) {
  const enabled = useFlag('default-connection-knowledge');
  const api = useMemo(() => defaultKnowledgeApi(workspaceId), [workspaceId]);
  const read = useFeatureRead({
    key: [...defaultKnowledgeKeys, 'list'],
    enabled,
    load: api.list,
    staleTime: 0,
    pollWhile: data => data.items.some(indexing),
    maxChecks: 20,
  });
  return { enabled: enabled && !(read.state.kind === 'ready' && !read.state.data.enabled), read };
}

function Checking() {
  return (
    <div role="status" aria-label="Checking automatic Knowledge" className="space-y-2">
      <p className="text-sm text-muted-foreground">Checking automatic Knowledge…</p>
      <Skeleton />
    </div>
  );
}

type Focus = 'confirm' | 'stop' | 'resume' | null;

function RepairAction({
  workspaceId,
  repair,
}: {
  workspaceId: string;
  repair: Exclude<Repair, { kind: 'hint' } | null>;
}) {
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const lock = useRef(false);
  // Back from the provider can restore this page from the back/forward cache with the button still opening.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        lock.current = false;
        setState('idle');
      }
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  if (repair.kind === 'link')
    return (
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link to="/slack/link" search={{ workspaceId, eventId: repair.eventId }} />}
      >
        {repair.label}
      </Button>
    );
  async function open(run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setState('opening');
    try {
      await run();
    } catch {
      setState('failed');
    } finally {
      lock.current = false;
    }
  }
  return (
    <>
      <Button
        variant="outline"
        disabled={state === 'opening'}
        aria-busy={state === 'opening'}
        onClick={() => void open(repair.run)}
      >
        {state === 'opening' && <Spinner aria-hidden="true" />}
        {repair.label}
      </Button>
      {state === 'failed' && (
        <p role="alert" className="basis-full text-sm text-destructive">
          Couldn’t open sign-in. Try again.
        </p>
      )}
    </>
  );
}

function RecheckAction({ recheck }: { recheck: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try {
      await recheck();
    } finally {
      setChecking(false);
    }
  }
  return (
    <Button variant="outline" disabled={checking} aria-busy={checking} onClick={() => void check()}>
      {checking && <Spinner aria-hidden="true" />}Check Atlassian again
    </Button>
  );
}

function IntentRow({
  workspaceId,
  intent,
  disclosure,
}: {
  workspaceId: string;
  intent: DefaultKnowledgeIntent;
  disclosure: Disclosure;
}) {
  const api = useMemo(() => defaultKnowledgeApi(workspaceId), [workspaceId]);
  const { change } = useFeatureChanges();
  const [confirm, setConfirm] = useState(false);
  // Each control unmounts when activated, so focus moves deliberately to the action that replaces it.
  const focus = useRef<Focus>(null),
    last = useRef<DefaultKnowledgeAction>('retry');
  const stopRef = useRef<HTMLButtonElement>(null),
    confirmRef = useRef<HTMLButtonElement>(null),
    resumeRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // Keep the confirmation until the refreshed row arrives, so Stop doesn't flash back before Turn back on replaces it.
  const command = useCommand(
    (action: DefaultKnowledgeAction, signal: AbortSignal) => {
      last.current = action;
      return api.manage(intent.intentId, action, signal);
    },
    async () => {
      focus.current = last.current === 'opt-out' ? 'resume' : 'stop';
      await change({ keys: [defaultKnowledgeKeys] });
      setConfirm(false);
    },
    [defaultKnowledgeKeys],
  );
  useEffect(() => {
    const target = { confirm: confirmRef, stop: stopRef, resume: resumeRef, none: null }[focus.current ?? 'none']
      ?.current;
    if (target) {
      target.focus();
      focus.current = null;
    }
  });
  const failed =
    command.state.kind === 'uncertain' || command.state.kind === 'rejected' || command.state.kind === 'denied';
  useEffect(() => {
    if (failed) feedbackRef.current?.focus();
  }, [failed]);
  const issue = problem(intent, disclosure.name, disclosure.scopes);
  const repair = useRepair(
    workspaceId,
    intent.product,
    intent.accountKey,
    intent.state === 'active' && issue?.recovery === 'reconnect',
  );
  const action = repair && repair.kind !== 'hint' ? repair : null;
  const { counts, scopes } = intent;
  const incomplete = counts.failed + counts.skipped + counts.quotaLimited > 0;
  const pending = command.state.kind === 'sending';
  return (
    <li
      aria-label={`${disclosure.name} ${intent.accountLabel}`}
      className="space-y-4 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <IntentMark intent={intent} issue={issue} />
        <p className="min-w-0 flex-1 basis-40 break-words font-medium">{intent.accountLabel}</p>
        {statusBadge(intent, issue)}
        {intent.state === 'active' && !confirm && (
          <Button
            ref={stopRef}
            variant="outline"
            size="sm"
            disabled={command.locked}
            onClick={() => {
              focus.current = 'confirm';
              setConfirm(true);
            }}
          >
            <CirclePauseIcon aria-hidden="true" />
            Stop automatic Knowledge
          </Button>
        )}
      </div>
      {intent.state === 'active' && (
        <>
          {intent.syncState === 'queued' && !counts.total && (
            <p role="status" className="text-sm text-muted-foreground">
              Queued for indexing. Your integration is ready to use now.
            </p>
          )}
          {intent.syncState === 'discovering' && (
            <p role="status" className="text-sm text-muted-foreground">
              Finding sources. Your integration is ready to use now.
            </p>
          )}
          {intent.discoveredAt && scopes.discovered > 0 && (
            <p className="text-sm text-muted-foreground">
              {scopes.included} of {scopes.discovered} {disclosure.scopes} included
              {scopes.manual ? `; ${scopes.manual} kept as your own choices` : ''}.
            </p>
          )}
          {intent.discoveredAt && !scopes.discovered && (
            <p className="text-sm text-muted-foreground">
              No {disclosure.scopes} were found for this account yet. TulipFarm keeps checking and adds new ones when
              they appear.
            </p>
          )}
          {counts.total > 0 && <KnowledgeMeter counts={counts} />}
          {intent.syncState === 'ready' && !issue && (
            <p className="text-sm text-muted-foreground">
              {intent.ingestion.state === 'pending'
                ? `Finished finding sources. ${intent.ingestion.pending === 1 ? '1 source is' : `${intent.ingestion.pending} sources are`} still importing; items become searchable as they finish.`
                : counts.queued > 0
                  ? `Finished finding sources. ${counts.queued} ${counts.queued === 1 ? 'item is' : 'items are'} still being indexed.`
                  : 'TulipFarm finished checking. Only searchable items can be found.'}
            </p>
          )}
          {intent.groupFailures.length > 0 && (
            <p className="text-sm">
              <span className="font-medium text-warning">Couldn’t read some sites:</span>{' '}
              {intent.groupFailures
                .map(group => `${group.title} (${groupFailureLabels[group.failure] ?? 'unavailable'})`)
                .join(', ')}
              . TulipFarm keeps checking them; other sites are still imported.
            </p>
          )}
        </>
      )}
      {intent.state === 'opted-out' && (
        <p className="text-sm text-muted-foreground">
          TulipFarm no longer adds new content for this account. Sources already imported keep their state; pause or
          remove them in {disclosure.sources}.
        </p>
      )}
      {issue && intent.state === 'active' && (
        <Alert role="status" variant={issue.badge === 'Sync failed' ? 'destructive' : 'default'}>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            {issue.message}
            {issue.recovery === 'reconnect' &&
              (action ? ` Choose ${action.label}, then Retry now.` : repair?.kind === 'hint' ? ` ${repair.text}` : '')}
          </AlertDescription>
        </Alert>
      )}
      {!issue && incomplete && intent.state === 'active' && (
        <Alert role="note">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            Some content is not searchable:{' '}
            {[
              counts.failed && `${counts.failed} failed`,
              counts.skipped && `${counts.skipped} skipped by import limits`,
              counts.quotaLimited && `${counts.quotaLimited} over the workspace limit`,
            ]
              .filter(Boolean)
              .join(', ')}
            . Coverage is partial.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2 empty:hidden">
        {intent.state === 'active' && issue?.recovery === 'reconnect' && action && (
          <RepairAction workspaceId={workspaceId} repair={action} />
        )}
        {intent.state === 'active' && issue?.recovery === 'reconnect' && repair?.kind === 'hint' && repair.recheck && (
          <RecheckAction recheck={repair.recheck} />
        )}
        {intent.state === 'active' && issue && (
          <Button
            variant={action ? 'ghost' : 'outline'}
            disabled={command.locked}
            aria-busy={pending}
            onClick={() => void command.send('retry')}
          >
            {issue?.recovery === 'check' ? 'Check again' : 'Retry now'}
          </Button>
        )}
        {intent.state === 'opted-out' && (
          <Button
            ref={resumeRef}
            variant="outline"
            disabled={command.locked}
            aria-busy={pending}
            onClick={() => void command.send('resume')}
          >
            Turn automatic Knowledge back on
          </Button>
        )}
      </div>
      {confirm && (
        <div className="space-y-2">
          <p id={`stop-${intent.intentId}`}>
            Stop adding new {disclosure.name} content for this account? Imported content stays until you pause or remove
            its sources in {disclosure.sources}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={confirmRef}
              variant="destructive"
              aria-describedby={`stop-${intent.intentId}`}
              disabled={command.locked}
              aria-busy={pending}
              onClick={() => void command.send('opt-out')}
            >
              Confirm stop
            </Button>
            <Button
              variant="ghost"
              disabled={command.locked}
              onClick={() => {
                focus.current = 'stop';
                setConfirm(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {pending && (
        <p role="status" className="text-sm">
          Updating automatic Knowledge…
        </p>
      )}
      <div ref={feedbackRef} tabIndex={-1} className="outline-none empty:hidden">
        <CommandFeedback state={command.state} retry={command.retry} />
      </div>
    </li>
  );
}

const atlassianScopes: Record<'jira' | 'confluence', string> = {
  jira: 'read:jira-work',
  confluence: 'read:page:confluence',
};

function AtlassianConsent({ workspaceId, product }: { workspaceId: string; product: 'jira' | 'confluence' }) {
  const read = useAtlassianAccounts(workspaceId);
  const changes = useIntegrationChanges();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string }>({
    kind: 'idle',
  });
  const lock = useRef(false);
  if (read.state.kind === 'loading') return <Checking />;
  if (read.state.kind !== 'ready')
    return (
      <StatePanel
        kind="error"
        heading="h4"
        title="Couldn’t check Atlassian Knowledge access"
        description="Jira and Confluence tools still work. Check again to see whether Knowledge access is allowed."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry Knowledge access check
        </Button>
      </StatePanel>
    );
  const stale = read.state.error && (
    <div className="space-y-2">
      <Alert variant="destructive">
        <AlertDescription>
          Couldn’t refresh Atlassian Knowledge access. The last confirmed access is shown.
        </AlertDescription>
      </Alert>
      <Button
        variant="outline"
        disabled={read.state.refreshing}
        aria-busy={read.state.refreshing}
        onClick={() => void read.refresh()}
      >
        Retry Knowledge access check
      </Button>
    </div>
  );
  const { accounts, providers } = read.state.data;
  const configured = providers.some(provider => provider.protocol === 'atlassian-rest' && provider.configured);
  const rest = accounts.filter(account => account.protocol === 'atlassian-rest' && account.ownership === 'personal');
  const active = rest.find(account => account.state === 'active');
  const sufficient = active?.scopes.includes(atlassianScopes[product]);
  if (sufficient)
    return (
      <>
        {stale}
        <p className="text-sm text-muted-foreground">
          Knowledge access is allowed for {active!.identity?.label ?? 'your Atlassian account'}. It was set up before
          automatic Knowledge, so nothing is imported automatically. Choose sources below.
        </p>
      </>
    );
  async function begin() {
    if (lock.current) return;
    lock.current = true;
    setState({ kind: 'pending' });
    try {
      const unfinished = rest.find(account => account.capabilities.manage && account.state !== 'active');
      const value = unfinished
        ? await atlassianApi.reconnect(workspaceId, unfinished.id)
        : await atlassianApi.begin(workspaceId, { protocol: 'atlassian-rest', ownership: { kind: 'personal' } });
      void changes.atlassianAccounts();
      window.location.assign(consentUrl(value.url));
    } catch (error) {
      setState({ kind: 'error', message: atlassianError(error) });
    } finally {
      lock.current = false;
    }
  }
  return (
    <div className="space-y-3">
      {stale}
      <StatePanel
        kind="unavailable"
        heading="h4"
        title="Knowledge access needed"
        description={
          active
            ? `Your Atlassian Knowledge access doesn’t include reading ${product === 'jira' ? 'Jira issues' : 'Confluence pages'}. Allow it again and approve every requested permission.`
            : 'Jira and Confluence tools use a separate Atlassian sign-in. Allow read access once so TulipFarm can import content only you can search. Your tools keep working either way.'
        }
      >
        {configured ? (
          <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void begin()}>
            {state.kind === 'pending' && <Spinner aria-hidden="true" />}
            {state.kind === 'pending' ? 'Opening Atlassian…' : 'Allow Knowledge access'}
          </Button>
        ) : (
          <p role="status">
            Knowledge access for Atlassian isn’t configured on this server yet. Contact your workspace admin.
          </p>
        )}
      </StatePanel>
      {state.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{state.message} Check integration status, then try again.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Owner-only automatic Knowledge disclosure and status for one eligible product. */
export function DefaultKnowledge({
  workspaceId,
  product,
  connected,
}: {
  workspaceId: string;
  product: DefaultKnowledgeProduct;
  connected: boolean;
}) {
  const { enabled, read } = useDefaultKnowledge(workspaceId);
  if (!enabled) return null;
  const disclosure = disclosures[product];
  const items = read.state.kind === 'ready' ? read.state.data.items.filter(intent => intent.product === product) : [];
  const atlassian = product === 'jira' || product === 'confluence' ? product : null;
  return (
    <section aria-labelledby={`default-knowledge-${product}`} className="space-y-4">
      <div className="space-y-1">
        <h2 id={`default-knowledge-${product}`} className="text-base font-semibold">
          Automatic Knowledge
        </h2>
        <p className="max-w-prose text-muted-foreground">
          When you connect, TulipFarm imports {disclosure.name} content in the background so you can search it. Existing
          integrations are not imported automatically.
        </p>
      </div>
      {read.state.kind === 'loading' && <Checking />}
      {(read.state.kind === 'error' || read.state.kind === 'unavailable') && (
        <StatePanel
          kind="error"
          heading="h4"
          title="Couldn’t check automatic Knowledge"
          description="Your integration still works. Status is hidden until it can be checked again."
        >
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry automatic Knowledge status
          </Button>
        </StatePanel>
      )}
      {read.state.kind === 'ready' && (
        <>
          {read.state.error && (
            <div className="space-y-2">
              <Alert variant="destructive">
                <AlertDescription>
                  Couldn’t refresh automatic Knowledge status. The last confirmed status is shown.
                </AlertDescription>
              </Alert>
              <Button
                variant="outline"
                disabled={read.state.refreshing}
                aria-busy={read.state.refreshing}
                onClick={() => void read.refresh()}
              >
                Retry automatic Knowledge status
              </Button>
            </div>
          )}
          {read.delayed && items.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Automatic status checks are paused. Importing continues in the background.
              </p>
              <Button
                variant="outline"
                disabled={read.state.refreshing}
                aria-busy={read.state.refreshing}
                onClick={() => void read.refresh()}
              >
                Check status again
              </Button>
            </div>
          )}
          {items.length > 0 ? (
            <ul className="space-y-3" aria-label={`Automatic ${disclosure.name} Knowledge`}>
              {items.map(intent => (
                <IntentRow key={intent.intentId} workspaceId={workspaceId} intent={intent} disclosure={disclosure} />
              ))}
            </ul>
          ) : atlassian ? (
            <AtlassianConsent workspaceId={workspaceId} product={atlassian} />
          ) : connected ? (
            <p className="text-sm text-muted-foreground">
              This integration was set up before automatic Knowledge, so nothing is imported automatically. Choose
              sources below.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Starts after you connect {disclosure.name}.</p>
          )}
        </>
      )}
      <h3 className="pt-2 text-sm font-medium text-muted-foreground">What gets imported</h3>
      <dl className="grid gap-x-4 gap-y-2 rounded-xl border border-border p-4 text-sm sm:grid-cols-4">
        <dt className="font-medium">Included</dt>
        <dd className="text-muted-foreground sm:col-span-3">{disclosure.scope}</dd>
        <dt className="font-medium">Who can search</dt>
        <dd className="text-muted-foreground sm:col-span-3">
          Only you. Sharing is a separate choice, and each person still needs their own access.
        </dd>
        <dt className="font-medium">Coverage</dt>
        <dd className="text-muted-foreground sm:col-span-3">{disclosure.coverage}</dd>
        <dt className="font-medium">Not included</dt>
        <dd className="text-muted-foreground sm:col-span-3">{disclosure.excluded}</dd>
        <dt className="font-medium">Credits</dt>
        <dd className="text-muted-foreground sm:col-span-3">
          Indexing uses workspace Knowledge credits and storage limits. Content over a limit waits and is shown as over
          limit.
        </dd>
      </dl>
    </section>
  );
}
