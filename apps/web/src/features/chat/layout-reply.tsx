import { useEffect, useMemo, useRef, useState } from 'react';
import { A2uiSurface, sproutAdapters, type A2uiAdapterProps, type A2uiOutgoingMessage } from '@tulipfarm/sprout/a2ui';
import { sproutCatalog } from '@tulipfarm/sprout/a2ui/catalog';
import { PanelRightIcon } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { MessageBubble } from '@tulipfarm/sprout/message';
import { ResultCard, type ResultCardKind } from '@tulipfarm/sprout/result-card';
import { canvasSplitMinWidth } from '@tulipfarm/sprout/canvas';
import {
  checkLayout,
  layoutAllowUrl,
  layoutCatalogs,
  layoutComponentMap,
  layoutPreview,
  layoutVersion,
  tulipfarmCatalogId,
  type EmbedReference,
  type Layout,
} from '@tulipfarm/conversations/layout-contracts';
import { workspaceRoute } from '@/router';
import { useOptionalCanvas, type CanvasContent, type CanvasItem } from './canvas-state';
import { ConversationFileReference } from './file-mentions';
import { PackageInstallationReply } from '@/features/packages/chat-packages';
import { proposalStatusLabel } from './approval-dock';
import { schemaCanvasItem } from './schema-canvas';
import { proposalTitle } from './table-proposal-card';
import { useTableProposal } from '@/features/tables/hooks';
import { proposalApi } from '@/features/tables/proposal-api';
import { settleRendererCall, useRendererCalls } from './layout-calls';

const embedNames: Record<EmbedReference['kind'], { title: string; kind: ResultCardKind }> = {
  plan: { title: 'Plan', kind: 'Plan' },
  schema: { title: 'Table changes', kind: 'Table' },
  'github-batch': { title: 'GitHub changes', kind: 'Action' },
  'slack-action': { title: 'Slack action', kind: 'Action' },
  'calendar-action': { title: 'Calendar change', kind: 'Calendar' },
  'google-action': { title: 'Google change', kind: 'Action' },
  'google-file': { title: 'Google file', kind: 'File' },
  'workspace-file': { title: 'File', kind: 'File' },
  workflow: { title: 'Workflow', kind: 'Workflow' },
  'package-install': { title: 'Package installation', kind: 'Action' },
};

function embedContent(ref: EmbedReference, workspaceId: string, chatId: string): CanvasContent | null {
  switch (ref.kind) {
    case 'plan':
      return { kind: 'plan', workspaceId, chatId, planId: ref.planId };
    case 'schema':
      return { kind: 'schema', workspaceId, chatId, proposalId: ref.proposalId };
    case 'github-batch':
      return { kind: 'github-batch', workspaceId, chatId, batchId: ref.batchId, task: ref.task };
    case 'slack-action':
      return { kind: 'slack-action', workspaceId, actionId: ref.actionId };
    case 'calendar-action':
      return { kind: 'calendar-action', workspaceId, proposalId: ref.proposalId };
    case 'google-action':
      return { kind: 'google-action', workspaceId, proposalId: ref.proposalId };
    case 'google-file':
      return { kind: 'google-file', workspaceId, fileId: ref.fileId };
    case 'workspace-file':
    case 'package-install':
      return null;
    case 'workflow':
      return {
        kind: 'workflow',
        workspaceId,
        reference: { kind: 'definition', workflowId: ref.reference.workflowId, revision: ref.reference.revision },
      };
  }
}

function embedTitle(ref: EmbedReference) {
  return ref.kind === 'workflow' ? ref.reference.name : embedNames[ref.kind].title;
}

function embedId(ref: EmbedReference) {
  const { kind, ...rest } = ref;
  return `embed:${kind}:${Object.values(rest)
    .map(value => (typeof value === 'object' ? JSON.stringify(value) : String(value)))
    .join(':')}`;
}

/** Draws an existing TulipFarm card by reference. Each card loads under the viewer's own access. */
function EmbedAdapter({ props, chatId }: A2uiAdapterProps<{ ref: EmbedReference }> & { chatId: string }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const canvas = useOptionalCanvas();
  const { ref } = props;
  if (ref.kind === 'package-install') return <PackageInstallationReply url={ref.url} chatId={chatId} />;
  if (ref.kind === 'workspace-file')
    return <ConversationFileReference workspaceId={workspace.id} slug={workspace.slug} fileId={ref.fileId} />;
  if (ref.kind === 'schema') return <SchemaEmbed workspaceId={workspace.id} chatId={chatId} id={ref.proposalId} />;
  const title = embedTitle(ref);
  const content = embedContent(ref, workspace.id, chatId);
  const item = content && { id: embedId(ref), title, content };
  return (
    <ResultCard
      title={title}
      kind={embedNames[ref.kind].kind}
      apps={[]}
      status={content ? 'Ready to review.' : 'Open it from the chat.'}
      action={item && canvas ? { label: 'Open in Canvas', onClick: () => canvas.show(item) } : undefined}
    />
  );
}

function SchemaEmbed({ workspaceId, chatId, id }: { workspaceId: string; chatId: string; id: string }) {
  const canvas = useOptionalCanvas();
  const api = useMemo(() => proposalApi(workspaceId, chatId, id), [workspaceId, chatId, id]);
  const read = useTableProposal(api, { chatId, proposalId: id });
  // The assistant can reference a proposal that was never saved; there is nothing to show.
  if (read.state.kind === 'unavailable' && read.state.status === 404) return null;
  const loaded = read.state.kind === 'ready' ? read.state.data : null;
  const title = loaded?.content === 'available' ? proposalTitle(loaded.manifest.plans) : embedNames.schema.title;
  const item = schemaCanvasItem(workspaceId, chatId, id, title);
  return (
    <ResultCard
      title={title}
      kind="Table"
      apps={[]}
      status={loaded ? `${proposalStatusLabel(loaded.status)}.` : 'Loading.'}
      action={canvas ? { label: 'Open in Canvas', onClick: () => canvas.show(item) } : undefined}
    />
  );
}

export function layoutCanvasItem(layout: Layout, messageId: string, chatId: string): CanvasItem {
  return { id: `layout:${messageId}`, title: layout.title, content: { kind: 'layout', layout, messageId, chatId } };
}

const catalogs = [...layoutCatalogs];
const words = (value: unknown) => (typeof value === 'string' && value.trim() ? [value.trim()] : []);

/** Scrolls to a component and focuses it. Components have no DOM IDs, so it is found by its label or text. */
function focusComponent(root: HTMLElement | null, layout: Layout, componentId: string) {
  if (!root) return;
  const component = layoutComponentMap(layout).get(componentId) as Record<string, unknown> | undefined;
  const accessibility = component?.['@accessibility'] as { label?: unknown } | undefined;
  const names = [accessibility?.label, component?.label, component?.title, component?.text].flatMap(words);
  const candidates = [
    ...root.querySelectorAll<HTMLElement>('button, input, textarea, select, [role], h1, h2, h3, h4, label'),
  ];
  const found =
    candidates.find(element =>
      names.some(name => element.getAttribute('aria-label') === name || element.textContent?.trim() === name),
    ) ?? root;
  const target = found.tagName === 'LABEL' ? ((found as HTMLLabelElement).control ?? found) : found;
  if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  target.focus({ preventScroll: true });
}

function useLayoutAdapters(chatId: string) {
  return useMemo(
    () => ({
      [sproutCatalog.id]: sproutAdapters,
      [tulipfarmCatalogId]: {
        Embed: (props: A2uiAdapterProps<{ ref: EmbedReference }>) => (
          <EmbedAdapter props={props.props} context={props.context} chatId={chatId} />
        ),
      },
    }),
    [chatId],
  );
}

function actionText(name: string) {
  const text = name.replace(/[_-]+/g, ' ').trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'Continue';
}

function LayoutSurface({
  layout,
  chatId,
  size,
  messageId,
  streaming = false,
}: {
  layout: Layout;
  chatId: string;
  size: 'compact' | 'full';
  messageId: string;
  streaming?: boolean;
}) {
  const canvas = useOptionalCanvas();
  const host = canvas?.layoutHost ?? null;
  const root = useRef<HTMLDivElement>(null);
  const [responses, setResponses] = useState<{ messageId: string; list: unknown[] }>({ messageId, list: [] });
  const answered = responses.messageId === messageId ? responses.list : [];
  const live = useRendererCalls(messageId);
  const messages = useMemo(() => [...layout.messages, ...live, ...answered], [layout.messages, live, answered]);
  const adapters = useLayoutAdapters(chatId);
  const functions = useMemo(
    () => ({
      [tulipfarmCatalogId]: {
        openInCanvas: () => canvas?.show(layoutCanvasItem(layout, messageId, chatId)),
        focusComponent: ({ componentId }: Record<string, unknown>) => {
          if (typeof componentId === 'string')
            requestAnimationFrame(() => focusComponent(root.current, layout, componentId));
        },
      },
    }),
    [canvas, layout, messageId, chatId],
  );
  const append = (message: unknown) =>
    setResponses(current => ({
      messageId,
      list: [...(current.messageId === messageId ? current.list : []), message],
    }));
  const onMessage = (message: A2uiOutgoingMessage) => {
    if ('type' in message) {
      canvas?.show(layoutCanvasItem(layout, messageId, chatId));
      return;
    }
    if ('action' in message) {
      const { name, sourceComponentId, context, userMessage } = message.action;
      host?.send(messageId, { name, sourceComponentId, context, userMessage: userMessage?.trim() || actionText(name) });
      return;
    }
    if ('callAgentFunction' in message) {
      const { functionCallId } = message.callAgentFunction;
      if (!host) {
        append({
          version: layoutVersion,
          agentFunctionResponse: {
            functionCallId,
            error: { code: 'EXECUTION_ERROR', message: 'Lookups are unavailable here.' },
          },
        });
        return;
      }
      host.lookup(messageId, message).then(append, () =>
        append({
          version: layoutVersion,
          agentFunctionResponse: { functionCallId, error: { code: 'EXECUTION_ERROR', message: 'The lookup failed.' } },
        }),
      );
      return;
    }
    if ('rendererFunctionResponse' in message) {
      settleRendererCall(messageId, message.rendererFunctionResponse.functionCallId);
      return;
    }
    if ('error' in message) console.warn('Layout error', message.error.code);
  };
  return (
    <div ref={root} className="min-w-0 outline-none">
      <A2uiSurface
        messages={messages}
        catalogs={catalogs}
        adapters={adapters}
        functions={functions}
        size={size}
        streaming={streaming}
        readOnly={streaming || !host || host.readOnly(messageId)}
        onMessage={onMessage}
        allowUrl={layoutAllowUrl}
      />
    </div>
  );
}

/** An assistant reply drawn from its saved layout. A canvas reply shows its summary and a button that opens its layout in Canvas, which opens by itself while it is the chat's latest reply. */
export function LayoutReply({
  chatId,
  messageId,
  latest,
  text,
  value,
}: {
  chatId: string;
  messageId: string;
  latest: boolean;
  text: string;
  value: unknown;
}) {
  const checked = useMemo(() => checkLayout(value, messageId), [value, messageId]);
  const canvas = useOptionalCanvas();
  const opened = useRef(false);
  const layout = checked.ok ? checked.layout : null;
  const live = useRendererCalls(messageId);
  // A Canvas reply draws no surface in the chat, so its request to open Canvas runs here.
  useEffect(() => {
    if (!layout || layout.placement !== 'canvas' || !canvas) return;
    const call = live.find(call => call.callRendererFunction.callFunction['@call'] === 'openInCanvas');
    if (!call) return;
    settleRendererCall(messageId, call.callRendererFunction.functionCallId);
    canvas.show(layoutCanvasItem(layout, messageId, chatId));
  }, [live, layout, canvas, messageId, chatId]);
  useEffect(() => {
    if (!latest || !layout || layout.placement !== 'canvas' || !canvas || opened.current) return;
    opened.current = true;
    // On a narrow screen Canvas would cover the chat, so it waits for the user to open it.
    if (window.innerWidth >= canvasSplitMinWidth && !window.matchMedia('(max-width: 767px)').matches)
      canvas.show(layoutCanvasItem(layout, messageId, chatId));
  }, [latest, layout, canvas, messageId, chatId]);
  if (!layout)
    return (
      <MessageBubble variant="ghost">
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </MessageBubble>
    );
  const showing = Boolean(canvas?.open && canvas.activeId === `layout:${messageId}`);
  const notice = layout.notice === 'layout-failed' && (
    <p className="text-xs text-muted-foreground">This reply couldn’t be laid out, so it’s shown as text.</p>
  );
  if (layout.placement === 'chat')
    return (
      <div data-layout="chat" className="w-full min-w-0 space-y-2 px-3 py-2">
        <LayoutSurface layout={layout} chatId={chatId} size="compact" messageId={messageId} />
        {notice}
      </div>
    );
  return (
    <div data-layout="canvas" className="w-full min-w-0 space-y-3 px-3 py-2">
      <p className="whitespace-pre-wrap break-words">{layout.summary}</p>
      {canvas ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Open ${layout.title} in Canvas`}
          aria-pressed={showing}
          onClick={() => canvas.show(layoutCanvasItem(layout, messageId, chatId))}
        >
          <PanelRightIcon aria-hidden />
          <span className="truncate">{layout.title}</span>
        </Button>
      ) : (
        <LayoutSurface layout={layout} chatId={chatId} size="compact" messageId={messageId} />
      )}
      {notice}
    </div>
  );
}

/** The full layout in a Canvas tab. */
export function LayoutCanvas({ layout, messageId, chatId }: { layout: Layout; messageId: string; chatId: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <LayoutSurface layout={layout} chatId={chatId} size="full" messageId={messageId} />
    </div>
  );
}

/** The layout of a reply that is still streaming. A Canvas reply names its report until it is saved and opens in Canvas. */
export function LayoutPreview({ chatId, turnId, json }: { chatId: string; turnId: string; json: string }) {
  const preview = useMemo(() => layoutPreview(json, `preview_${turnId}`), [json, turnId]);
  const adapters = useLayoutAdapters(chatId);
  if (!preview?.placement) return null;
  if (preview.placement === 'canvas')
    return (
      <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
        {preview.title ? `Preparing ${preview.title} for Canvas…` : 'Preparing a report for Canvas…'}
      </p>
    );
  return (
    <div data-layout="chat" aria-busy="true" className="w-full min-w-0 px-3 py-2">
      <A2uiSurface
        messages={preview.messages}
        catalogs={catalogs}
        adapters={adapters}
        size="compact"
        streaming
        readOnly
        allowUrl={layoutAllowUrl}
      />
    </div>
  );
}
