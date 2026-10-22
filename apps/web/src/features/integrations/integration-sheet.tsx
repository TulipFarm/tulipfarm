import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckIcon, ChevronDownIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tulipfarm/sprout/accordion';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { GradientBanner, GradientBannerPanel } from '@tulipfarm/sprout/gradient-banner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { AtlassianIntegrations } from '@/features/atlassian/integrations';
import { GoogleAccount, GoogleApprovals } from '@/features/google/integrations';
import { workspaceRoute } from '@/router';
import { googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { integrations, makerOf, providers, type Integration, type Permission } from './catalog';
import { connector } from './connect';
import { GitHubIntegrations } from './github';
import { GitHubAccounts } from './github-accounts';
import { SlackAccount, SlackIntegration } from './slack';
import { SlackBotChannels } from './slack-channels';
import type { Status } from './status';
import { WorkspaceRefreshNotice } from './workspace-refresh';
import { AtlassianKnowledgeSources } from './atlassian-knowledge';
import { GoogleKnowledgeSources } from './google-knowledge';
import { DefaultKnowledge } from './default-knowledge';
import type { DefaultKnowledgeProduct } from './default-knowledge-api';
import { useIntegrationChanges, useGoogleIntegration } from './queries';
import { useFlag } from '@/lib/feature-flags';

export type Tab = 'overview' | 'manage' | 'approvals';
export type Action =
  | { kind: 'connect' | 'settings'; label: 'Connect' | 'Reconnect' | 'Grant access' }
  | { kind: 'workflow' }
  | { kind: 'none'; hint?: string };

export function actionFor(app: Integration, status: Status | null, admin: boolean): Action {
  if (app.provider === 'soon') return { kind: 'none' };
  if (app.provider === 'workflow') return { kind: 'workflow' };
  if (!status) return { kind: 'none' };
  switch (status.kind) {
    case 'loading':
    case 'error':
      return { kind: 'none' };
    case 'unavailable':
      return { kind: 'none', hint: `${status.detail}.` };
    case 'installed':
      return { kind: 'none', hint: 'Message TulipFarm in Slack to link your account.' };
    case 'connected':
      return app.provider === 'atlassian' || app.provider === 'trello'
        ? { kind: 'none', hint: 'Pick a site or board in Your account to use it in chat.' }
        : { kind: 'none' };
    case 'off':
    case 'attention': {
      const label = status.kind === 'attention' ? 'Reconnect' : status.granted ? 'Grant access' : 'Connect';
      if (app.provider === 'github')
        return admin ? { kind: 'settings', label } : { kind: 'none', hint: 'Ask a workspace admin to connect GitHub.' };
      if (app.provider === 'slack' && status.kind === 'off' && !status.canConnect)
        return { kind: 'none', hint: 'Ask an integration manager for Slack access.' };
      return { kind: 'connect', label };
    }
  }
}

function dependency(item: Permission, granted: readonly string[] | undefined): Integration | undefined {
  if (
    !item.alsoNeeds ||
    !granted ||
    (item.scope && !granted.includes(item.scope)) ||
    googleAppScopes[item.alsoNeeds].every(scope => granted.includes(scope))
  )
    return undefined;
  return integrations.find(entry => entry.googleApp === item.alsoNeeds);
}

export function StatusBadge({ status, soon }: { status: Status | null; soon?: boolean }) {
  if (soon) return <Badge variant="outline">Coming soon</Badge>;
  if (!status) return null;
  switch (status.kind) {
    case 'loading':
      return (
        <Badge variant="secondary">
          <Spinner aria-hidden="true" />
          Checking
        </Badge>
      );
    case 'connected':
      return (
        <Badge variant="success">
          <CheckIcon aria-hidden="true" />
          Connected
        </Badge>
      );
    case 'installed':
      return <Badge variant="secondary">Installed</Badge>;
    case 'attention':
      return <Badge variant="warning">Needs attention</Badge>;
    case 'off':
      return status.granted ? <Badge variant="outline">Not granted</Badge> : null;
    case 'unavailable':
      return <Badge variant="outline">Unavailable</Badge>;
    case 'error':
      return <Badge variant="destructive">Couldn’t check</Badge>;
  }
}

const defaultKnowledgeProducts: Partial<Record<string, DefaultKnowledgeProduct>> = {
  'google-drive': 'google-drive',
  gmail: 'gmail',
  slack: 'slack',
  'github-personal': 'github',
  jira: 'jira',
  confluence: 'confluence',
};

const tones = ['aurora', 'citrus', 'lagoon', 'iris', 'mint', 'cobalt'] as const;
const toneStart = (id: string) => [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);

const personal = new Set<Integration['provider']>(['google', 'slack', 'github-personal', 'atlassian', 'trello']);
const administered = new Set<Integration['provider']>(['slack', 'github']);

function Account({ app, workspaceId, onChanged }: { app: Integration; workspaceId: string; onChanged: () => void }) {
  return (
    <div className="space-y-6">
      {app.provider === 'google' && (app.id === 'google-drive' || app.id === 'gmail') && (
        <GoogleKnowledge workspaceId={workspaceId} gmail={app.id === 'gmail'} />
      )}
      {app.provider === 'google' && <GoogleApprovals workspaceId={workspaceId} />}
      {app.provider === 'slack' && <SlackAccount workspaceId={workspaceId} />}
      {app.provider === 'github-personal' && <GitHubAccounts workspaceId={workspaceId} onChanged={onChanged} />}
      {(app.provider === 'atlassian' || app.provider === 'trello') && (
        <AtlassianIntegrations
          workspaceId={workspaceId}
          product={app.provider === 'trello' ? 'trello' : app.id === 'confluence' ? 'confluence' : 'jira'}
        />
      )}
      {app.provider === 'atlassian' && (app.id === 'jira' || app.id === 'confluence') && (
        <AtlassianKnowledgeSources workspaceId={workspaceId} product={app.id} />
      )}
    </div>
  );
}

function Settings({
  app,
  status,
  workspaceId,
  slug,
  onChanged,
}: {
  app: Integration;
  status: Status | null;
  workspaceId: string;
  slug: string;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-6">
      {app.provider === 'slack' && <SlackIntegration workspaceId={workspaceId} />}
      {app.provider === 'slack' && (status?.kind === 'connected' || status?.kind === 'installed') && (
        <SlackBotChannels workspaceId={workspaceId} />
      )}
      {app.provider === 'github' && <GitHubIntegrations workspaceId={workspaceId} onChanged={onChanged} />}
      {app.workflowProvider && (
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug/workflows"
              params={{ workspaceSlug: slug }}
              search={{ provider: app.workflowProvider }}
              hash="provider-setup"
            />
          }
        >
          Start workflows from {app.name}
        </Button>
      )}
    </div>
  );
}

function Panel({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    <section className="border-t border-border px-6 pt-4" aria-label={label}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="-ml-2.5">
          <CollapsibleTrigger render={<Button variant="ghost" />}>
            {label}
            <ChevronDownIcon aria-hidden="true" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent keepMounted>
          <div className="pt-4">{seen && children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

const driveKinds = ['drive-folder', 'shared-drive'] as const;
const gmailKinds = ['gmail'] as const;
function GoogleKnowledge({ workspaceId, gmail }: { workspaceId: string; gmail: boolean }) {
  const read = useGoogleIntegration(workspaceId);
  if (read.data?.status.status !== 'connected') return null;
  return <GoogleKnowledgeSources workspaceId={workspaceId} kinds={gmail ? gmailKinds : driveKinds} />;
}

export function IntegrationSheet({
  app,
  status,
  tab,
  workspaceId,
  slug,
  onClose,
  onChanged,
}: {
  app: Integration | null;
  status: Status | null;
  tab: Tab;
  workspaceId: string;
  slug: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Sheet
      open={!!app}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent size="xl" initialFocus={app?.provider === 'github-personal' ? titleRef : undefined}>
        {app && (
          <Body
            key={app.id}
            app={app}
            status={status}
            tab={tab}
            workspaceId={workspaceId}
            slug={slug}
            onChanged={onChanged}
            titleRef={titleRef}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Body({
  app,
  status,
  tab,
  workspaceId,
  slug,
  onChanged,
  titleRef,
}: {
  app: Integration;
  status: Status | null;
  tab: Tab;
  workspaceId: string;
  slug: string;
  onChanged: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { workspaceStale, membership } = workspaceRoute.useRouteContext();
  const admin = membership?.role === 'admin';
  const changes = useIntegrationChanges();
  const automatic = useFlag('default-connection-knowledge');
  const [account, setAccount] = useState(tab !== 'overview');
  const [settings, openSettings] = useState(admin && tab === 'manage');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [githubFooter, setGitHubFooter] = useState<HTMLFieldSetElement | null>(null);
  const soon = app.provider === 'soon';
  const info = app.provider === 'soon' ? null : providers[app.provider];
  const action = actionFor(app, status, admin);
  const detail = status?.kind === 'connected' || status?.kind === 'attention' ? status.detail : null;
  const granted = status?.kind === 'connected' || status?.kind === 'off' ? status.granted : undefined;
  const accessLost = app.provider === 'google' && status?.kind === 'error' && status.accessLost;
  const lock = useRef(false);
  const start = async (target: Integration = app) => {
    const run = connector(target, workspaceId);
    if (!run || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(false);
    try {
      await run();
      if (app.provider === 'google' || app.provider === 'slack') await changes.authority(app.provider);
    } catch {
      setFailure(true);
      setBusy(false);
      lock.current = false;
    }
  };
  const primary =
    action.kind === 'connect' ? (
      <Button disabled={busy} aria-busy={busy} aria-label={`${action.label} ${app.name}`} onClick={() => void start()}>
        {busy && <Spinner aria-hidden="true" />}
        {action.label}
      </Button>
    ) : action.kind === 'settings' ? (
      <Button aria-label={`${action.label} ${app.name}`} onClick={() => openSettings(true)}>
        {action.label}
      </Button>
    ) : action.kind === 'workflow' ? (
      <Button
        nativeButton={false}
        render={
          <Link
            to="/$workspaceSlug/workflows"
            params={{ workspaceSlug: slug }}
            search={{ provider: app.workflowProvider }}
            hash="provider-setup"
          />
        }
      >
        Set up
      </Button>
    ) : soon ? (
      <Button disabled>Coming soon</Button>
    ) : null;
  const start0 = toneStart(app.id);
  const hint = action.kind === 'none' ? action.hint : undefined;
  const prompts = app.prompts.length > 0 && (
    <section
      aria-label={`Things to ask with ${app.name}`}
      className={app.provider === 'github-personal' ? 'pt-2 pb-4' : 'pt-2 pb-8'}
    >
      <ul className="flex snap-x snap-mandatory scroll-px-6 gap-4 overflow-x-auto px-6 scrollbar-none">
        {app.prompts.map((prompt, index) => (
          <li key={prompt} className="w-64 shrink-0 snap-start">
            <GradientBanner variant={tones[(start0 + index) % tones.length]!} size="md">
              <GradientBannerPanel>
                <BrandIcon brand={app.brand} size="glyph" />
                <span>{prompt}</span>
              </GradientBannerPanel>
            </GradientBanner>
          </li>
        ))}
      </ul>
    </section>
  );
  if (app.provider === 'github-personal')
    return (
      <>
        <div className="flex h-13 shrink-0 items-center gap-3 border-b px-4 pr-14 sm:px-6">
          <BrandIcon brand="github" size="sm" />
          <SheetTitle ref={titleRef} tabIndex={-1}>
            GitHub
          </SheetTitle>
          <div className="sr-only">
            <SheetDescription>Connect your GitHub account and import repositories into Knowledge.</SheetDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-github-scroll>
          <fieldset disabled={workspaceStale} className="min-w-0 space-y-4 px-4 py-4 sm:px-6">
            <WorkspaceRefreshNotice />
            <div className="-mx-4 sm:-mx-6">{prompts}</div>
            <div className="border-b pb-4 empty:hidden">
              <DefaultKnowledge workspaceId={workspaceId} product="github" connected={status?.kind === 'connected'} />
            </div>
            <GitHubAccounts workspaceId={workspaceId} onChanged={onChanged} footerTarget={githubFooter} />
            <div className="border-t pt-4">
              <Accordion>
                <AccordionItem>
                  <AccordionTrigger>About this integration</AccordionTrigger>
                  <AccordionContent>
                    <div className="max-w-prose space-y-3 pt-3 text-muted-foreground">
                      <p>
                        Ask about repositories, issues and pull requests in your personal chats. Supported changes need
                        your approval.
                      </p>
                      <p>
                        Your integration is private to you. Workspace admins cannot use it.{' '}
                        {automatic
                          ? 'New integrations import content only you can search; see Automatic Knowledge.'
                          : 'Importing content into Knowledge is a separate choice below your connected account.'}
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </fieldset>
        </div>
        <fieldset
          ref={setGitHubFooter}
          disabled={workspaceStale}
          aria-label="Repository selection actions"
          className="shrink-0 border-t bg-popover px-4 pb-4 empty:hidden sm:px-6"
        />
      </>
    );
  return (
    <>
      <div className="flex h-13 shrink-0 items-center gap-1.5 border-b border-border px-6 pr-14 text-muted-foreground">
        <span>Integrations</span>
        <span aria-hidden="true">/</span>
        <span className="truncate text-foreground">{app.name}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-4 px-2 pt-4">
            <BrandIcon brand={app.brand} size="xl" />
            <div className="min-w-0 flex-1">
              <SheetTitle size="lg">{app.name}</SheetTitle>
              <p className="truncate text-muted-foreground">{detail ?? `By ${makerOf(app)}`}</p>
            </div>
            {primary && <div className="shrink-0">{primary}</div>}
          </div>
          <div className="flex flex-wrap gap-2 px-2 pt-5">
            <StatusBadge status={status} soon={soon} />
            <Badge variant="outline">{app.category}</Badge>
          </div>
          <div className="px-2 pt-3">
            <SheetDescription>{app.blurb}</SheetDescription>
          </div>
          <WorkspaceRefreshNotice />
        </SheetHeader>
        <fieldset disabled={workspaceStale} className="flex min-w-0 flex-col pb-6">
          {(hint || failure || status?.kind === 'error') && (
            <div className="space-y-2 px-6 pb-4">
              {hint && <p className="text-muted-foreground">{hint}</p>}
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>Could not start {app.name}. Try again.</AlertDescription>
                </Alert>
              )}
              {status?.kind === 'error' && (
                <>
                  <Alert variant="destructive">
                    <AlertDescription>{status.detail}</AlertDescription>
                  </Alert>
                  <Button variant="outline" onClick={onChanged}>
                    Check app status again
                  </Button>
                </>
              )}
            </div>
          )}
          {prompts}
          {app.provider === 'google' && !accessLost && (
            <div className="px-6 pb-6 empty:hidden">
              <GoogleAccount workspaceId={workspaceId} />
            </div>
          )}
          {info && (
            <section className="space-y-3 border-t border-border px-6 py-6" aria-labelledby="sheet-can">
              <h3 id="sheet-can" className="text-base font-semibold">
                What it can do
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {[...(app.can ?? []), ...info.can].map(item => (
                  <li key={item.text} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5">
                    <span>{item.text}</span>
                    {item.scope && granted && !granted.includes(item.scope) ? (
                      <Badge variant="outline">Not granted</Badge>
                    ) : dependency(item, granted) ? (
                      <Badge variant="outline">Needs {dependency(item, granted)!.name}</Badge>
                    ) : (
                      item.asksFirst && (
                        <Badge variant="info">
                          <ShieldCheckIcon aria-hidden="true" />
                          Asks first
                        </Badge>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {status?.kind === 'connected' &&
                [
                  ...new Set(
                    (app.can ?? []).map(item => dependency(item, granted)).filter(value => value !== undefined),
                  ),
                ].map(needed => (
                  <div key={needed.id} className="space-y-2">
                    <p>
                      {needed.id === 'google-drive'
                        ? 'Changing spreadsheets also needs Google Drive access. TulipFarm checks the spreadsheet’s Drive version before each change so it never overwrites edits made after your approval.'
                        : `This also needs ${needed.name} access.`}
                    </p>
                    <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => void start(needed)}>
                      Grant {needed.name} access
                    </Button>
                  </div>
                ))}
              <p className="flex items-center gap-2 text-muted-foreground">
                <UsersIcon aria-hidden="true" className="size-4 shrink-0" />
                {info.audience}
              </p>
            </section>
          )}
          {!accessLost && defaultKnowledgeProducts[app.id] && (
            <div className="border-t border-border px-6 py-6 empty:hidden">
              <DefaultKnowledge
                workspaceId={workspaceId}
                product={defaultKnowledgeProducts[app.id]!}
                connected={
                  status?.kind === 'connected' &&
                  (app.provider !== 'google' || !app.can?.[0]?.scope || !!granted?.includes(app.can[0].scope))
                }
              />
            </div>
          )}
          {!accessLost && personal.has(app.provider) && (
            <Panel label="Your account" open={account} onOpenChange={setAccount}>
              <Account app={app} workspaceId={workspaceId} onChanged={onChanged} />
            </Panel>
          )}
          {!accessLost &&
            admin &&
            !soon &&
            app.provider !== 'workflow' &&
            (administered.has(app.provider) || !!app.workflowProvider) && (
              <Panel label="Settings" open={settings} onOpenChange={openSettings}>
                <Settings app={app} status={status} workspaceId={workspaceId} slug={slug} onChanged={onChanged} />
              </Panel>
            )}
        </fieldset>
      </div>
    </>
  );
}
