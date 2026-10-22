import { type ReactNode } from 'react';
import { Envelope } from 'reicon-react/icons/Envelope';
import { InvitationsSample } from '@/components/empty-samples';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { InvitationActions } from './invitation-actions';
import type { InvitationAdministration } from './use-invitation-administration';

export function InvitationList({
  workspaceId,
  invitations,
  onAccessLost,
  invite,
}: {
  workspaceId: string;
  invitations: InvitationAdministration;
  onAccessLost: () => void;
  invite?: ReactNode;
}) {
  const { data, error, busy, refresh, search, setSearch } = invitations;
  return (
    <section aria-label="Invitations" className="flex flex-col gap-4 pt-4">
      <h2 className="text-sm font-medium">Invitations</h2>
      <p className="text-sm text-muted-foreground">
        Invitation validity and email delivery are independent. Resend creates a new link and invalidates the previous
        one.
      </p>
      <SearchField
        id="invitation-search"
        label="Search invitations"
        value={search}
        onChange={setSearch}
        placeholder="Search email, validity, or delivery"
        maxLength={254}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not refresh invitations. Confirmed changes are saved. Reloading does not send another email.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <div>
          <Button variant="outline" size="sm" disabled={busy} aria-busy={busy} onClick={() => void refresh()}>
            Reload invitations
          </Button>
        </div>
      )}
      {!data && !error && (
        <div role="status" aria-label="Loading invitations" className="flex flex-col gap-4">
          <Skeleton shape="panel" />
          <span className="sr-only">Loading invitations…</span>
        </div>
      )}
      {data && (
        <>
          {data.items.length === 0 ? (
            search.trim() ? (
              <StatePanel
                kind="empty"
                heading="h3"
                icon={Envelope}
                title="No invitations match"
                description="Try another email, validity, or delivery status."
              >
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearch('');
                    document.getElementById('invitation-search')?.focus();
                  }}
                >
                  Clear search
                </Button>
              </StatePanel>
            ) : (
              <StatePanel
                kind="empty"
                heading="h3"
                icon={Envelope}
                title="No invitations yet"
                description="Send each teammate a personal link to join this workspace. You can track whether the email arrived, resend it, or revoke it here."
                sample={<InvitationsSample />}
              >
                {invite}
              </StatePanel>
            )
          ) : (
            <ul className="divide-y rounded-lg border bg-card">
              {data.items.map(item => (
                <li key={item.id} className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-2">
                    <p className="break-all text-sm font-medium">{item.email ?? 'Retired unrestricted link'}</p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={item.status === 'active' ? 'info' : 'secondary'}>
                        {item.status === 'consumed' ? 'Accepted' : item.status}
                      </Badge>
                      <Badge variant={item.delivery === 'failed' ? 'destructive' : 'outline'}>
                        Email {item.delivery ?? 'not tracked'}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {item.status}. Expires {new Date(item.expiresAt).toLocaleString()}.
                    </p>
                    {item.status === 'active' && !item.canCopy && (
                      <p>Copy unavailable for this older invitation. Resend to replace it.</p>
                    )}
                  </div>
                  <InvitationActions
                    item={item}
                    workspaceId={workspaceId}
                    invitations={invitations}
                    onAccessLost={onAccessLost}
                  />
                </li>
              ))}
            </ul>
          )}
          {data.nextCursor && (
            <Button variant="outline" disabled={busy} onClick={() => void refresh(data.nextCursor ?? undefined)}>
              Load older invitations
            </Button>
          )}
        </>
      )}
    </section>
  );
}
