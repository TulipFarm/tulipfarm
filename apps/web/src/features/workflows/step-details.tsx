import { Button } from '@tulipfarm/sprout/button';
import type { ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import {
  WorkflowStepIcon,
  workflowKindLabels,
  workflowStepLabels,
  type WorkflowDiagramNode,
} from '@/components/workflow-diagram';
import type { WorkflowStepDetails } from './diagram-model';

export function StepDetails({
  node,
  details,
  onInspect,
  task,
  content,
}: {
  node: WorkflowDiagramNode;
  details: WorkflowStepDetails;
  onInspect: (id: string) => void;
  task?: { title: string; status: string; onOpen: () => void } | undefined;
  content?: ReactNode;
}) {
  return (
    <section aria-label="Step details" className="workflow-inspector">
      <header className="flex items-start gap-3">
        <WorkflowStepIcon kind={node.kind} identity={node.identity} />
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted-foreground">{workflowKindLabels[node.kind]}</p>
          <h3 className="wrap-anywhere text-base font-medium text-foreground">{node.title}</h3>
        </div>
      </header>
      <p className="text-sm text-muted-foreground">{node.summary}</p>
      <dl className="space-y-4 text-sm">
        {node.state !== 'definition' && (
          <div>
            <dt className="mb-1 text-xs text-muted-foreground">Progress</dt>
            <dd>{workflowStepLabels[node.state]}</dd>
          </div>
        )}
        {details.facts
          .filter(fact => fact.value !== node.summary)
          .map((fact, index) => (
            <div key={`${index}:${fact.label}`}>
              <dt className="mb-1 text-xs text-muted-foreground">{fact.label}</dt>
              <dd className="wrap-anywhere text-foreground">{fact.value}</dd>
            </div>
          ))}
      </dl>
      {details.gates.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Runs only when</h4>
          <ul className="space-y-1 text-sm">
            {details.gates.map(gate => (
              <li key={`${gate.stepId}:${gate.choice}`} className="wrap-anywhere">
                {gate.label}: <strong className="font-medium">{gate.choice}</strong>
              </li>
            ))}
          </ul>
          {details.gates.length > 1 && (
            <p className="text-xs text-muted-foreground">Every condition above must match.</p>
          )}
        </div>
      )}
      {details.references.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Uses output from</h4>
          <div className="flex flex-wrap gap-1">
            {details.references.map(source => (
              <Button key={source.stepId} variant="secondary" size="sm" onClick={() => onInspect(source.stepId)}>
                {source.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {task && (
        <div className="space-y-1 border-t pt-4">
          <p className="text-xs text-muted-foreground">Linked agent task / {task.status}</p>
          <Button variant="link" size="sm" onClick={task.onOpen}>
            {task.title}
          </Button>
        </div>
      )}
      {content}
      <div className="border-t pt-3 text-xs">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Details</CollapsibleTrigger>
          <CollapsibleContent>
            <p className="my-2 text-muted-foreground">Read-only configuration. Make changes in chat.</p>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(details.configuration, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </section>
  );
}
