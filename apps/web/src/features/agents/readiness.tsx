import { Link } from '@tanstack/react-router';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import type { AgentDetail } from './api';
import { agentSetup, type AgentTab, type ExecutionCheck, type ModelCheck, type SetupStep } from './setup';

const statusBadge: Record<SetupStep['status'], { label: string; variant: 'success' | 'warning' | 'secondary' }> = {
  done: { label: 'Done', variant: 'success' },
  todo: { label: 'To do', variant: 'warning' },
  waiting: { label: 'Waiting', variant: 'secondary' },
  checking: { label: 'Checking', variant: 'secondary' },
};

export function AgentSetup({
  detail,
  execution,
  workspaceId,
  slug,
  open,
}: {
  detail: AgentDetail;
  execution: ExecutionCheck;
  workspaceId: string;
  slug: string;
  open: (tab: AgentTab, target: string) => void;
}) {
  const models = useModelCatalog(workspaceId);
  const family =
    models.state.kind === 'ready'
      ? models.state.data.families.find(item => item.id === detail.definition.modelFamilyId)
      : undefined;
  const model: ModelCheck =
    models.state.kind === 'loading'
      ? { kind: 'checking' }
      : models.state.kind !== 'ready' || models.state.error
        ? { kind: 'error' }
        : !detail.definition.modelFamilyId
          ? { kind: 'none' }
          : family?.available || family?.unavailableReason === 'model-family-paused'
            ? { kind: 'available', name: family.displayName }
            : { kind: 'unavailable' };
  const steps = agentSetup({ detail, execution, model });
  const remaining = steps.filter(step => step.status !== 'done').length;
  return (
    <section aria-labelledby="agent-setup" className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div className="grid gap-1">
        <h2 id="agent-setup" tabIndex={-1} className="text-sm font-medium text-foreground">
          {remaining ? 'Set up this agent' : 'Ready to run'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {remaining
            ? `${remaining} of ${steps.length} steps left before this agent can run. Complete them in order.`
            : 'Every step is complete. Data permissions, selected skills, and credits are checked again when work starts.'}
        </p>
      </div>
      <ol aria-label="Setup steps" className="grid gap-3">
        {steps.map((step, index) => (
          <li key={step.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 border-t pt-3">
            <span aria-hidden="true" className="w-4 shrink-0 text-sm tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                {step.title}
                <Badge variant={statusBadge[step.status].variant}>{statusBadge[step.status].label}</Badge>
              </p>
              <p className="text-sm text-muted-foreground">{step.detail}</p>
            </div>
            {step.link && <SetupAction link={step.link} slug={slug} open={open} retry={() => void models.refresh()} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

function SetupAction({
  link,
  slug,
  open,
  retry,
}: {
  link: NonNullable<SetupStep['link']>;
  slug: string;
  open: (tab: AgentTab, target: string) => void;
  retry: () => void;
}) {
  if (link.kind === 'models')
    return (
      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: slug }} />}
      >
        {link.label}
      </Button>
    );
  if (link.kind === 'retry-models')
    return (
      <Button size="sm" variant="outline" onClick={retry}>
        {link.label}
      </Button>
    );
  return (
    <Button size="sm" variant="outline" onClick={() => open(link.tab, link.target)}>
      {link.label}
    </Button>
  );
}
