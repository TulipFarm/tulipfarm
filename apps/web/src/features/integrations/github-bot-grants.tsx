import { useMemo, useState } from 'react';
import { botRepositorySchema } from '@tulipfarm/github/batch-contracts';
import { workspaceMemberLabel } from '@tulipfarm/tables/workspace-members';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { githubApi, githubError } from '@/lib/github';
import { tableApi } from '@/features/tables/api';
import { useMemberDirectory, useTableRowsById } from '@/features/tables/hooks';
import { WorkspaceMemberPicker } from '@/features/tables/member-picker';
import { useGitHubBotGrants, useIntegrationChanges } from './queries';

/** Workspace admins let members post approved changes as the TulipFarm bot, one repository at a time. */
export function GitHubBotGrants({ workspaceId, workspaceSlug }: { workspaceId: string; workspaceSlug: string }) {
  const { state } = useGitHubBotGrants(workspaceId);
  const changes = useIntegrationChanges();
  const [memberId, setMemberId] = useState('');
  const [repository, setRepository] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (state.kind !== 'ready' || !state.data.configured) return null;
  const { grants, manage } = state.data;
  const parsed = botRepositorySchema.safeParse(repository);
  const run = async (action: 'add' | 'remove', grant: { memberId: string; repository: string }) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await (action === 'add' ? githubApi.addBotGrant : githubApi.removeBotGrant)(workspaceId, grant);
      await changes.content('github-personal');
      if (action === 'add') setRepository('');
    } catch (error) {
      setFailure(githubError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="github-bot-title" className="space-y-3">
      <div className="space-y-1">
        <h2 id="github-bot-title" className="text-base font-semibold text-foreground">
          Post as the TulipFarm bot
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {manage
            ? 'Let a member choose the TulipFarm bot as the author when they approve changes in a repository. They still need their own access to that repository.'
            : 'Workspace admins choose which repositories you can post to as the TulipFarm bot.'}
        </p>
      </div>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {grants.length ? (
        <GrantList
          workspaceId={workspaceId}
          grants={grants}
          manage={manage}
          busy={busy}
          onRemove={grant => void run('remove', grant)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {manage ? 'No member can post as the bot yet.' : 'You cannot post as the bot in any repository yet.'}
        </p>
      )}
      {manage && (
        <form
          className="grid max-w-xl gap-3"
          onSubmit={event => {
            event.preventDefault();
            if (memberId && parsed.success) void run('add', { memberId, repository: parsed.data });
          }}
        >
          <div>
            <WorkspaceMemberPicker
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              id="github-bot-member"
              value={memberId}
              onChange={setMemberId}
              disabled={busy}
              helper="The member who may post as the bot."
            />
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Repository"
              placeholder="owner/repository"
              value={repository}
              disabled={busy}
              onChange={event => setRepository(event.target.value)}
            />
            <Button type="submit" disabled={busy || !memberId || !parsed.success} aria-busy={busy}>
              Allow
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function GrantList({
  workspaceId,
  grants,
  manage,
  busy,
  onRemove,
}: {
  workspaceId: string;
  grants: { memberId: string; repository: string }[];
  manage: boolean;
  busy: boolean;
  onRemove: (grant: { memberId: string; repository: string }) => void;
}) {
  const directory = useMemberDirectory(workspaceId);
  const api = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const table = directory.state.kind === 'ready' ? directory.state.data : { tableId: '', revision: '' };
  const rows = useTableRowsById(
    api,
    { id: table.tableId, revision: table.revision },
    manage && table.tableId ? [...new Set(grants.map(grant => grant.memberId))] : [],
  );
  const label = (id: string) => {
    const row = rows.state.kind === 'ready' ? rows.state.data.find(item => item.id === id) : undefined;
    return row ? workspaceMemberLabel(row.values) : 'Member';
  };
  return (
    <ul aria-label="Bot authors" className="divide-y rounded-lg border">
      {grants.map(grant => (
        <li
          key={`${grant.memberId}/${grant.repository}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"
        >
          <p className="min-w-0 flex-1 break-all text-sm">
            {manage && <span className="font-medium text-foreground">{label(grant.memberId)} · </span>}
            {grant.repository}
          </p>
          {manage && (
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={busy}
              aria-label={`Remove ${grant.repository} for ${label(grant.memberId)}`}
              onClick={() => onRemove(grant)}
            >
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
