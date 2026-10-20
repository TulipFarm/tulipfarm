import { useState } from 'react';
import { createdInvitationSchema, invitationLinkSchema } from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { governanceError, governancePath, governanceRequest, GovernanceRequestError } from '@/lib/governance';
import { workspaceRoute } from '@/router';
import { WorkspaceMemberPicker } from '@/features/tables/member-picker';

import type { Invitation, InvitationAdministration } from './use-invitation-administration';

export function InvitationActions({
  item,
  workspaceId,
  invitations,
  onAccessLost,
}: {
  item: Invitation;
  workspaceId: string;
  invitations: InvitationAdministration;
  onAccessLost: () => void;
}) {
  const busy = invitations.actionBusy(item.id);
  const { workspaceSlug } = workspaceRoute.useParams();
  const [memberId, setMemberId] = useState(() => invitations.resendMember(item.id) ?? item.workspaceMemberId ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'resend' | 'revoke' | null>(null);
  const base = `${governancePath(workspaceId)}/invitations/${item.id}`;
  async function run(action: 'copy' | 'resend' | 'revoke') {
    if (action === 'resend' && !memberId) {
      setMessage('Choose the existing workspace member for this invitation.');
      return;
    }
    if (!invitations.begin(item.id)) return;
    setMessage(null);
    setNotice(null);
    setLink(null);
    try {
      if (action === 'copy') {
        const { url } = invitationLinkSchema.parse(await governanceRequest(`${base}/link`));
        setLink(url);
        try {
          await navigator.clipboard.writeText(url);
          setNotice('Link copied.');
        } catch {
          setNotice('Clipboard unavailable. Select and copy the invitation link.');
        }
      } else if (action === 'resend') {
        const result = createdInvitationSchema.parse(
          await governanceRequest(`${base}/resend`, 'POST', {
            requestId: invitations.resendRequest(item.id, memberId),
            workspaceMemberId: memberId,
          }),
        );
        invitations.resendConfirmed(item.id);
        setConfirm(null);
        setNotice('Replacement invitation saved. The old link no longer works.');
        if (result.outcome !== 'already-member') invitations.record(result.invitation, item);
        void invitations.refresh();
      } else {
        await governanceRequest(`${base}/revoke`, 'POST');
        setConfirm(null);
        setNotice('Invitation revoked. The link no longer works.');
        invitations.record({ ...item, status: 'revoked', canCopy: false });
        void invitations.refresh();
      }
    } catch (error) {
      if (error instanceof GovernanceRequestError && error.status === 401) onAccessLost();
      else if (error instanceof GovernanceRequestError && error.status === 404) {
        setMessage('This invitation is unavailable. Refresh invitations to check its current status.');
        void invitations.refresh();
      } else if (
        error instanceof GovernanceRequestError &&
        error.status === 409 &&
        ['member-selection-required', 'member-link-conflict'].includes(error.code)
      ) {
        invitations.resendRejected(item.id);
        setMessage(
          'This member cannot be linked to the invitation. Review their current access or choose another member.',
        );
      } else setMessage(governanceError(error));
    } finally {
      invitations.finish(item.id);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {item.canCopy && item.status === 'active' && (
          <Button variant="outline" size="sm" disabled={busy} aria-busy={busy} onClick={() => void run('copy')}>
            Copy link
          </Button>
        )}
        {item.kind === 'email' &&
          (['active', 'expired'].includes(item.status) || invitations.resendPending(item.id)) && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm('resend')}>
              {invitations.resendPending(item.id) ? 'Retry resend' : 'Resend'}
            </Button>
          )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || item.status !== 'active'}
          onClick={() => setConfirm('revoke')}
        >
          Revoke link
        </Button>
      </div>
      {confirm && (
        <section aria-label={`Confirm ${confirm}`} className="flex flex-col gap-2">
          <p>
            {confirm === 'resend'
              ? 'Send a replacement email? The previous link will stop working immediately.'
              : 'Revoke this invitation? Its link will stop working. People who already joined keep their membership.'}
          </p>
          {confirm === 'resend' && !item.workspaceMemberId && (
            <WorkspaceMemberPicker
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              id={`resend-member-${item.id}`}
              value={memberId}
              onChange={setMemberId}
              disabled={busy || invitations.resendPending(item.id)}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={confirm === 'revoke' ? 'destructive' : 'default'}
              disabled={busy}
              aria-busy={busy}
              onClick={() => void run(confirm)}
            >
              {confirm === 'resend' ? 'Confirm resend' : 'Confirm revoke'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {notice && <p role="status">{notice}</p>}
      {link && item.status === 'active' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`link-${item.id}`}>Invitation link</Label>
          <Input id={`link-${item.id}`} readOnly value={link} onFocus={event => event.target.select()} />
          <Button variant="ghost" size="sm" onClick={() => setLink(null)}>
            Hide link
          </Button>
        </div>
      )}
    </div>
  );
}
