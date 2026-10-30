import { useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { Clock } from 'reicon-react/icons/Clock';
import { Code } from 'reicon-react/icons/Code';
import { Database } from 'reicon-react/icons/Database';
import { Globe } from 'reicon-react/icons/Globe';
import { MessageEdit } from 'reicon-react/icons/MessageEdit';
import { Play } from 'reicon-react/icons/Play';
import { Plug } from 'reicon-react/icons/Plug';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { Users } from 'reicon-react/icons/Users';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';

export type WorkflowNodeKind =
  | 'trigger'
  | 'condition'
  | 'transform'
  | 'delay'
  | 'wait-until'
  | 'human'
  | 'code'
  | 'agent'
  | 'http'
  | 'slack-message'
  | 'find-rows'
  | 'create-row'
  | 'update-row';
export type WorkflowStepState =
  | 'definition'
  | 'pending'
  | 'next'
  | 'active'
  | 'waiting'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'unknown'
  | 'withheld';
type WorkflowIdentity = { kind: 'app'; brand: Brand } | { kind: 'agent'; agentId: string; name: string };
export type WorkflowDiagramNode = {
  id: string;
  kind: WorkflowNodeKind;
  title: string;
  summary: string;
  actor: string;
  ordinal: number;
  state: WorkflowStepState;
  position: { x: number; y: number };
  identity?: WorkflowIdentity;
};
export type WorkflowDiagramEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'order' | 'gate' | 'route' | 'requirement';
  label?: string;
  state: 'default' | 'completed' | 'active' | 'muted';
};

export const workflowStepLabels: Record<WorkflowStepState, string> = {
  definition: 'Configured',
  pending: 'Not reached',
  active: 'Working',
  waiting: 'Waiting',
  completed: 'Done',
  skipped: 'Not selected',
  failed: 'Failed',
  unknown: 'Unconfirmed',
  next: 'Next eligible',
  withheld: 'Output hidden',
};
const badges = {
  definition: 'secondary',
  pending: 'secondary',
  next: 'outline',
  active: 'info',
  waiting: 'warning',
  completed: 'success',
  skipped: 'secondary',
  failed: 'destructive',
  unknown: 'outline',
  withheld: 'outline',
} as const;
const icons: Record<WorkflowNodeKind, ComponentType<{ size?: number }>> = {
  trigger: Plug,
  condition: BranchDown,
  transform: Code,
  delay: Clock,
  'wait-until': Clock,
  human: Users,
  code: Code,
  agent: Sparkle,
  http: Globe,
  'slack-message': MessageEdit,
  'find-rows': Database,
  'create-row': Database,
  'update-row': Database,
};
export const workflowKindLabels: Record<WorkflowNodeKind, string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  transform: 'Transform',
  delay: 'Delay',
  'wait-until': 'Wait until',
  human: 'Human decision',
  code: 'Code',
  agent: 'Agent task',
  http: 'HTTP request',
  'slack-message': 'Slack message',
  'find-rows': 'Find rows',
  'create-row': 'Create row',
  'update-row': 'Update row',
};

type StepNode = Node<{ step: WorkflowDiagramNode; inspected: boolean; inspect: (id: string) => void }, 'workflow-step'>;
type FlowEdge = Edge<{ connection: WorkflowDiagramEdge; motion: boolean }, 'workflow-path'>;
const maxDiagramHeight = 680;

export function WorkflowStepIcon({
  kind,
  identity,
}: {
  kind: WorkflowNodeKind;
  identity?: WorkflowIdentity | undefined;
}) {
  if (identity?.kind === 'agent')
    return (
      <span className="workflow-step-identity" aria-hidden="true">
        <AgentAvatar agentId={identity.agentId} name={identity.name} />
      </span>
    );
  if (identity?.kind === 'app')
    return (
      <span className="workflow-step-identity" aria-hidden="true">
        <BrandIcon brand={identity.brand} size="glyph" />
      </span>
    );
  const Icon = icons[kind];
  return (
    <span className="workflow-step-icon" data-kind={kind} aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

export function WorkflowStepList({
  nodes,
  selected,
  onInspect,
}: {
  nodes: readonly WorkflowDiagramNode[];
  selected: string;
  onInspect: (id: string) => void;
}) {
  return (
    <ol className="workflow-step-list" aria-label="Workflow steps">
      {nodes.map(step => (
        <li key={step.id} data-inspected={step.id === selected}>
          <span className="workflow-step-number" aria-hidden="true">
            {step.ordinal || <Play size={12} />}
          </span>
          <button
            type="button"
            className="workflow-step-row"
            onClick={() => onInspect(step.id)}
            aria-pressed={step.id === selected}
            aria-label={`Inspect ${step.title}`}
          >
            <WorkflowStepIcon kind={step.kind} identity={step.identity} />
            <span className="workflow-step-copy">
              <span className="workflow-step-row-title">{step.title}</span>
              <span className="workflow-step-row-summary">{step.summary}</span>
              {step.actor && <span className="workflow-step-row-actor">{step.actor}</span>}
            </span>
            {step.state !== 'definition' && (
              <Badge variant={badges[step.state]}>{workflowStepLabels[step.state]}</Badge>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

function StepCard({ data: { step, inspected, inspect } }: NodeProps<StepNode>) {
  return (
    <section className="workflow-node" data-state={step.state} data-inspected={inspected} data-step-id={step.id}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="target" id="gate-in" position={Position.Right} isConnectable={false} />
      <button
        type="button"
        className="nodrag nopan workflow-node-inspect"
        aria-label={`Inspect ${step.title}`}
        aria-pressed={inspected}
        onClick={() => inspect(step.id)}
      >
        <span className="workflow-node-heading">
          <WorkflowStepIcon kind={step.kind} identity={step.identity} />
          <span className="workflow-node-type">
            {step.ordinal ? `${step.ordinal}. ${workflowKindLabels[step.kind]}` : 'Starts when'}
          </span>
          {step.state !== 'definition' && <Badge variant={badges[step.state]}>{workflowStepLabels[step.state]}</Badge>}
        </span>
        <span className="workflow-node-title">{step.title}</span>
        <span className="workflow-node-summary">{step.summary}</span>
        {(step.actor || step.state === 'active' || step.state === 'completed') && (
          <span className="workflow-node-actor">
            {(step.state === 'active' || step.state === 'completed') && (
              <span className="workflow-activity-mark" aria-hidden="true" />
            )}
            {step.actor}
          </span>
        )}
      </button>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <Handle type="source" id="gate-out" position={Position.Right} isConnectable={false} />
    </section>
  );
}

function FlowPath({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowEdge>) {
  const [path, x, y] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
    offset: data?.connection.kind === 'requirement' ? 56 : 24,
  });
  const active = data?.connection.state === 'active';
  return (
    <g data-path-kind={data?.connection.kind} data-path-state={data?.connection.state} className="workflow-path">
      <BaseEdge id={id} path={path} />
      {active && data.motion && (
        <circle r="3" className="workflow-path-marker" aria-hidden="true">
          <animateMotion dur="2s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {data?.connection.label && (
        <EdgeLabelRenderer>
          <span
            className="workflow-edge-label"
            data-kind={data.connection.kind}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            {data.connection.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

function WorkflowViewport() {
  const width = useStore(state => state.width),
    height = useStore(state => state.height);
  const flow = useReactFlow();
  const fitted = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!flow.viewportInitialized || !width || !height) return;
    if (fitted.current) {
      const previous = fitted.current;
      if (previous.width === width && previous.height === height) return;
      const viewport = flow.getViewport();
      fitted.current = { width, height };
      void flow.setViewport({
        ...viewport,
        x: viewport.x + (width - previous.width) / 2,
        y: viewport.y + (height - previous.height) / 2,
      });
      return;
    }
    // Wait for the opening Canvas to reach its measured size; later reads must not reset pan/zoom.
    const timer = window.setTimeout(() => {
      fitted.current = { width, height };
      const bounds = flow.getNodesBounds(flow.getNodes());
      const zoom = Math.max(
        bounds.height * 0.85 > maxDiagramHeight ? 0.85 : 0.15,
        Math.min(1, (width - 48) / bounds.width, (height - 80) / bounds.height),
      );
      void flow.setViewport({
        x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
        y: Math.max(40, (height - bounds.height * zoom) / 2) - bounds.y * zoom,
        zoom,
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [width, height, flow]);
  return null;
}

function useVisibleMotion(ref: RefObject<HTMLDivElement | null>) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => setAllowed(visible && !document.hidden && !reduced.matches);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      update();
    });
    if (ref.current) observer.observe(ref.current);
    reduced.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      reduced.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [ref]);
  return allowed;
}

const nodeTypes = { 'workflow-step': StepCard };
const edgeTypes = { 'workflow-path': FlowPath };

export function WorkflowDiagram({
  nodes: steps,
  edges: connections,
  selected,
  onInspect,
  surface = 'page',
}: {
  nodes: readonly WorkflowDiagramNode[];
  edges: readonly WorkflowDiagramEdge[];
  selected: string | null;
  onInspect: (id: string) => void;
  surface?: 'page' | 'canvas';
}) {
  const element = useRef<HTMLDivElement>(null);
  const motion = useVisibleMotion(element);
  const height = Math.min(maxDiagramHeight, Math.max(420, ...steps.map(step => step.position.y + 136 + 96)));
  const nodes = useMemo(
    () =>
      steps.map((step): StepNode => ({
        id: step.id,
        type: 'workflow-step',
        position: step.position,
        draggable: false,
        connectable: false,
        selectable: false,
        focusable: false,
        width: 280,
        height: 136,
        data: { step, inspected: step.id === selected, inspect: onInspect },
      })),
    [steps, selected, onInspect],
  );
  const edges = useMemo(
    () =>
      connections.map((connection): FlowEdge => ({
        id: connection.id,
        source: connection.source,
        target: connection.target,
        type: 'workflow-path',
        ...(connection.kind === 'requirement' ? { sourceHandle: 'gate-out', targetHandle: 'gate-in' } : {}),
        ariaLabel: `${steps.find(step => step.id === connection.source)?.title} to ${steps.find(step => step.id === connection.target)?.title}${connection.label ? `: ${connection.label}` : ''}`,
        reconnectable: false,
        selectable: false,
        focusable: false,
        data: { connection, motion },
      })),
    [connections, motion, steps],
  );
  return (
    <div
      ref={element}
      className="workflow-diagram"
      style={{ height: surface === 'canvas' ? `min(${height}px, max(280px, calc(100dvh - 360px)))` : height }}
      data-surface={surface}
      data-motion={motion}
      role="figure"
      aria-label="Read-only workflow diagram"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        minZoom={0.15}
        maxZoom={1.5}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <WorkflowViewport />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
