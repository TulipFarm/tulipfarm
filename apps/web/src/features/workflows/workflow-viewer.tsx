import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Definition } from '@tulipfarm/workflows/contracts';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { Refresh } from 'reicon-react/icons/Refresh';
import { ResultCard, type ResultAppAction } from '@tulipfarm/sprout/result-card';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { brandNames } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { WorkflowDiagram, WorkflowStepList, type WorkflowStepState } from '@/components/workflow-diagram';
import { workflowGraph, type WorkflowLabels } from './diagram-model';
import { StepDetails } from './step-details';

export type WorkflowView = {
  key: string;
  definition: Definition;
  labels: WorkflowLabels;
  source: 'Draft' | 'Saved' | 'Active' | 'Run';
  revisionLabel: string;
  notice?: string;
  run?: {
    label: string;
    status: 'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked' | 'failed' | 'skipped';
    states: Record<string, WorkflowStepState>;
    note: string;
    task?: { stepId: string; title: string; status: string };
  };
};
const actionStates: Record<WorkflowStepState, ResultAppAction['state']> = {
  definition: 'pending',
  pending: 'pending',
  next: 'pending',
  active: 'running',
  waiting: 'pending',
  completed: 'completed',
  skipped: 'skipped',
  failed: 'failed',
  unknown: 'unknown',
  withheld: 'unknown',
};

export function WorkflowViewer({
  view,
  surface = 'page',
  onEdit,
  onRefresh,
  onTask,
  stepContent,
  navigation,
  header = true,
}: {
  view: WorkflowView;
  header?: boolean;
  surface?: 'page' | 'canvas';
  onEdit?: (() => void) | undefined;
  onRefresh: () => void;
  onTask?: (() => void) | undefined;
  navigation?: ReactNode;
  stepContent?: ((id: string) => ReactNode) | undefined;
}) {
  const graph = useMemo(
    () => workflowGraph(view.definition, view.labels, view.run?.states),
    [view.definition, view.labels, view.run?.states],
  );
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
  const [mode, setMode] = useState<'diagram' | 'steps'>('diagram');
  const selected =
    selection?.key === view.key
      ? selection.id
      : (graph.nodes.find(node => node.state === 'active' || node.state === 'waiting')?.id ??
        graph.nodes[1]?.id ??
        '$trigger');
  const inspect = useCallback((id: string) => setSelection({ key: view.key, id }), [view.key]);
  const node = graph.nodes.find(item => item.id === selected) ?? graph.nodes[0]!;
  const task = view.run?.task;
  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="Refresh workflow" title="Refresh workflow" onClick={onRefresh}>
        <Refresh size={15} aria-hidden="true" />
      </Button>
      {onEdit && (
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit in chat
          <ArrowUpRight size={14} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
  return (
    <section className="workflow-viewer" data-surface={surface} aria-label={`${view.definition.name} workflow`}>
      {header && (
        <header className="workflow-viewer-header">
          <div className="min-w-0 flex-1 space-y-2">
            <ResultCard
              title={view.definition.name}
              kind="Workflow"
              status={view.run?.label ?? view.revisionLabel}
              state={
                view.run?.status === 'completed'
                  ? 'success'
                  : view.run?.status === 'failed' || view.run?.status === 'blocked'
                    ? 'error'
                    : view.run?.status === 'running'
                      ? 'running'
                      : 'default'
              }
              icon={<BranchDown size={18} />}
              apps={graph.nodes.flatMap(node =>
                node.identity?.kind === 'app'
                  ? [
                      {
                        brand: node.identity.brand,
                        name: brandNames[node.identity.brand],
                        actions: [{ label: node.title, state: actionStates[node.state] }],
                      },
                    ]
                  : [],
              )}
            />
            <span className="text-xs text-muted-foreground">
              {view.run
                ? view.revisionLabel
                : `${view.definition.steps.length} ${view.definition.steps.length === 1 ? 'step' : 'steps'}`}
            </span>
            <p className="text-xs text-muted-foreground">
              {view.run?.note ??
                (view.source === 'Draft'
                  ? 'Review this draft before saving.'
                  : 'Definition only. A saved workflow does not confirm a run or delivery.')}
            </p>
          </div>
          {actions}
        </header>
      )}
      {view.notice && (
        <div className="px-4">
          <Alert>
            <AlertDescription>{view.notice}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="workflow-viewer-toolbar">
        <div role="group" aria-label="Workflow display" className="flex items-center gap-1">
          <Button
            variant={mode === 'diagram' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={mode === 'diagram'}
            onClick={() => setMode('diagram')}
          >
            Diagram
          </Button>
          <Button
            variant={mode === 'steps' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={mode === 'steps'}
            onClick={() => setMode('steps')}
          >
            Steps
          </Button>
        </div>
        {header ? (
          (navigation ?? <p className="text-xs text-muted-foreground">Select a step to inspect</p>)
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {navigation}
            {actions}
          </div>
        )}
      </div>
      <div className="workflow-viewer-body">
        <div className="min-w-0">
          {mode === 'diagram' ? (
            <WorkflowDiagram
              key={view.key}
              nodes={graph.nodes}
              edges={graph.edges}
              selected={node.id}
              onInspect={inspect}
              surface={surface}
            />
          ) : (
            <WorkflowStepList nodes={graph.nodes} selected={node.id} onInspect={inspect} />
          )}
          <div className="workflow-legend" aria-label="Diagram legend">
            <span>
              <i aria-hidden="true" />
              Step order
            </span>
            {graph.nodes.some(node => node.kind === 'condition') && <span>Yes / No branches</span>}
            {view.run && (
              <span>
                <i className="workflow-route-key" aria-hidden="true" />
                Taken path
              </span>
            )}
            <span className="workflow-legend-hint">Select a step to inspect</span>
          </div>
        </div>
        <StepDetails
          node={node}
          details={graph.details[node.id]!}
          onInspect={inspect}
          task={
            task?.stepId === node.id && onTask ? { title: task.title, status: task.status, onOpen: onTask } : undefined
          }
          content={stepContent?.(node.id)}
        />
      </div>
    </section>
  );
}
