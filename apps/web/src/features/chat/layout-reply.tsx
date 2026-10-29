import { useEffect, useMemo, useRef } from 'react';
import { A2uiSurface, sproutAdapters, type A2uiAction, type A2uiAdapterProps } from '@tulipfarm/sprout/a2ui';
import { MessageBubble } from '@tulipfarm/sprout/message';
import { ResultCard, type ResultCardKind } from '@tulipfarm/sprout/result-card';
import { canvasSplitMinWidth } from '@tulipfarm/sprout/canvas';
import {
  checkLayout,
  layoutAllowUrl,
  tulipfarmCatalog,
  type EmbedReference,
  type Layout,
} from '@tulipfarm/conversations/layout-contracts';
import { workspaceRoute } from '@/router';
import { useOptionalCanvas, type CanvasContent, type CanvasItem } from './canvas-state';
import { ConversationFileReference } from './file-mentions';

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
  if (ref.kind === 'workspace-file')
    return <ConversationFileReference workspaceId={workspace.id} slug={workspace.slug} fileId={ref.fileId} />;
  const title = embedTitle(ref);
  const content = embedContent(ref, workspace.id, chatId);
  return (
    <ResultCard
      title={title}
      kind={embedNames[ref.kind].kind}
      apps={[]}
      status={content ? 'Ready to review.' : 'Open it from the chat.'}
      action={
        content && canvas
          ? { label: 'Open in Canvas', onClick: () => canvas.show({ id: embedId(ref), title, content }) }
          : undefined
      }
    />
  );
}

function useLayoutActions(layout: Layout, messageId: string, chatId: string) {
  const canvas = useOptionalCanvas();
  return (action: A2uiAction) => {
    if (!canvas) return;
    if (action.type === 'send') canvas.requestComposer(action.text);
    else canvas.show(layoutCanvasItem(layout, messageId, chatId));
  };
}

export function layoutCanvasItem(layout: Layout, messageId: string, chatId: string): CanvasItem {
  return { id: `layout:${messageId}`, title: layout.title, content: { kind: 'layout', layout, messageId, chatId } };
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
  const onAction = useLayoutActions(layout, messageId, chatId);
  const adapters = useMemo(
    () => ({
      ...sproutAdapters,
      Embed: (props: A2uiAdapterProps<{ ref: EmbedReference }>) => (
        <EmbedAdapter props={props.props} context={props.context} chatId={chatId} />
      ),
    }),
    [chatId],
  );
  return (
    <A2uiSurface
      messages={layout.messages}
      catalog={tulipfarmCatalog}
      adapters={adapters}
      size={size}
      streaming={streaming}
      onAction={onAction}
      allowUrl={layoutAllowUrl}
    />
  );
}

/** An assistant reply drawn from its saved layout. A canvas reply shows its summary here and its layout in Canvas, which opens by itself while it is the chat's latest reply. */
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
      {!canvas && <LayoutSurface layout={layout} chatId={chatId} size="compact" messageId={messageId} />}
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
