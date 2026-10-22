import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { workspaceRoute } from '@/router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { DriveAccess } from './google-api';

export type GoogleRecovery =
  | Exclude<DriveAccess, { kind: 'ready' | 'loading' | 'grant' | 'reconnect' }>
  | { kind: 'reconnect'; email?: string }
  | { kind: 'grant'; app: 'drive' | 'sheets'; email?: string };

/** A capacity refusal: the read was valid, and the same request succeeds once earlier reads for this integration finish. */
export function GoogleBusyPanel({ heading = 'h2', children }: { heading?: 'h1' | 'h2' | 'h3'; children: ReactNode }) {
  return (
    <StatePanel
      kind="error"
      heading={heading}
      title="Google is busy right now"
      description="Several Google reads are already running for your integration. Try again in a few seconds. Nothing in Google changed."
    >
      {children}
    </StatePanel>
  );
}

function DriveGlyph() {
  return <BrandIcon brand="google-drive" size="glyph" />;
}

export function GoogleRecoveryPanel({
  recovery,
  connect,
  retry,
  heading = 'h2',
}: {
  recovery: GoogleRecovery;
  connect: (app: 'drive' | 'sheets') => Promise<void>;
  retry: () => Promise<unknown>;
  heading?: 'h1' | 'h2' | 'h3';
}) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const busy = state === 'busy';
  const start = (app: 'drive' | 'sheets') => {
    setState('busy');
    connect(app).catch(() => setState('failed'));
  };
  const action = (label: string, app: 'drive' | 'sheets') => (
    <Button disabled={busy} aria-busy={busy} onClick={() => start(app)}>
      {busy ? 'Opening Google…' : label}
    </Button>
  );
  const failed = state === 'failed' && (
    <Alert variant="destructive">
      <AlertDescription>Google sign-in couldn’t start. Check your connection, then try again.</AlertDescription>
    </Alert>
  );
  const forAccount = (email?: string) => (email ? ` for ${email}` : '');
  switch (recovery.kind) {
    case 'disconnected':
      return (
        <>
          <StatePanel
            kind="empty"
            heading={heading}
            icon={DriveGlyph}
            title="Connect Google Drive"
            description="Browse and open your Drive files here. Files stay in Google. TulipFarm reads a file only when you open it."
          >
            {action('Connect Google Drive', 'drive')}
          </StatePanel>
          {failed}
        </>
      );
    case 'reconnect':
      return (
        <>
          <StatePanel
            kind="unavailable"
            heading={heading}
            icon={DriveGlyph}
            title="Reconnect Google Drive"
            description={`Google access${forAccount(recovery.email)} expired or changed. Reconnect to keep browsing your Drive. Files from the previous integration stay hidden.`}
          >
            {action('Reconnect Google', 'drive')}
          </StatePanel>
          {failed}
        </>
      );
    case 'grant':
      return (
        <>
          <StatePanel
            kind="unavailable"
            heading={heading}
            icon={DriveGlyph}
            title={recovery.app === 'drive' ? 'Allow Google Drive access' : 'Allow Google Sheets access'}
            description={
              recovery.app === 'drive'
                ? `Your Google integration${forAccount(recovery.email)} doesn’t include Drive. Access to Docs or Sheets alone can’t list Drive files.`
                : `Reading sheet tabs and cells needs Google Sheets access${forAccount(recovery.email)}. Drive access alone can’t read cell values.`
            }
          >
            {action(recovery.app === 'drive' ? 'Grant Drive access' : 'Grant Sheets access', recovery.app)}
          </StatePanel>
          {failed}
        </>
      );
    case 'not-configured':
      return (
        <StatePanel
          kind="unavailable"
          heading={heading}
          icon={DriveGlyph}
          title="Google isn’t set up on this server"
          description="Ask the person who runs TulipFarm to configure Google Workspace. Your Google files are unaffected."
        >
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug }} />}
          >
            Open Integrations
          </Button>
        </StatePanel>
      );
    case 'unavailable':
      return (
        <StatePanel
          kind="unavailable"
          heading={heading}
          title="Google Drive is unavailable"
          description="Your workspace access changed. Google files stay hidden until access is confirmed."
        >
          <Button
            variant="outline"
            nativeButton={false}
            role="link"
            render={<Link to="/$workspaceSlug/files" params={{ workspaceSlug }} />}
          >
            Back to My files
          </Button>
        </StatePanel>
      );
    case 'error':
      return (
        <StatePanel
          kind="error"
          heading={heading}
          title="Couldn’t check your Google integration"
          description="Your Drive files are unaffected. Check your network, then try again."
        >
          <Button
            variant="outline"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              setState('busy');
              void retry().finally(() => setState('idle'));
            }}
          >
            {busy ? 'Checking…' : 'Check integration again'}
          </Button>
        </StatePanel>
      );
  }
}
