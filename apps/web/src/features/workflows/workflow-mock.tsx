import { useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { ArrowLeft } from 'reicon-react/icons/ArrowLeft';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { chatDocumentText } from '@tulipfarm/conversations/rich-content';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { CanvasPanel, CanvasToggle, ChatSplit } from '@tulipfarm/sprout/canvas';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Message, MessageBubble, MessageContent } from '@tulipfarm/sprout/message';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import type { RichTextEditorHandle } from '@tulipfarm/sprout/rich-text-editor';
import { ChatHeaderContext } from '@/features/chat/header-context';
import { Composer } from '@/features/chat/composer';
import { defaultModel } from '@/features/chat/composer-options';
import { emptyChatDocument } from '@/features/chat/editor-extensions';
import { parseChatDraft, type ChatDraft } from '@/features/chat/editor-document';
import { WorkflowViewer } from './workflow-viewer';
import {
  isMockPhase,
  isMockScenario,
  mockId,
  mockPhases,
  mockScenarios,
  mockTriggers,
  mockWorkflowView,
  type MockPhase,
  type MockScenario,
} from './workflow-mock-api';

export default function WorkflowMock({ surface = 'page' }: { surface?: 'page' | 'chat' }) {
  const header = useContext(ChatHeaderContext);
  const search = new URLSearchParams(window.location.search);
  const [scenario, setScenario] = useState<MockScenario>(() => {
    const value = search.get('scenario');
    return isMockScenario(value) ? value : 'pr';
  });
  const [phase, setPhase] = useState<MockPhase>(() => {
    const value = search.get('state');
    return isMockPhase(value) ? value : 'draft';
  });
  const [trigger, setTrigger] = useState<keyof typeof mockTriggers | null>(null);
  const [open, setOpen] = useState(() => window.innerWidth >= 768);
  const [tabOpen, setTabOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<ChatDraft>(() => ({
    version: 1,
    doc: search.get('edit')
      ? {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Help me edit this workflow. Read its current definition first and ask what I want to change.',
                },
              ],
            },
          ],
        }
      : structuredClone(emptyChatDocument),
  }));
  const input = useRef<RichTextEditorHandle>(null);
  const parsed = parseChatDraft(draft);
  const canSend = parsed.success && chatDocumentText(parsed.data).trim().length > 0;
  const view = useMemo(
    () => mockWorkflowView(scenario, phase, trigger ? mockTriggers[trigger] : undefined),
    [scenario, phase, trigger],
  );
  const chatUrl = `/workflow-mock/chat/${mockId}?scenario=${scenario}&state=${phase}`;
  const change = (nextScenario: MockScenario, nextPhase: MockPhase) => {
    setScenario(nextScenario);
    setPhase(nextPhase);
    setNotice('');
    const url = new URL(window.location.href);
    url.searchParams.set('scenario', nextScenario);
    url.searchParams.set('state', nextPhase);
    window.history.replaceState(window.history.state, '', url);
  };
  const edit = () => {
    if (surface === 'page') {
      window.location.assign(`${chatUrl}&edit=1`);
      return;
    }
    const prompt = `Help me edit "${view.definition.name}". Read its current definition first, then ask what I want to change.`;
    setDraft(current => ({
      version: 1,
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: prompt }] }, ...(current.doc.content ?? [])],
      },
    }));
    setOpen(false);
    setNotice('Your edit request is in the composer. Nothing has been sent.');
    window.setTimeout(() => input.current?.focus(), 0);
  };
  const refresh = () => {
    if (['error', 'denied', 'stale', 'loading'].includes(phase)) change(scenario, 'draft');
    else setNotice('Local sample refreshed. No server request was sent.');
  };
  const show = () => {
    setTabOpen(true);
    setOpen(true);
  };
  const mockControls = (
    <div className="workflow-mock-controls">
      <p className="text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">Local mock.</strong> No real changes.
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          value={scenario}
          items={mockScenarios}
          onValueChange={value => {
            if (isMockScenario(value)) {
              setTrigger(null);
              change(value, phase);
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="Mock workflow">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(mockScenarios).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={phase}
          items={mockPhases}
          onValueChange={value => {
            if (isMockPhase(value)) change(scenario, value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Mock state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(mockPhases).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {scenario === 'catalog' && (
          <Select
            value={trigger ?? 'record'}
            onValueChange={value => {
              if (typeof value === 'string' && value in mockTriggers) setTrigger(value as keyof typeof mockTriggers);
            }}
          >
            <SelectTrigger size="sm" aria-label="Mock trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(mockTriggers).map(value => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            change(scenario, phase === 'running' ? 'waiting' : phase === 'waiting' ? 'completed' : 'running')
          }
        >
          Next state
        </Button>
      </div>
    </div>
  );
  const content =
    phase === 'loading' ? (
      <div className="min-h-96 space-y-5 p-6" role="status" aria-label="Loading workflow">
        <Skeleton shape="title" />
        <Skeleton shape="panel" />
        <p className="text-sm text-muted-foreground">Loading workflow...</p>
        <Button variant="outline" size="sm" onClick={refresh}>
          Finish sample load
        </Button>
      </div>
    ) : phase === 'empty' ? (
      <StatePanel
        kind="empty"
        icon={BranchDown}
        title="No workflows yet"
        description="Describe the work you want to repeat. Chat will prepare a workflow for your review."
      >
        <Button onClick={edit}>Create in chat</Button>
      </StatePanel>
    ) : phase === 'denied' ? (
      <StatePanel
        kind="unavailable"
        title="Workflow unavailable"
        description="Your access changed. The workflow and its details have been cleared."
      >
        <Button variant="outline" onClick={refresh}>
          Recheck access
        </Button>
      </StatePanel>
    ) : phase === 'error' ? (
      <StatePanel
        kind="error"
        title="Could not load workflow"
        description="The workflow state is unknown. Retry without changing it."
      >
        <Button variant="outline" onClick={refresh}>
          Retry loading
        </Button>
      </StatePanel>
    ) : phase === 'dismissed' ? (
      <StatePanel
        kind="empty"
        title="Draft dismissed"
        description="This is a local sample. Nothing was saved or activated."
      >
        <Button variant="outline" onClick={() => change(scenario, 'draft')}>
          Review again
        </Button>
      </StatePanel>
    ) : (
      <WorkflowViewer
        view={view}
        surface={surface === 'chat' ? 'canvas' : 'page'}
        onEdit={edit}
        onRefresh={refresh}
        onTask={() =>
          setNotice(
            'Sample task: the operations assistant is preparing a purchase recommendation. Live task navigation is not connected in this mock.',
          )
        }
      />
    );
  const feedback = notice && (
    <Alert>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );
  if (surface === 'page')
    return (
      <PageContent>
        <PageHeader
          title="Workflows"
          actions={
            <Button variant="outline" size="sm" nativeButton={false} render={<a href={chatUrl} />}>
              Open in chat
              <ArrowUpRight size={14} aria-hidden="true" />
            </Button>
          }
        />
        {mockControls}
        {feedback}
        <div className="workflow-mock-page">{content}</div>
      </PageContent>
    );
  return (
    <>
      {header &&
        createPortal(
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              nativeButton={false}
              render={<a href="/workflow-mock/workflows" />}
              aria-label="Back to workflows"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Review a workflow</h1>
            <CanvasToggle open={open} count={tabOpen ? 1 : 0} onToggle={() => setOpen(value => !value)} />
          </>,
          header,
        )}
      {mockControls}
      <ChatSplit
        open={open}
        onOpenChange={setOpen}
        layoutId="workflow-mock:split"
        chat={
          <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-7 sm:px-6">
              <div className="mx-auto max-w-3xl space-y-7">
                <Message align="end">
                  <MessageContent>
                    <MessageBubble variant="secondary">
                      {scenario === 'pr'
                        ? 'Notify #engineering whenever a pull request is opened. Include its title, author, and link.'
                        : `Help me set up ${view.definition.name.toLowerCase()}. Show me how it will run.`}
                    </MessageBubble>
                  </MessageContent>
                </Message>
                <p className="text-base text-foreground">
                  The workflow is ready to review. Select a step in Canvas to see what it does and who acts.
                </p>
                <div className="flex items-start gap-3 rounded-xl border border-input p-4">
                  <span className="mt-1 text-primary-text">
                    <BranchDown size={20} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="wrap-anywhere text-sm font-medium text-foreground">{view.definition.name}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary">{view.source}</Badge>
                      {view.definition.steps.length} steps / view only
                    </div>
                    <Button variant="link" size="sm" onClick={show}>
                      View workflow
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {feedback}
              </div>
            </div>
            <footer className="shrink-0 space-y-3 px-3 pt-2 pb-4 sm:px-6">
              <section
                aria-label="Workflow review"
                className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-input bg-card p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">Review before saving</p>
                  <p className="text-xs text-muted-foreground">This sample cannot change a real workflow.</p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={phase !== 'draft'}
                    onClick={() => change(scenario, 'dismissed')}
                  >
                    Not now
                  </Button>
                  <Button
                    size="sm"
                    disabled={phase !== 'draft'}
                    onClick={() => {
                      change(scenario, 'saved');
                      setNotice('Sample saved state only. No workflow was saved or activated.');
                    }}
                  >
                    Save workflow
                  </Button>
                </div>
              </section>
              <div className="mx-auto max-w-3xl">
                <Composer
                  content={draft}
                  inputRef={input}
                  onContentChange={setDraft}
                  canSend={canSend}
                  onSend={() => setNotice('Local mock: your message was not sent. Your draft is kept.')}
                  onFiles={() => setNotice('Files are not uploaded in this local mock.')}
                  model={defaultModel}
                  models={[defaultModel]}
                  onModelChange={() => setNotice('Model changes are not connected in this local mock.')}
                  placeholder="Describe what you want to change..."
                />
              </div>
            </footer>
          </section>
        }
        canvas={
          <CanvasPanel
            tabs={tabOpen ? [{ id: 'workflow', title: 'Workflow', icon: BranchDown }] : []}
            activeId={tabOpen ? 'workflow' : null}
            onSelect={show}
            onCloseTab={() => setTabOpen(false)}
            onClose={() => setOpen(false)}
          >
            {tabOpen ? (
              content
            ) : (
              <StatePanel
                kind="empty"
                title="No workflow open"
                description="Your review and message draft are kept in chat."
              >
                <Button variant="outline" onClick={show}>
                  Open workflow
                </Button>
              </StatePanel>
            )}
          </CanvasPanel>
        }
      />
    </>
  );
}
