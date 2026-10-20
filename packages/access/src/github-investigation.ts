import { z } from 'zod';
import type { GitHubRead } from './github-read.ts';

export const githubInvestigationPermissionSchema = z.enum([
  'github.code.read',
  'github.issues.read',
  'github.pulls.read',
  'github.actions.read',
  'github.releases.read',
  'github.discussions.read',
]);
export type GitHubInvestigationPermission = z.infer<typeof githubInvestigationPermissionSchema>;

export function githubInvestigationPermissions(operation: GitHubRead): readonly GitHubInvestigationPermission[] {
  switch (operation.kind) {
    case 'repository.read':
    case 'repository.search':
    case 'file.search':
    case 'file.read':
    case 'file.content':
    case 'file.list':
    case 'branch.list':
    case 'branch.read':
      return ['github.code.read'];
    case 'issue.search':
    case 'issue.read':
    case 'issue.comments':
      return ['github.issues.read'];
    case 'pull.list':
    case 'pull.search':
    case 'pull.read':
    case 'pull.reviews':
    case 'pull.comments':
      return ['github.pulls.read'];
    case 'pull.diff':
    case 'pull.files':
    case 'pull.commits':
    case 'pull.review-comments':
      return ['github.pulls.read', 'github.code.read'];
    case 'pull.checks':
    case 'pull.status':
      return ['github.pulls.read', 'github.actions.read'];
    case 'commit.checks':
    case 'commit.status':
    case 'actions.runs':
    case 'actions.workflows':
    case 'actions.workflow':
    case 'actions.run':
    case 'actions.jobs':
    case 'actions.artifacts':
    case 'actions.artifact':
    case 'actions.logs':
      return ['github.actions.read'];
    case 'release.list':
    case 'release.read':
    case 'release.assets':
    case 'release.asset':
      return ['github.releases.read'];
    case 'discussion.list':
    case 'discussion.read':
    case 'discussion.categories':
    case 'discussion.comments':
    case 'discussion.replies':
    case 'discussion.search':
      return ['github.discussions.read'];
    case 'project.list':
    case 'project.read':
    case 'project.fields':
    case 'project.items':
    case 'project.item':
    case 'project.item-field':
      throw new Error('GitHub projects require authorization beyond repository investigation grants');
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
