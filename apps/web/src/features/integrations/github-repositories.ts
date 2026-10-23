import { GitHubKnowledgeError, type GitHubKnowledgeApi, type GitHubRepositoryChoice } from './github-knowledge-api';

export async function discoverGitHubRepositories(
  api: Pick<GitHubKnowledgeApi, 'discover'>,
  accountId: string,
  signal: AbortSignal,
) {
  const repositories = new Map<string, GitHubRepositoryChoice>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let binding: Awaited<ReturnType<GitHubKnowledgeApi['discover']>>['binding'] | undefined;
  do {
    signal.throwIfAborted();
    const page = await api.discover(accountId, cursor, signal);
    signal.throwIfAborted();
    if (
      page.binding.accountId !== accountId ||
      (binding &&
        (binding.accountGeneration !== page.binding.accountGeneration ||
          binding.githubUserId !== page.binding.githubUserId))
    )
      throw new GitHubKnowledgeError(409, 'github-stale-integration');
    binding = page.binding;
    for (const repository of page.items) repositories.set(repository.repositoryId, repository);
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor) || cursors.size >= 100) throw new Error('GitHub repository listing did not finish.');
      cursors.add(cursor);
    }
  } while (cursor);
  return [...repositories.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export function filterGitHubRepositories<T extends GitHubRepositoryChoice>(
  repositories: T[],
  search: string,
  owner: string,
) {
  const query = search.trim().toLowerCase();
  return repositories.filter(
    repository =>
      (owner === '' || repository.fullName.split('/')[0] === owner) &&
      repository.fullName.toLowerCase().includes(query),
  );
}
