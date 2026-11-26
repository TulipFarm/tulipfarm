import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { AddIcon } from '@tulipfarm/icons';
import { useChatGptPlan } from './chatgpt-plan';
import { useTokenPlan } from './token-plan';
import { PlanAccounts, maxPlanAccounts, type PlanConnector } from './plan-accounts';

type SubscriptionPanelProvider = 'chatgpt' | 'claude' | 'copilot';

export const providerDetails: Record<SubscriptionPanelProvider, { name: string; description: string }> = {
  chatgpt: {
    name: 'ChatGPT',
    description: 'Use your ChatGPT plan for chat models and Codex coding, instead of workspace credits.',
  },
  claude: {
    name: 'Claude',
    description: 'Use your Claude Pro or Max plan for chat models and Claude Code, instead of workspace credits.',
  },
  copilot: {
    name: 'GitHub Copilot',
    description: 'Use your GitHub Copilot plan for chat models and coding, instead of workspace credits.',
  },
};

/** A titled section, styled like the sections of an app's page. */
export function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything about one plan provider in one place, the same on its Integrations page and on the Models page: one
 * button connects it, and Accounts lists the member's accounts with a switch for each use.
 */
export function ProviderPanel({
  workspaceId,
  provider,
  outcome,
  clearOutcome,
  header = true,
  nested,
}: {
  workspaceId: string;
  provider: SubscriptionPanelProvider;
  outcome?: string | undefined;
  clearOutcome?: (() => void) | undefined;
  /** Shows the provider's name and logo; the Integrations page already has them. */
  header?: boolean;
  /** Inside another app's page: list only connected plans, under this title, and offer no separate connect. */
  nested?: string;
}) {
  const shown = { header, nested };
  return provider === 'chatgpt' ? (
    <ChatGptPanel workspaceId={workspaceId} outcome={outcome} clearOutcome={clearOutcome} shown={shown} />
  ) : (
    <TokenPanel workspaceId={workspaceId} provider={provider} shown={shown} />
  );
}

type Shown = { header: boolean; nested: string | undefined };

function ChatGptPanel({
  workspaceId,
  outcome,
  clearOutcome,
  shown,
}: {
  workspaceId: string;
  outcome: string | undefined;
  clearOutcome: (() => void) | undefined;
  shown: Shown;
}) {
  const connector = useChatGptPlan(workspaceId, outcome, clearOutcome);
  return <ConnectorPanel workspaceId={workspaceId} connector={connector} shown={shown} />;
}

function TokenPanel({
  workspaceId,
  provider,
  shown,
}: {
  workspaceId: string;
  provider: 'claude' | 'copilot';
  shown: Shown;
}) {
  const connector = useTokenPlan(workspaceId, provider);
  return <ConnectorPanel workspaceId={workspaceId} connector={connector} shown={shown} />;
}

function ConnectorPanel({
  workspaceId,
  connector,
  shown: { header, nested },
}: {
  workspaceId: string;
  connector: PlanConnector;
  shown: Shown;
}) {
  const { provider } = connector;
  const [others, setOthers] = useState(false);
  if (!connector.offered) return null;
  const details = providerDetails[provider as SubscriptionPanelProvider];
  const { accounts, read, message } = connector;
  const count = accounts.length;
  const ready = read.kind === 'ready';
  if (nested && (!ready || count === 0) && !connector.signingIn) return null;
  const startButton = (variant: 'default' | 'outline') => (
    <Button
      size={variant === 'default' ? 'md' : 'sm'}
      variant={variant}
      onClick={() => {
        setOthers(false);
        connector.start();
      }}
      disabled={connector.busy || connector.signingIn}
    >
      {variant === 'outline' && <AddIcon size="sm" aria-hidden="true" />}
      {variant === 'outline' ? 'Add another account' : connector.startLabel}
    </Button>
  );
  // Once accounts exist, sign-in and account messages sit in the Accounts section, by the button that caused them.
  const inline = ready && count > 0;
  const notice = message && (
    <Alert variant={message.tone === 'error' ? 'destructive' : 'default'}>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
  const othersButton = connector.others && !connector.signingIn && (
    <Button size="sm" variant="ghost" aria-expanded={others} onClick={() => setOthers(open => !open)}>
      {others ? 'Hide other ways' : provider === 'copilot' ? 'Other ways to connect Copilot' : 'Other ways to connect'}
    </Button>
  );

  return (
    <div className="grid gap-8">
      {header && (
        <header>
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-foreground">{details.name}</h2>
            <p className="max-w-prose text-sm text-muted-foreground">{details.description}</p>
          </div>
        </header>
      )}
      {((message && !inline) || read.kind === 'error' || (ready && read.stale)) && (
        <div className="grid gap-2">
          {read.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>
                Couldn’t check your {details.name} accounts. {read.message}{' '}
                <Button size="sm" variant="link" onClick={read.retry}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {ready && read.stale && (
            <Alert>
              <AlertDescription>This list may be out of date.</AlertDescription>
            </Alert>
          )}
          {!inline && notice}
        </div>
      )}
      {read.kind === 'loading' && (
        <div className="grid max-w-md gap-3">
          <Skeleton />
          <Skeleton shape="action" />
        </div>
      )}
      {ready && count === 0 && (
        <div className="grid justify-items-start gap-4">
          {count === 0 && !connector.signingIn && connector.before && (
            <div className="text-sm text-muted-foreground">{connector.before}</div>
          )}
          {connector.signingIn
            ? connector.flow
            : count === 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {startButton('default')}
                  {othersButton}
                </div>
              )}
          {count === 0 && others && !connector.signingIn && <div className="w-full">{connector.others}</div>}
        </div>
      )}
      {ready && count > 0 && (
        <PanelSection
          title={nested ?? 'Accounts'}
          action={!nested && count < maxPlanAccounts && startButton('outline')}
        >
          {notice}
          {connector.signingIn && <div className="grid justify-items-start gap-4">{connector.flow}</div>}
          <p className="max-w-prose text-sm text-muted-foreground">
            Turn on Chat or Coding for each account. If one runs out of usage, the next account that’s on takes over.
          </p>
          <PlanAccounts workspaceId={workspaceId} connector={connector} />
          {othersButton && <div>{othersButton}</div>}
          {others && !connector.signingIn && connector.others}
          {count >= maxPlanAccounts && (
            <p className="text-sm text-muted-foreground">
              You can connect up to {maxPlanAccounts} {details.name} accounts.
            </p>
          )}
        </PanelSection>
      )}
      {connector.overlay}
    </div>
  );
}
