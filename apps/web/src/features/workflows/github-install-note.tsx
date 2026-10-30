import { useGitHubAccounts } from '@/features/integrations/queries';
import { githubInstallNote } from './definition-description';

export function GitHubInstallNote({ workspaceId }: { workspaceId: string }) {
  const accounts = useGitHubAccounts(workspaceId);
  const installUrl = accounts.state.kind === 'ready' ? accounts.state.data.installUrl : null;
  return (
    <span>
      {githubInstallNote}
      {installUrl && (
        <>
          {' '}
          <a className="underline underline-offset-4" href={installUrl} target="_blank" rel="noreferrer">
            Install the App
          </a>
          .
        </>
      )}
    </span>
  );
}
