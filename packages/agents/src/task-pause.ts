import type { TaskPauseReason } from './task-contracts.ts';

export function taskFailurePauseReason(failure: string | null): TaskPauseReason {
  switch (failure) {
    case 'task-credits':
      return 'limit.credits';
    case 'credits-exhausted':
      return 'limit.workspaceCredits';
    case 'active-time':
      return 'limit.activeTime';
    case 'tool-limit':
      return 'limit.toolCalls';
    case 'context-limit':
    case 'context-overflow':
      return 'context';
    case 'file-unsupported':
    case 'file-unavailable':
      return 'file';
    default:
      return 'model';
  }
}
