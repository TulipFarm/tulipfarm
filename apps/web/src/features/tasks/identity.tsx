import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import type { TaskSummary } from './api';
import { useTaskIdentity } from './queries';
export { useTaskIdentity } from './queries';

export function TaskIdentity({ workspaceId, slug, task }: { workspaceId: string; slug: string; task: TaskSummary }) {
  const read = useTaskIdentity(workspaceId, task.id, task.agentId);
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading task identity">
        <Skeleton />
      </div>
    );
  if (read.state.kind !== 'ready')
    return (
      <div className="space-y-2">
        <p>Task request unavailable. Check your source access or retry.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry task identity
          </Button>
          <Button
            variant="link"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug: slug, taskId: task.id }} />}
          >
            Check task {task.id.slice(0, 8)}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="min-w-0 space-y-1">
      <Button
        variant="link"
        size="task-link"
        role="link"
        nativeButton={false}
        render={<Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug: slug, taskId: task.id }} />}
      >
        <span className="line-clamp-2 min-w-0 whitespace-normal text-left break-words">{read.state.data.title}</span>
      </Button>
      <p className="break-words text-sm text-muted-foreground">{read.state.data.agent}</p>
      {read.state.error && (
        <p role="alert">
          Task identity could not refresh.{' '}
          <Button variant="link" onClick={() => void read.refresh()}>
            Retry task identity
          </Button>
        </p>
      )}
    </div>
  );
}

export function taskTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
