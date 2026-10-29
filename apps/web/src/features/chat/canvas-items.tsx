import { useEffect, useState, type ComponentType } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { ChartBar } from 'reicon-react/icons/ChartBar';
import { Code } from 'reicon-react/icons/Code';
import { FileText } from 'reicon-react/icons/FileText';
import { Globe } from 'reicon-react/icons/Globe';
import { Database } from 'reicon-react/icons/Database';
import { Tasks } from 'reicon-react/icons/Tasks';
import { Button } from '@tulipfarm/sprout/button';
import { CanvasFrame, CanvasPanel, CanvasSection, CanvasToggle, ChatSplit } from '@tulipfarm/sprout/canvas';
import { CategoryChart } from '@tulipfarm/sprout/chart';
import { ChatPlan } from '@tulipfarm/sprout/chat-plan';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { FileContent, FileError, LoadingFile, ViewableFileContent } from '@tulipfarm/sprout/file-viewer';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Table } from '@tulipfarm/sprout/table';
import { useFilesApi } from '@/features/files/api';
import { fileRenderers } from '@/features/files/viewer/renderers';
import { renderableType } from '@/lib/file-viewer';
import { useCanvas, type CanvasContent, type CanvasItem } from './canvas-state';
import { PlanCanvas } from './plans';
import { SchemaCanvas } from './schema-canvas';
import { RecordChangesCanvas, RecordsCanvas } from './records-canvas';
import { CalendarReadCanvas } from './calendar-canvas';
import { Calendar } from 'reicon-react/icons/Calendar';
import { GoogleProposalReview } from '@/features/google/proposals';
import { WorkflowCanvas } from './workflow-canvas';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { workspaceRoute } from '@/router';
import { GoogleFileCanvas } from '@/features/google/file-canvas';
import { ActivityResultDetails } from './activity-result-card';
import { GitHubBatches } from './github-batches';
import { SlackActionCanvas } from '@/features/agents/slack-action';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { LayoutCanvas } from './layout-reply';
import { PackageInstallationCanvas } from '@/features/packages/package-canvas';
import { PackagePlanOutline } from '@/features/packages/progress';

const icons: Record<CanvasContent['kind'], ComponentType<{ size?: number }>> = {
  'package-plan': Tasks,
  'package-installation': Tasks,
  layout: Sparkle,
  'activity-result': Tasks,
  'github-batch': Code,
  'slack-action': Tasks,
  'google-action': FileText,
  'google-file': FileText,
  workflow: BranchDown,
  records: Database,
  'record-changes': Database,
  table: Database,
  schema: Database,
  chart: ChartBar,
  todo: Tasks,
  plan: Tasks,
  code: Code,
  browser: Globe,
  file: FileText,
  'workspace-file': FileText,
  'calendar-read': Calendar,
  'calendar-action': Calendar,
};

export function ChatWithCanvas({
  children,
  onRetry,
  enabled = true,
}: {
  children: React.ReactNode;
  onRetry?: (item: CanvasItem) => void;
  enabled?: boolean;
}) {
  const canvas = useCanvas();
  return (
    <ChatSplit
      open={enabled && canvas.open}
      onOpenChange={canvas.setOpen}
      canvasSize={65}
      chat={children}
      canvas={
        <CanvasPanel
          tabs={canvas.items.map(item => ({
            id: item.id,
            title: item.title,
            icon: icons[item.content.kind],
            busy: item.status === 'loading',
          }))}
          activeId={canvas.activeId}
          onSelect={canvas.select}
          onCloseTab={canvas.close}
          onClose={() => canvas.setOpen(false)}
          activity={
            canvas.attention ? (
              <div className="border-b px-4 py-2">
                <Button variant="link" size="sm" onClick={() => canvas.setOpen(false)}>
                  {canvas.attention}. Back to chat
                </Button>
              </div>
            ) : undefined
          }
        >
          {canvas.items.map(item => (
            <div
              key={item.id}
              hidden={item.id !== canvas.activeId}
              className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
            >
              <CanvasItemView item={item} onRetry={onRetry} />
            </div>
          ))}
        </CanvasPanel>
      }
    />
  );
}

export function CanvasItemView({
  item,
  onRetry,
}: {
  item: CanvasItem;
  onRetry?: ((item: CanvasItem) => void) | undefined;
}) {
  if (item.status === 'loading')
    return (
      <CanvasSection title={item.title} meta="Preparing…">
        <div role="status" aria-label={`Loading ${item.title}`} className="space-y-3">
          <Skeleton shape="title" />
          <Skeleton />
          <Skeleton />
          <Skeleton shape="panel" />
        </div>
      </CanvasSection>
    );
  if (item.status === 'error')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title={`Couldn’t load ${item.title}`}
        description="The result didn’t arrive. Your chat is unchanged."
      >
        {onRetry ? (
          <Button variant="outline" onClick={() => onRetry(item)}>
            Try again
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Ask again in the chat.</p>
        )}
      </StatePanel>
    );
  const content = item.content;
  switch (content.kind) {
    case 'package-plan':
      return (
        <CanvasSection title={item.title}>
          <PackagePlanOutline document={content.document} order={content.order} />
          <p className="text-sm text-muted-foreground">
            Choose workspace inputs and install in chat. Nothing has been installed yet.
          </p>
        </CanvasSection>
      );
    case 'package-installation':
      return (
        <PackageInstallationCanvas
          workspaceId={content.workspaceId}
          chatId={content.chatId}
          installationId={content.installationId}
        />
      );
    case 'layout':
      return <LayoutCanvas layout={content.layout} messageId={content.messageId} chatId={content.chatId} />;
    case 'activity-result':
      return <ActivityResultDetails items={content.items} />;
    case 'github-batch':
      return (
        <CanvasSection>
          <GitHubBatches
            workspaceId={content.workspaceId}
            chatId={content.chatId}
            batchId={content.batchId}
            task={content.task}
            revision=""
            variant="review"
          />
        </CanvasSection>
      );
    case 'slack-action':
      return (
        <CanvasSection>
          <SlackActionCanvas workspaceId={content.workspaceId} actionId={content.actionId} />
        </CanvasSection>
      );
    case 'workflow':
      return <WorkflowCanvas workspaceId={content.workspaceId} reference={content.reference} />;
    case 'records':
      return <RecordsCanvas reference={content.reference} />;
    case 'record-changes':
      return <RecordChangesCanvas change={content.change} />;
    case 'calendar-read':
      return <CalendarReadCanvas result={content.result} />;
    case 'calendar-action':
      return (
        <CanvasSection>
          <GoogleProposalReview
            workspaceId={content.workspaceId}
            proposalId={content.proposalId}
            available
            focusOnLoad={false}
            variant="canvas"
          />
        </CanvasSection>
      );
    case 'google-action':
      return (
        <CanvasSection>
          <GoogleProposalReview
            workspaceId={content.workspaceId}
            proposalId={content.proposalId}
            available
            focusOnLoad={false}
            variant="canvas"
          />
        </CanvasSection>
      );
    case 'google-file':
      return <GoogleFileCanvas workspaceId={content.workspaceId} fileId={content.fileId} />;
    case 'table':
      return (
        <CanvasSection title={item.title} meta={`${content.rows.length} ${content.rows.length === 1 ? 'row' : 'rows'}`}>
          <div className="overflow-hidden rounded-xl border">
            <Table<Record<string, string | number>>
              aria-label={item.title}
              caption={content.caption}
              data={content.rows.map((cells, index) => ({
                id: String(index),
                ...Object.fromEntries(cells.map((cell, column) => [`c${column}`, cell])),
              }))}
              columns={content.columns.map((header, column) => ({ key: `c${column}`, header }))}
              getRowId={row => String(row.id)}
            />
          </div>
        </CanvasSection>
      );
    case 'chart':
      return (
        <CanvasSection title={item.title}>
          <CategoryChart rows={content.rows} category={content.category} series={content.series} />
        </CanvasSection>
      );
    case 'todo':
      return (
        <CanvasSection>
          <ChatPlan title={item.title} steps={content.steps} />
        </CanvasSection>
      );
    case 'plan':
      return (
        <PlanCanvas
          workspaceId={content.workspaceId}
          chatId={content.chatId}
          planId={content.planId}
          title={item.title}
        />
      );
    case 'schema':
      return (
        <SchemaCanvas
          workspaceId={content.workspaceId}
          chatId={content.chatId}
          proposalId={content.proposalId}
          title={item.title}
        />
      );
    case 'code':
      return (
        <CanvasSection>
          <CodeBlock code={content.code} language={content.language} filename={content.filename ?? item.title} />
        </CanvasSection>
      );
    case 'browser':
      return (
        <CanvasSection
          title={item.title}
          meta={content.url}
          actions={
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<a href={content.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              Open in new tab
            </Button>
          }
        >
          <CanvasFrame src={content.url} title={item.title} />
        </CanvasSection>
      );
    case 'file':
      return <ViewableFileContent file={content.file} renderers={fileRenderers} />;
    case 'workspace-file':
      return (
        <WorkspaceFile
          workspaceId={content.workspaceId}
          fileId={content.fileId}
          name={content.name}
          mediaType={content.mediaType}
        />
      );
  }
}

type Loaded = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; bytes: ArrayBuffer; url: string };

function WorkspaceFile({
  workspaceId,
  fileId,
  name,
  mediaType,
}: {
  workspaceId: string;
  fileId: string;
  name: string;
  mediaType: string;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useFilesApi(workspaceId);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setContent({ kind: 'loading' });
    api.content(fileId, controller.signal).then(
      bytes => {
        url = URL.createObjectURL(new Blob([bytes], { type: renderableType(name, mediaType) }));
        setContent({ kind: 'ready', bytes, url });
      },
      () => {
        if (!controller.signal.aborted) setContent({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, fileId, name, mediaType, attempt]);
  const retry = () => setAttempt(value => value + 1);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40">
      <div className="shrink-0 border-b px-4 py-2">
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/files/$fileId" params={{ workspaceSlug: workspace.slug, fileId }} />}
        >
          Open in Files
        </Button>
      </div>
      {content.kind === 'loading' ? (
        <LoadingFile />
      ) : content.kind === 'failed' ? (
        <FileError message="The file content couldn’t be loaded. Your file is unchanged." onRetry={retry} />
      ) : (
        <FileContent
          name={name}
          mediaType={mediaType}
          bytes={content.bytes}
          url={content.url}
          onRetry={retry}
          renderers={fileRenderers}
        />
      )}
    </div>
  );
}

export function ChatCanvasToggle() {
  const canvas = useCanvas();
  return canvas.items.length ? (
    <CanvasToggle open={canvas.open} count={canvas.items.length} onToggle={canvas.toggle} />
  ) : null;
}
