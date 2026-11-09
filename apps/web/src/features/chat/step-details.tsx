import { Link, useParams } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { workflowPath } from './github-download';

/** What the model wrote before a step, as the same safe Markdown as its reply: raw HTML is dropped. */
export function StepNarration({ text }: { text: string }) {
  const workspaceSlug = useParams({ strict: false }).workspaceSlug;
  return (
    <div data-step-narration className="text-sm text-muted-foreground">
      <MessageResponse
        renderLink={(href, label) => {
          const workflowId = workspaceSlug && workflowPath(href, workspaceSlug);
          return workflowId ? (
            <Link to="/$workspaceSlug/workflows/$workflowId" params={{ workspaceSlug, workflowId }}>
              {label}
            </Link>
          ) : (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          );
        }}
      >
        {text}
      </MessageResponse>
    </div>
  );
}

/** Links to the active workflows that kept a table from being archived. */
export function BlockingWorkflows({ workflows }: { workflows: readonly { id: string; name: string }[] }) {
  const workspaceSlug = useParams({ strict: false }).workspaceSlug;
  if (!workspaceSlug) return null;
  return (
    <ul aria-label="Workflows that use this table" className="grid gap-1">
      {workflows.map(workflow => (
        <li key={workflow.id}>
          <Button
            variant="link"
            size="sm"
            nativeButton={false}
            render={
              <Link to="/$workspaceSlug/workflows/$workflowId" params={{ workspaceSlug, workflowId: workflow.id }} />
            }
          >
            {workflow.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}
