import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { File } from 'reicon-react/icons/File';
import { Button } from '@tulipfarm/sprout/button';
import { CanvasPanel, CanvasToggle, ChatSplit } from '@tulipfarm/sprout/canvas';
import { ResultAppActions, ResultCard, type ResultApp, type ResultCardProps } from '@tulipfarm/sprout/result-card';
import { Message, MessageContent } from '@tulipfarm/sprout/message';
import { Bubble, BubbleContent } from '@/components/bubble';
import { ChatHeaderContext } from './header-context';
import { Composer } from './composer';
import { models } from './composer-options';
import { emptyChatDocument } from './editor-extensions';
import { type ChatDraft } from './editor-document';
import './conversation.css';

const examples = [
  {
    id: 'file',
    title: 'Investor pitch',
    kind: 'File',
    status: 'Saved in Google Slides',
    apps: [
      {
        brand: 'google-slides',
        name: 'Google Slides',
        actions: [
          { label: 'Created the investor pitch presentation', state: 'completed' },
          { label: 'Added the two pitch slides', state: 'completed' },
        ],
      },
    ],
    actionLabel: 'View slides',
    description: 'The presentation is saved. Open the result to review it.',
  },
  {
    id: 'plan',
    title: 'Prepare the investor update',
    kind: 'Plan',
    status: 'Presentation saved and email sent',
    apps: [
      {
        brand: 'google-slides',
        name: 'Google Slides',
        actions: [
          { label: 'Created the investor pitch presentation', state: 'completed' },
          { label: 'Added the two pitch slides', state: 'completed' },
        ],
      },
      { brand: 'gmail', name: 'Gmail', actions: [{ label: 'Sent the investor update email', state: 'completed' }] },
    ],
    actionLabel: 'View plan',
    description: 'The presentation is ready and the investor email has been sent.',
  },
  {
    id: 'workflow',
    title: 'Weekly team update',
    kind: 'Workflow',
    status: 'Update posted and emailed',
    apps: [
      { brand: 'slack', name: 'Slack', actions: [{ label: 'Posted the weekly update', state: 'completed' }] },
      {
        brand: 'google-sheets',
        name: 'Google Sheets',
        actions: [{ label: 'Read this week’s figures', state: 'completed' }],
      },
      {
        brand: 'github',
        name: 'GitHub',
        actions: [{ label: 'Read merged changes for the weekly update', state: 'completed' }],
      },
      {
        brand: 'google-docs',
        name: 'Google Docs',
        actions: [{ label: 'Saved the weekly update document', state: 'completed' }],
      },
      { brand: 'gmail', name: 'Gmail', actions: [{ label: 'Emailed the weekly summary', state: 'completed' }] },
    ],
    actionLabel: 'View result',
    description: 'The weekly update is saved, shared with the team, and emailed.',
  },
] satisfies (Omit<ResultCardProps, 'action'> & { id: string; actionLabel: string; description: string })[];

const stateExamples = [
  { id: 'default', label: 'Default', state: 'default', status: 'Ready for review' },
  { id: 'hover', label: 'Hover the button', state: 'default', status: 'Ready for review' },
  { id: 'focus', label: 'Focus with Tab', state: 'default', status: 'Ready for review' },
  { id: 'active', label: 'Press the button', state: 'default', status: 'Ready for review' },
  { id: 'disabled', label: 'Unavailable', state: 'disabled', status: 'Access unavailable' },
  { id: 'loading', label: 'Loading', state: 'loading', status: 'Checking save status' },
  { id: 'error', label: 'Error', state: 'error', status: 'Save not confirmed' },
  { id: 'success', label: 'Success', state: 'success', status: 'Saved in Google Slides' },
] satisfies { id: string; label: string; state: ResultCardProps['state']; status: string }[];

function stateApps(state: ResultCardProps['state']): ResultApp[] {
  if (state === 'success') return examples[0]!.apps;
  return [
    {
      brand: 'google-slides',
      name: 'Google Slides',
      actions:
        state === 'disabled'
          ? []
          : [
              {
                label: 'Create the investor pitch presentation',
                state: state === 'error' || state === 'loading' ? 'unknown' : 'pending',
              },
            ],
    },
  ];
}

export default function ResultCardsMock() {
  const header = useContext(ChatHeaderContext);
  const [selected, setSelected] = useState<(typeof examples)[number] | null>(null);
  const [showStates, setShowStates] = useState(false);
  const [draft, setDraft] = useState<ChatDraft>({ version: 1, doc: structuredClone(emptyChatDocument) });
  const [modelId, setModelId] = useState(models[0]?.id ?? '');
  const [notice, setNotice] = useState('');
  const open = selected !== null;
  return (
    <>
      {header &&
        createPortal(
          <>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">App result cards</h1>
            <CanvasToggle
              open={open}
              count={selected ? 1 : 0}
              onToggle={() => setSelected(open ? null : examples[0]!)}
            />
          </>,
          header,
        )}
      <ChatSplit
        open={open}
        onOpenChange={value => {
          if (!value) setSelected(null);
        }}
        layoutId="result-cards-mock"
        chat={
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              role="region"
              aria-label="Conversation"
              tabIndex={0}
              className="conversation-timeline min-h-0 flex-1 overflow-y-auto px-4 sm:px-6"
            >
              <div className="mx-auto max-w-3xl space-y-7 py-6">
                <Message align="end">
                  <MessageContent>
                    <Bubble variant="secondary" align="end">
                      <BubbleContent>
                        Show me the results for the pitch, investor update, and weekly workflow.
                      </BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
                <p className="text-base">Your work is ready. Open a result to see the details.</p>
                <div className="space-y-5">
                  {examples.map(example => (
                    <div key={example.id} className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {example.apps.length} {example.apps.length === 1 ? 'app' : 'apps'}
                      </p>
                      <ResultCard
                        title={example.title}
                        kind={example.kind}
                        apps={example.apps}
                        status={example.status}
                        state="success"
                        action={{ label: example.actionLabel, onClick: () => setSelected(example) }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">Local examples only. No app data is read or changed.</p>
                  <Button variant="ghost" onClick={() => setShowStates(value => !value)} aria-expanded={showStates}>
                    {showStates ? 'Hide card states' : 'Show card states'}
                  </Button>
                </div>
                {showStates && (
                  <section aria-label="Card states" className="space-y-4">
                    {stateExamples.map(example => (
                      <div key={example.id} className="space-y-2">
                        <h2 className="text-sm font-medium">{example.label}</h2>
                        <ResultCard
                          title="Investor pitch"
                          kind="File"
                          apps={stateApps(example.state)}
                          state={example.state}
                          status={example.status}
                          action={{
                            label: example.state === 'error' ? 'Check status' : 'Open in Canvas',
                            onClick: () => {
                              if (example.state === 'error')
                                setNotice('This mock save is still not confirmed. No write was repeated.');
                              else setSelected(examples[0]!);
                            },
                          }}
                        />
                      </div>
                    ))}
                  </section>
                )}
              </div>
            </div>
            <footer className="shrink-0 px-4 pt-2 pb-4 sm:px-6">
              <div className="mx-auto max-w-3xl space-y-2">
                <Composer
                  content={draft}
                  onContentChange={setDraft}
                  canSend={false}
                  onSend={() => {}}
                  placeholder="This is a local design mock"
                  onFiles={() => setNotice('Attachments are not available in this local design mock.')}
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
          selected && (
            <CanvasPanel
              tabs={[{ id: selected.id, title: selected.title, icon: File }]}
              activeId={selected.id}
              onSelect={() => {}}
              onCloseTab={() => setSelected(null)}
              onClose={() => setSelected(null)}
            >
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
                <header className="space-y-2">
                  <p className="text-sm text-success">{selected.status}</p>
                  <h2 className="text-xl font-medium text-foreground">{selected.title}</h2>
                  <p className="text-base">{selected.description}</p>
                </header>
                <section className="space-y-3" aria-label="Apps used">
                  <h3 className="text-sm font-medium text-foreground">Actions by app</h3>
                  <ResultAppActions apps={selected.apps} />
                </section>
                <p className="text-xs text-muted-foreground">Seeded example, not a live execution receipt.</p>
              </div>
            </CanvasPanel>
          )
        }
      />
    </>
  );
}
