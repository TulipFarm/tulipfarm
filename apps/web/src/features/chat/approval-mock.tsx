import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'reicon-react/icons/Check';
import { Database } from 'reicon-react/icons/Database';
import { ArrowRight } from 'reicon-react/icons/ArrowRight';
import { Danger } from 'reicon-react/icons/Danger';
import { X } from 'reicon-react/icons/X';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { CanvasPanel, CanvasToggle, ChatSplit } from '@tulipfarm/sprout/canvas';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Message, MessageBubble, MessageContent } from '@tulipfarm/sprout/message';
import { ChatHeaderContext } from './header-context';
import { Composer } from './composer';
import { models } from './composer-options';
import { emptyChatDocument } from './editor-extensions';
import { parseChatDraft, type ChatDraft } from './editor-document';
import { chatDocumentText } from '@tulipfarm/conversations/rich-content';
import './conversation.css';

type Phase = 'review' | 'approving' | 'working' | 'success' | 'error' | 'rejected';
type Scenario = 'single' | 'multiple' | 'failure' | 'slow';
const scenarios: Record<Scenario, string> = {
  single: 'One table',
  multiple: 'Three tables',
  failure: 'Failed creation',
  slow: 'Slow response',
};
const phases: Record<Phase, string> = {
  review: 'Review',
  approving: 'Approving',
  working: 'In progress',
  success: 'Success',
  error: 'Error',
  rejected: 'Rejected',
};
const tables = [
  { name: 'Customers', fields: ['Name', 'Email', 'Company', 'Phone', 'Status'] },
  { name: 'Contacts', fields: ['Name', 'Email', 'Phone'] },
  { name: 'Companies', fields: ['Name', 'Website', 'Industry'] },
];
const emptyDraft = (): ChatDraft => ({ version: 1, doc: structuredClone(emptyChatDocument) });

export default function ApprovalPreview() {
  const header = useContext(ChatHeaderContext);
  const [scenario, setScenario] = useState<Scenario>('single');
  const [phase, setPhase] = useState<Phase>('review');
  const [playing, setPlaying] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [open, setOpen] = useState(() => window.innerWidth >= 768);
  const [showRows, setShowRows] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [messages, setMessages] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [modelId, setModelId] = useState('gpt-sol');
  const parsedDraft = parseChatDraft(draft);
  const draftText = parsedDraft.success ? chatDocumentText(parsedDraft.data) : '';
  const heading = useRef<HTMLHeadingElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const activeTables = scenario === 'multiple' ? tables : tables.slice(0, 1);
  const total = activeTables.length;
  const busy = phase === 'approving' || phase === 'working';
  const done = phase === 'success';
  const reset = (next: Scenario = scenario) => {
    setScenario(next);
    setPhase('review');
    setPlaying(false);
    setCompleted(0);
    setShowRows(false);
    setNotice('');
  };
  const setPreviewPhase = (next: Phase) => {
    setPlaying(false);
    setPhase(next);
    setCompleted(next === 'success' ? total : 0);
    setShowRows(false);
  };
  const approve = () => {
    if (busy) return;
    setCompleted(0);
    setPhase('approving');
    setPlaying(true);
    setNotice('');
  };
  useEffect(() => {
    if (!playing) return;
    const delay = scenario === 'slow' ? 9000 : phase === 'approving' ? 1100 : 1800;
    const timer = window.setTimeout(() => {
      if (phase === 'approving') setPhase('working');
      else if (phase === 'working') {
        if (scenario === 'failure') {
          setPhase('error');
          setPlaying(false);
        } else if (completed + 1 >= total) {
          setCompleted(total);
          setPhase('success');
          setPlaying(false);
        } else setCompleted(value => value + 1);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, phase, scenario, completed, total]);
  useEffect(() => {
    if (!busy && action.current === document.activeElement) heading.current?.focus();
  }, [busy]);
  const title =
    phase === 'review'
      ? 'Ready for your approval'
      : phase === 'approving'
        ? 'Recording your approval'
        : phase === 'working'
          ? `Creating ${activeTables[completed]?.name ?? 'tables'}`
          : done
            ? total === 1
              ? 'Customers table created'
              : 'All 3 tables created'
            : phase === 'error'
              ? 'Customers was not created'
              : 'Proposal rejected';
  const review = () => {
    setShowRows(false);
    setOpen(true);
  };
  const viewResult = () => {
    setShowRows(true);
    setOpen(true);
  };

  return (
    <>
      {header &&
        createPortal(
          <>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Add customer storage</h1>
            <CanvasToggle open={open} count={1} onToggle={() => setOpen(value => !value)} />
          </>,
          header,
        )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted px-4 py-2 text-xs">
        <span className="font-medium text-foreground">Local mock</span>
        <span className="text-muted-foreground">No real changes</span>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select
            value={scenario}
            onValueChange={value => {
              if (value && value in scenarios) reset(value as Scenario);
            }}
            items={scenarios}
          >
            <SelectTrigger size="sm" aria-label="Mock scenario">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(scenarios).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={phase}
            onValueChange={value => {
              if (value && value in phases) setPreviewPhase(value as Phase);
            }}
            items={phases}
          >
            <SelectTrigger size="sm" aria-label="Mock state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(phases).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={() => reset()}>
            Reset
          </Button>
        </div>
      </div>
      <ChatSplit
        open={open}
        onOpenChange={setOpen}
        layoutId="approval-mock:split"
        chat={
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              ref={timeline}
              role="region"
              aria-label="Conversation"
              tabIndex={0}
              className="conversation-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6"
            >
              <div className="mx-auto max-w-3xl space-y-7 py-8">
                <Message align="end">
                  <MessageContent>
                    <MessageBubble variant="secondary">
                      Create a Customers table with Name, Email, Company, Phone, and Status.
                    </MessageBubble>
                  </MessageContent>
                </Message>
                <div className="space-y-4">
                  <p className="text-base text-foreground">Here are the changes for your review.</p>
                  <p className="max-w-prose text-base">
                    Name is required. Email, company, and phone are optional. Status can be Prospect, Active, or
                    Inactive.
                  </p>
                  <div className="flex items-center gap-3 py-2">
                    <span className="text-muted-foreground">
                      <Database size={18} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        {total === 1 ? 'Customers' : 'Customers, Contacts, Companies'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {total} new {total === 1 ? 'table' : 'tables'} · No rows added
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={review}>
                      Review changes
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The approval area below stays within reach while you review.
                  </p>
                </div>
                {messages.map((text, index) => (
                  <Message key={index} align="end">
                    <MessageContent>
                      <MessageBubble variant="secondary">{text}</MessageBubble>
                    </MessageContent>
                  </Message>
                ))}
                {done && (
                  <div className="flex items-start gap-2 text-sm">
                    <span className="text-success">
                      <Check size={18} aria-hidden="true" />
                    </span>
                    <p>
                      {total === 1 ? 'Customers is ready.' : 'Customers, Contacts, and Companies are ready.'} Your new{' '}
                      {total === 1 ? 'table has' : 'tables have'} no rows yet.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <footer className="shrink-0 px-3 pt-2 pb-3 sm:px-6 sm:pb-5">
              <div className="mx-auto max-w-3xl space-y-3">
                <section aria-label="Approval" className="overflow-hidden rounded-xl border border-input bg-card">
                  <div
                    className={
                      done
                        ? 'flex items-start gap-3 bg-success-subtle px-4 py-3 text-success'
                        : 'flex items-start gap-3 px-4 pt-4 pb-3'
                    }
                  >
                    <span
                      className={
                        done
                          ? 'mt-0.5 shrink-0'
                          : phase === 'error'
                            ? 'mt-0.5 shrink-0 text-destructive'
                            : 'mt-0.5 shrink-0 text-muted-foreground'
                      }
                    >
                      {busy ? (
                        <Spinner aria-hidden="true" />
                      ) : done ? (
                        <Check size={20} aria-hidden="true" />
                      ) : phase === 'error' ? (
                        <Danger size={20} aria-hidden="true" />
                      ) : phase === 'rejected' ? (
                        <X size={20} aria-hidden="true" />
                      ) : (
                        <Database size={20} aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 ref={heading} tabIndex={-1} className="text-base font-medium wrap-anywhere">
                        {title}
                      </h2>
                      <p role="status" className={done ? 'mt-0.5 text-sm' : 'mt-0.5 text-sm text-muted-foreground'}>
                        {phase === 'review'
                          ? `${total} ${total === 1 ? 'change' : 'changes'} to review. Nothing has been created yet.`
                          : phase === 'approving'
                            ? 'Please wait. Do not approve again.'
                            : phase === 'working'
                              ? `${completed} of ${total} tables created. ${scenario === 'slow' ? 'This is taking longer than usual.' : 'Applying the changes you approved.'}`
                              : done
                                ? `${total} of ${total} tables created successfully.`
                                : phase === 'error'
                                  ? 'Creation failed. No changes were applied.'
                                  : 'No changes were applied.'}
                      </p>
                    </div>
                  </div>
                  {phase === 'review' && (
                    <div className="max-h-48 overflow-y-auto px-4">
                      <ul className="divide-y border-y">
                        {activeTables.map(table => (
                          <li key={table.name} className="flex items-center gap-3 py-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground">Create {table.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {table.fields.length} fields · Empty table
                              </p>
                            </div>
                            <Badge variant="secondary">New table</Badge>
                          </li>
                        ))}
                      </ul>
                      <div className="py-2 text-xs text-muted-foreground">
                        <Collapsible>
                          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                            Approval details
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <p className="pt-2 pb-1 leading-relaxed">
                              Only the listed changes are approved. Each table applies as one unit. Completed tables
                              stay applied if later work stops. Approval does not grant missing permissions.
                            </p>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </div>
                  )}
                  {busy && (
                    <ol aria-label="Creation progress" className="flex flex-wrap gap-x-4 gap-y-2 px-4 pb-3 text-xs">
                      <li className="flex items-center gap-1.5 text-foreground">
                        {phase === 'approving' ? (
                          <span className="size-3 rounded-full bg-info" />
                        ) : (
                          <span className="text-success">
                            <Check size={14} aria-hidden="true" />
                          </span>
                        )}
                        Approval
                      </li>
                      <li className="flex items-center gap-1.5 text-foreground">
                        <span
                          className={
                            phase === 'working'
                              ? 'size-3 rounded-full bg-info'
                              : 'size-3 rounded-full border border-field'
                          }
                        />
                        Create {total === 1 ? 'table' : 'tables'}
                      </li>
                      <li className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-3 rounded-full border border-field" />
                        Ready
                      </li>
                    </ol>
                  )}
                  {phase === 'error' && (
                    <div className="px-4 pb-2">
                      <Alert variant="destructive">
                        <AlertDescription>
                          This is a simulated creation error. Review the proposal, then try again.
                        </AlertDescription>
                      </Alert>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={phase === 'review' ? () => setPhase('rejected') : review}
                    >
                      {phase === 'review' ? 'Reject' : 'Review changes'}
                    </Button>
                    <Button
                      ref={action}
                      size="lg"
                      variant={phase === 'rejected' ? 'outline' : 'default'}
                      disabled={busy}
                      aria-busy={busy}
                      onClick={done ? viewResult : phase === 'rejected' ? () => reset() : approve}
                    >
                      {phase === 'review'
                        ? 'Approve & create'
                        : phase === 'approving'
                          ? 'Approving...'
                          : phase === 'working'
                            ? 'Creating...'
                            : done
                              ? total === 1
                                ? 'View table'
                                : 'View tables'
                              : phase === 'error'
                                ? 'Retry creation'
                                : 'Review again'}
                      {done && <ArrowRight size={16} aria-hidden="true" />}
                    </Button>
                  </div>
                </section>
                <Composer
                  content={draft}
                  onContentChange={setDraft}
                  placeholder="Reply or ask for a change..."
                  canSend={!!draftText.trim()}
                  onSend={() => {
                    setMessages(value => [...value, draftText]);
                    setDraft(emptyDraft());
                    setNotice('Message added to this mock only. No agent is running.');
                    requestAnimationFrame(() => timeline.current?.scrollTo({ top: timeline.current.scrollHeight }));
                  }}
                  onFiles={() => setNotice('File uploads are not enabled in this local mock.')}
                  model={models.find(model => model.id === modelId) ?? null}
                  models={models}
                  onModelChange={setModelId}
                />
                {notice && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {notice}
                  </p>
                )}
                <p className="text-center text-xs text-muted-foreground">
                  TulipFarm can make mistakes. Check important details.
                </p>
              </div>
            </footer>
          </div>
        }
        canvas={
          <CanvasPanel
            tabs={[{ id: 'approval', title: showRows ? 'Created tables' : 'Proposed changes', icon: Database }]}
            activeId="approval"
            onSelect={() => {}}
            onCloseTab={() => setOpen(false)}
            onClose={() => setOpen(false)}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-5">
                <div>
                  <h2 className="text-xl font-medium text-foreground">
                    {showRows ? 'Your new tables' : 'Changes to review'}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {total} {total === 1 ? 'table' : 'tables'} ·{' '}
                    {activeTables.reduce((sum, table) => sum + table.fields.length, 0)} fields · No rows added
                  </p>
                </div>
                <Badge
                  variant={
                    done ? 'success' : phase === 'error' ? 'destructive' : phase === 'rejected' ? 'secondary' : 'info'
                  }
                >
                  {done
                    ? 'Created'
                    : phase === 'error'
                      ? 'Failed'
                      : phase === 'rejected'
                        ? 'Rejected'
                        : busy
                          ? 'In progress'
                          : 'Not yet applied'}
                </Badge>
              </div>
              <div className="min-h-0 flex-1 space-y-6 overflow-auto p-5">
                {activeTables.map(table => (
                  <section
                    key={table.name}
                    aria-label={`${table.name} schema`}
                    className="overflow-hidden rounded-xl border"
                  >
                    <header className="flex items-center gap-2 border-b bg-muted px-4 py-3">
                      <Database size={18} aria-hidden="true" />
                      <h3 className="flex-1 text-base font-medium text-foreground">{table.name}</h3>
                      <span className="text-xs text-muted-foreground">{table.fields.length} fields</span>
                    </header>
                    <ul className="divide-y">
                      {table.fields.map((field, index) => (
                        <li key={field} className="px-4 py-3">
                          <div className="flex items-center gap-3 text-sm">
                            <span className="min-w-0 flex-1 font-medium text-foreground">{field}</span>
                            {index === 0 && <span className="text-xs text-muted-foreground">Required</span>}
                            <span className="w-12 text-right text-muted-foreground">
                              {field === 'Status' ? 'Select' : 'Text'}
                            </span>
                          </div>
                          {field === 'Status' && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {['Prospect', 'Active', 'Inactive'].map(option => (
                                <Badge key={option} variant="secondary">
                                  {option}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {showRows && (
                      <div className="border-t bg-muted px-4 py-6 text-center">
                        <p className="text-sm font-medium">No customers or records yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Only the table structure was created in this mock.
                        </p>
                      </div>
                    )}
                  </section>
                ))}
                {!showRows && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Existing tables and rows will not change. Optional fields can be left blank.
                  </p>
                )}
              </div>
              <div className="border-t px-5 py-3 text-sm text-muted-foreground">
                {done
                  ? 'Creation complete. The result stays in your chat.'
                  : 'Use the approval area at the bottom of the chat.'}
              </div>
            </div>
          </CanvasPanel>
        }
      />
    </>
  );
}
