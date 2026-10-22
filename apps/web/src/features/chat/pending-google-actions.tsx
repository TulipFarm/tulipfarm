import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { useGoogleProposals } from '@/features/integrations/queries';

export function PendingGoogleActions({
  workspaceId,
  slug,
  chatId,
}: {
  workspaceId: string;
  slug: string;
  chatId: string;
}) {
  const read = useGoogleProposals(workspaceId);
  if (read.state.kind !== 'ready') return null;
  const count = read.state.data.proposals.filter(
    proposal => !proposal.decision && !proposal.receiptStatus && Date.parse(proposal.expiresAt) > Date.now(),
  ).length;
  if (!count) return null;
  return (
    <nav aria-label="Pending Google actions" className="flex flex-wrap justify-end border-b px-4 py-1">
      <Button
        variant="link"
        size="task-link"
        nativeButton={false}
        render={
          <Link
            to="/$workspaceSlug/integrations"
            params={{ workspaceSlug: slug }}
            search={{ returnChat: chatId }}
            hash="google-proposals-heading"
          />
        }
      >
        {count} recent Google actions need your review
      </Button>
    </nav>
  );
}
