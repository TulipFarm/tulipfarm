import { useNavigate } from '@tanstack/react-router';
import { UserAdd } from 'reicon-react/icons/UserAdd';
import { ActionNudge, useNudge } from '@/components/action-nudge';
import { useFeatureRead } from '@/lib/query';
import { loadGovernance } from '@/lib/governance';
import { governanceKeys, useOwnMembership } from '@/features/governance/queries';

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
  const membership = useOwnMembership(workspaceId);
  const admin = membership.state.kind === 'ready' && membership.state.data.capabilities.manageGovernance;
  const administration = useFeatureRead({
    key: governanceKeys.administration,
    load: signal => loadGovernance(workspaceId, signal),
    enabled: admin,
  });
  const data = administration.state.kind === 'ready' ? administration.state.data : null;
  if (!admin || !data || data.members.length !== 1) return null;
  return (
    <ActionNudge
      icon={UserAdd}
      label="Invite members"
      onAction={() => void navigate({ to: '/$workspaceSlug/members/invite', params: { workspaceSlug } })}
      onDismiss={onDismiss}
    />
  );
}
