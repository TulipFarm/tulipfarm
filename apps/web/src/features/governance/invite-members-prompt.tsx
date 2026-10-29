import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { UserAdd } from 'reicon-react/icons/UserAdd';
import { ActionNudge, useNudge } from '@/components/action-nudge';
import { useFeatureRead } from '@/lib/query';
import { loadGovernance } from '@/lib/governance';
import { governanceKeys, useOwnMembership } from '@/features/governance/queries';
import { useGovernanceChanges } from '@/features/governance/changes';
import { InviteMembersDialog } from '@/pages/invite-members-dialog';
import { useInvitationAdministration } from '@/pages/use-invitation-administration';

/** Asks an admin of a one-member workspace to invite people, until they dismiss it. */
export function InviteMembersPrompt({
  userId,
  workspaceId,
  workspaceSlug,
}: {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const nudge = useNudge(`invite-members:${userId}:${workspaceId}`);
  if (nudge.dismissed) return null;
  return <ActivePrompt workspaceId={workspaceId} workspaceSlug={workspaceSlug} onDismiss={nudge.dismiss} />;
}

function ActivePrompt({
  workspaceId,
  workspaceSlug,
  onDismiss,
}: {
  workspaceId: string;
  workspaceSlug: string;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const changes = useGovernanceChanges();
  const membership = useOwnMembership(workspaceId);
  const admin = membership.state.kind === 'ready' && membership.state.data.capabilities.manageGovernance;
  const administration = useFeatureRead({
    key: governanceKeys.administration,
    load: signal => loadGovernance(workspaceId, signal),
    enabled: admin,
  });
  const [open, setOpen] = useState(false);
  const onAccessLost = () => void changes.accessLost();
  const invitations = useInvitationAdministration(workspaceId, admin && open, onAccessLost);
  const data = administration.state.kind === 'ready' ? administration.state.data : null;
  // Keep the dialog mounted while open so a successful invite can finish showing its result.
  if (!admin || !data || (data.members.length !== 1 && !open)) return null;
  return (
    <>
      <ActionNudge icon={UserAdd} label="Invite members" onAction={() => setOpen(true)} onDismiss={onDismiss} />
      <InviteMembersDialog
        workspaceId={workspaceId}
        authorized={admin}
        onAccessLost={onAccessLost}
        invitations={invitations}
        open={open}
        onOpenChange={setOpen}
        onViewInvitations={() => {
          setOpen(false);
          void navigate({ to: '/$workspaceSlug/members', params: { workspaceSlug } });
        }}
        members={data.directory}
        trigger={false}
      />
    </>
  );
}
