import { z } from 'zod';
import { githubReadSchema, type GitHubRead } from './read-contracts.ts';

// Search pages can silently omit revoked objects. Retain the original targets, not a new result set.
export function searchAccessTargets(operation: GitHubRead, data: unknown): GitHubRead[] | undefined {
  if (!['repository.search', 'issue.search', 'pull.search', 'file.search'].includes(operation.kind)) return undefined;
  const parsed = z.object({ items: z.array(z.object({ url: z.url() }).passthrough()).max(30) }).safeParse(data);
  if (!parsed.success) return undefined;
  const targets: GitHubRead[] = [];
  for (const item of parsed.data.items) {
    const url = new URL(item.url);
    if (url.origin !== 'https://api.github.com' || url.hash) return undefined;
    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(issues|pulls)\/(\d+)|\/contents\/(.+))?$/.exec(url.pathname);
    if (!match) return undefined;
    const [, owner, repo, family, number, path] = match;
    const target = githubReadSchema.safeParse(
      operation.kind === 'repository.search' && !family && !path
        ? { kind: 'repository.read', owner, repo }
        : (operation.kind === 'issue.search' || operation.kind === 'pull.search') && family
          ? { kind: family === 'pulls' ? 'pull.read' : 'issue.read', owner, repo, number: Number(number) }
          : operation.kind === 'file.search' && path
            ? {
                kind: 'file.read',
                owner,
                repo,
                path: decodeURIComponent(path),
                ...(url.searchParams.has('ref') ? { ref: url.searchParams.get('ref') } : {}),
              }
            : null,
    );
    if (!target.success) return undefined;
    targets.push(target.data);
  }
  return targets;
}

export function hasFixedAccessTarget(operation: GitHubRead) {
  return 'repo' in operation || operation.kind === 'project.read' || operation.kind === 'project.fields';
}
