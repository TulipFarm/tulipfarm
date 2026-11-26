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
  useViewportStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import {
  BranchIcon,
  ClockIcon,
  CodeIcon,
  DatabaseIcon,
  GlobeIcon,
  MessageEditIcon,
  PlayIcon,
  PlugIcon,
  SparkleIcon,
  TerminalIcon,
  UsersIcon,
} from '@tulipfarm/icons';
import { Badge } from '@tulipfarm/sprout/badge';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { AgentMark } from '@/components/agent-mark';
import { LanguageLogo, type LogoLanguage } from './language-logo';

export type WorkflowNodeKind =
  | 'trigger'
  | 'condition'
  | 'decide'
  | 'transform'
  | 'delay'
  | 'wait-until'
  | 'human'
  | 'code'
  | 'agent'
  | 'coding'
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
type WorkflowIdentity =
  | { kind: 'app'; brand: Brand }
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: 'language'; language: LogoLanguage };
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
  trigger: PlugIcon,
  condition: BranchIcon,
  decide: BranchIcon,
  transform: CodeIcon,
  delay: ClockIcon,
  'wait-until': ClockIcon,
  human: UsersIcon,
  code: CodeIcon,
  agent: SparkleIcon,
  coding: TerminalIcon,
  http: GlobeIcon,
  'slack-message': MessageEditIcon,
  'find-rows': DatabaseIcon,
  'create-row': DatabaseIcon,
  'update-row': DatabaseIcon,
};
export const workflowKindLabels: Record<WorkflowNodeKind, string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  decide: 'Decision',
  transform: 'Transform',
  delay: 'Delay',
  'wait-until': 'Wait until',
  human: 'Human decision',
  code: 'Code',
  agent: 'Agent task',
  coding: 'Coding agent',
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
        <AgentMark agentId={identity.agentId} size={32} />
      </span>
    );
  if (identity?.kind === 'app')
    return (
      <span className="workflow-step-identity" aria-hidden="true">
        <BrandIcon brand={identity.brand} size="glyph" />
      </span>
    );
  if (identity?.kind === 'language')
    return (
      <span className="workflow-step-identity" aria-hidden="true">
        <LanguageLogo language={identity.language} />
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
            {step.ordinal || <PlayIcon size="xs" />}
          </span>
          <button
            type="button"
            className="workflow-step-row"
            onClick={() => onInspect(step.id)}
            aria-pressed={step.id === selected}
          >
            <span className="sr-only">Inspect </span>
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

/** A read-only outline of a workflow, from its trigger to its last step, for small spaces such as a chat card. */
export function WorkflowStepOutline({ nodes }: { nodes: readonly WorkflowDiagramNode[] }) {
  return (
    <ol className="workflow-step-outline" aria-label="Workflow steps">
      {nodes.map(step => (
        <li key={step.id}>
          <WorkflowStepIcon kind={step.kind} identity={step.identity} />
          <span className="workflow-step-copy">
            <span className="workflow-step-row-title">{step.title}</span>
            <span className="workflow-step-row-summary">{step.summary}</span>
          </span>
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
        aria-pressed={inspected}
        onClick={() => inspect(step.id)}
      >
        <span className="sr-only">Inspect </span>
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

// Resizing refits the diagram until the person pans or zooms it; after that it keeps their view and only recenters.
function WorkflowViewport({ adjusted }: { adjusted: RefObject<boolean> }) {
  const width = useViewportStore(state => state.width),
    height = useViewportStore(state => state.height);
  const flow = useReactFlow();
  const fitted = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!flow.viewportInitialized || !width || !height) return;
    const fit = () => {
      fitted.current = { width, height };
      const bounds = flow.getNodesBounds(flow.getNodes());
      const zoom = Math.max(
        bounds.height * 0.85 > maxDiagramHeight ? 0.85 : 0.35,
        Math.min(1, (width - 48) / bounds.width, (height - 64) / bounds.height),
      );
      void flow.setViewport({
        x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
        y: Math.max(32, (height - bounds.height * zoom) / 2) - bounds.y * zoom,
        zoom,
      });
    };
    if (fitted.current) {
      const previous = fitted.current;
      if (previous.width === width && previous.height === height) return;
      if (!adjusted.current) return fit();
      const viewport = flow.getViewport();
      fitted.current = { width, height };
      void flow.setViewport({
        ...viewport,
        x: viewport.x + (width - previous.width) / 2,
        y: viewport.y + (height - previous.height) / 2,
      });
      return;
    }
    const frame = window.requestAnimationFrame(fit);
    // Refit once the opening Canvas reaches its settled size if the person has not panned/zoomed.
    const timer = window.setTimeout(() => {
      if (!adjusted.current) fit();
    }, 220);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [width, height, flow, adjusted]);
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
  const adjusted = useRef(false);
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
      style={surface === 'canvas' ? undefined : { height }}
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
        zoomOnScroll={surface === 'canvas'}
        zoomOnDoubleClick={false}
        preventScrolling={surface === 'canvas'}
        proOptions={{ hideAttribution: true }}
        onMoveStart={event => {
          if (event) adjusted.current = true;
        }}
      >
        <Background gap={20} size={1} />
        <WorkflowViewport adjusted={adjusted} />
        <Controls
          showInteractive={false}
          position="bottom-right"
          onZoomIn={() => (adjusted.current = true)}
          onZoomOut={() => (adjusted.current = true)}
          onFitView={() => (adjusted.current = false)}
        />
      </ReactFlow>
    </div>
  );
}
