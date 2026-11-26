import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { ArrowUpIcon } from '@tulipfarm/icons';
import { onboardingAgentName, starterAgents, type StarterAgentId } from '@tulipfarm/workspaces/onboarding-catalog';
import {
  interviewStages,
  interviewTurnSchema,
  onboardingProfileSchema,
  type InterviewTurn,
  type OnboardingProfile,
} from '@tulipfarm/workspaces/onboarding-contracts';
import { domainOf, emptyOnboardingProfile, ruleTurn } from '@tulipfarm/workspaces/onboarding-interview';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceList } from '@tulipfarm/sprout/choice-list';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@tulipfarm/sprout/input-group';
import { Message, MessageBubble, MessageContent } from '@tulipfarm/sprout/message';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import { apiOrigin } from '@/lib/auth';
import { cachedVisitor, guideVisitor } from '@/features/auth/guide-visitor';
import { AuthVerification } from '@/features/auth/verification';
import '@/features/chat/conversation.css';

// The onboarding chat after signup step 1: a centred chat with TulipFarm. The API takes each turn
// (the guide model, or rules without one); if it can't be reached the same rules run here, so the
// visitor can always reach sign-up.

const chatKey = 'tulipfarm:signup-chat';
const chatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['assistant', 'user']), text: z.string() })).max(80),
  stage: z.enum(interviewStages),
  suggestions: z.array(z.string()),
  agents: z.array(z.string()),
  conversation: z.string().optional(),
});
type ChatState = z.infer<typeof chatSchema>;

function readChat(): ChatState | null {
  try {
    const parsed = chatSchema.safeParse(JSON.parse(sessionStorage.getItem(chatKey) ?? 'null'));
    if (parsed.success) return parsed.data;
  } catch {}
  return null;
}

/** The chat so far, in the draft's shape, so the workspace keeps it after sign-up. */
export function onboardingChatMessages(): { role: 'user' | 'assistant'; content: string }[] {
  return (readChat()?.messages ?? [])
    .filter(message => message.text.trim())
    .slice(-40)
    .map(message => ({ role: message.role, content: message.text.slice(0, 2000) }));
}

export function clearOnboardingChat() {
  try {
    sessionStorage.removeItem(chatKey);
  } catch {}
}

async function takeTurn(visitor: string, body: object) {
  const response = await fetch(`${apiOrigin}/v1/public/guide/onboarding`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${visitor}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50_000),
  });
  if (!response.ok) throw new Error(`guide-turn-${response.status}`);
  return interviewTurnSchema.parse(await response.json());
}

// Messages, questions and the composer follow the app's chat (features/chat), so the conversation
// looks the same when it continues in the workspace.
function AgentMessage({ children }: { children: string }) {
  return (
    <Message align="start">
      <MessageContent>
        <span className="sr-only">{onboardingAgentName} said</span>
        <MessageBubble variant="ghost">
          <MessageResponse>{children}</MessageResponse>
        </MessageBubble>
      </MessageContent>
    </Message>
  );
}

function UserMessage({ children }: { children: string }) {
  return (
    <Message align="end">
      <MessageContent>
        <MessageBubble variant="secondary">
          <p className="whitespace-pre-wrap wrap-anywhere">{children}</p>
        </MessageBubble>
      </MessageContent>
    </Message>
  );
}

/** Quick answers to TulipFarm's question, in the app's question card, right under the message. */
function QuestionCard({ options, onAnswer }: { options: string[]; onAnswer: (answer: string) => void }) {
  const [choice, setChoice] = useState<string[]>([]);
  const [attempted, setAttempted] = useState(false);
  const error = attempted && !choice.length ? 'Choose an answer, or type your own below.' : undefined;
  return (
    <section
      aria-label="Suggested answers"
      className="question-panel space-y-1 rounded-xl border border-border bg-card px-3 py-2 text-card-foreground"
    >
      <Form
        onSubmit={() => {
          setAttempted(true);
          if (!choice[0]) return 'invalid';
          onAnswer(choice[0]);
        }}
      >
        <ChoiceList
          layout="compact"
          legend="Choose one answer"
          options={options.map(option => ({ id: option, label: option }))}
          value={choice}
          error={error}
          onChange={setChoice}
        />
        <FormFooter
          layout="compact"
          dirty={choice.length > 0}
          submit={{ label: 'Continue', pendingLabel: 'Sending…', state: { kind: 'ready' } }}
        >
          <Button variant="ghost" size="sm" onClick={() => onAnswer('Skip')}>
            Skip
          </Button>
        </FormFooter>
      </Form>
    </section>
  );
}

export function OnboardingChatWindow({
  workspaceName,
  workspaceSlug,
  visitorName,
  profile: savedProfile,
  onProfileChange,
  onEditWorkspace,
  pending,
  signup,
}: {
  workspaceName: string;
  workspaceSlug: string;
  visitorName: string;
  profile: OnboardingProfile | undefined;
  onProfileChange: (profile: OnboardingProfile) => void;
  onEditWorkspace: () => void;
  pending: boolean;
  /** The account form, shown in the chat once TulipFarm reaches sign-up. */
  signup: ReactNode;
}) {
  const profile = onboardingProfileSchema.parse(savedProfile ?? emptyOnboardingProfile);
  const [chat, setChat] = useState<ChatState>(() => {
    // A new chat starts empty: TulipFarm's first message comes from the server, which reads the website.
    return readChat() ?? { messages: [], stage: 'about', suggestions: [], agents: [] };
  });
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(chatKey, JSON.stringify(chat));
    } catch {}
  }, [chat]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [chat.messages.length, chat.stage, thinking]);
  useEffect(() => {
    if (!thinking && chat.stage !== 'signup') input.current?.focus({ preventScroll: true });
  }, [thinking, chat.stage]);

  const onToken = useCallback((token: string | null) => setChallenge(token), []);
  const visitorToken = () => guideVisitor(challenge);

  // TulipFarm opens once the bot check passes, or on the rules if it never does.
  const opened = useRef(chat.messages.length > 0);
  useEffect(() => {
    if (opened.current) return;
    // Step 1 usually got the visitor token already, so the chat can open at once.
    if (challenge !== null || cachedVisitor()) {
      opened.current = true;
      void send('', 'open');
      return;
    }
    const fallback = setTimeout(() => {
      if (opened.current) return;
      opened.current = true;
      void send('', 'open');
    }, 8000);
    return () => clearTimeout(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per challenge
  }, [challenge]);
  const reading = !chat.messages.length && profile.website ? `Reading ${domainOf(profile.website)}…` : undefined;

  type Kind = 'open' | 'message' | 'agents' | 'skip';
  async function send(text: string, kind: Kind = 'message', current: OnboardingProfile = profile) {
    const message = kind === 'open' || kind === 'skip' ? '' : text.trim();
    if ((!message && kind !== 'open' && kind !== 'skip') || thinking) return;
    setDraft('');
    if (text.trim())
      setChat(state => ({
        ...state,
        suggestions: [],
        messages: [...state.messages, { role: 'user', text: text.trim() }],
      }));
    setThinking(true);
    const request = {
      message,
      kind,
      stage: chat.stage,
      profile: current,
      workspaceName,
      visitorName: visitorName || null,
    };
    let turn: InterviewTurn;
    try {
      turn = await takeTurn(await visitorToken(), {
        ...request,
        ...(chat.conversation && { conversation: chat.conversation }),
      });
    } catch {
      // The chat keeps going on the same rules the API uses without a model.
      turn = ruleTurn(request);
    }
    onProfileChange(turn.profile);
    setChat(state => ({
      messages: [...state.messages, { role: 'assistant', text: turn.reply }],
      stage: turn.stage,
      suggestions: turn.suggestions,
      agents: turn.agents,
      ...((turn.conversation ?? state.conversation) && { conversation: turn.conversation ?? state.conversation }),
    }));
    setThinking(false);
  }

  const lastAssistant = chat.messages.map(message => message.role).lastIndexOf('assistant');
  const options = chat.suggestions.filter(option => !/^skip$/i.test(option));
  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <img src="/logo-ink.svg" alt="TulipFarm" className="h-7 dark:hidden" />
        <img src="/logo-white.svg" alt="TulipFarm" className="hidden h-7 dark:block" />
        <div className="flex min-w-0 items-center gap-2">
          <EntityAvatar seed={workspaceSlug} name={workspaceName} size="sm" shape="square" />
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{workspaceName}</p>
            <p className="truncate text-muted-foreground">
              {window.location.host}/{workspaceSlug}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label="Edit workspace details"
            onClick={onEditWorkspace}
          >
            Edit
          </Button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <h1 className="sr-only">Set up {workspaceName}</h1>
        <div
          role="region"
          aria-label={`Setup chat with ${onboardingAgentName}`}
          className="conversation-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6"
        >
          {/* Like the app's chat, the first messages sit just above the composer and push upwards. */}
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-6 py-6 sm:py-8">
            <ol aria-label="Messages" aria-live="polite" className="space-y-8">
              {chat.messages.map((message, index) => (
                <li key={index} className="space-y-3">
                  {message.role === 'assistant' ? (
                    <AgentMessage>{message.text}</AgentMessage>
                  ) : (
                    <UserMessage>{message.text}</UserMessage>
                  )}
                  {index === lastAssistant && !thinking && chat.stage !== 'agents' && options.length > 0 && (
                    <QuestionCard key={index} options={options} onAnswer={answer => void send(answer)} />
                  )}
                  {index === lastAssistant && !thinking && chat.stage === 'agents' && (
                    <AgentPicker
                      key={index}
                      agents={chat.agents as StarterAgentId[]}
                      selected={profile.selectedAgents}
                      onDone={selected => {
                        const next = { ...profile, selectedAgents: selected };
                        onProfileChange(next);
                        const names = selected.map(id => starterAgents.find(agent => agent.id === id)?.name ?? id);
                        if (selected.length) void send(`I’d like ${names.join(', ')}.`, 'agents', next);
                        else void send('Skip for now', 'message', next);
                      }}
                    />
                  )}
                  {index === lastAssistant && chat.stage === 'signup' && !thinking && (
                    <div className="rounded-xl border border-border bg-card p-4 sm:p-6">{signup}</div>
                  )}
                </li>
              ))}
              {(thinking || !chat.messages.length) && (
                <li aria-busy="true">
                  <ToolActivity variant="transcript" items={[]} active activityLabel={reading ?? 'Thinking'} />
                </li>
              )}
            </ol>
            <div ref={end} />
          </div>
        </div>
        {chat.stage !== 'signup' && (
          <div className="shrink-0 px-4 pb-4 sm:px-6">
            <div className="mx-auto w-full max-w-3xl space-y-2">
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={thinking || !chat.messages.length}
                  onClick={() => void send('Skip and continue to sign-up', 'skip')}
                >
                  Skip and continue to sign-up
                </Button>
              </div>
              <form
                aria-label="Message composer"
                onSubmit={event => {
                  event.preventDefault();
                  void send(draft);
                }}
              >
                <InputGroup variant="composer">
                  <InputGroupTextarea
                    ref={input}
                    aria-label={`Message ${onboardingAgentName}`}
                    placeholder="Ask anything…"
                    rows={1}
                    maxLength={1200}
                    value={draft}
                    disabled={thinking}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send(draft);
                      }
                    }}
                  />
                  <InputGroupAddon align="block-end">
                    <InputGroupButton
                      type="submit"
                      size="icon"
                      variant={draft.trim() ? 'default' : 'secondary'}
                      aria-label="Send message"
                      disabled={thinking || !draft.trim()}
                    >
                      <ArrowUpIcon size="md" aria-hidden="true" />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
              <div className="sr-only">
                <AuthVerification action="public_guide" onToken={onToken} />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function AgentPicker({
  agents,
  selected: initial,
  onDone,
}: {
  agents: StarterAgentId[];
  selected: StarterAgentId[];
  onDone: (selected: StarterAgentId[]) => void;
}) {
  const suggestions = agents.flatMap(id => starterAgents.filter(agent => agent.id === id));
  const [selected, setSelected] = useState<string[]>(initial.filter(id => agents.includes(id)));
  return (
    <section
      aria-label="Suggested agents"
      className="question-panel space-y-1 rounded-xl border border-border bg-card px-3 py-2 text-card-foreground"
    >
      <Form onSubmit={() => onDone(selected as StarterAgentId[])}>
        <ChoiceList
          layout="compact"
          multiple
          legend="Choose the agents you want"
          options={suggestions.map(agent => ({ id: agent.id, label: `${agent.name}: ${agent.description}` }))}
          value={selected}
          onChange={setSelected}
        />
        <FormFooter
          layout="compact"
          dirty={selected.length > 0}
          submit={{
            label: selected.length
              ? `Continue with ${selected.length} ${selected.length === 1 ? 'agent' : 'agents'}`
              : 'Continue',
            pendingLabel: 'Sending…',
            state: selected.length
              ? { kind: 'ready' }
              : { kind: 'blocked', reason: 'Choose an agent, or skip for now.' },
          }}
        >
          <Button variant="ghost" size="sm" onClick={() => onDone([])}>
            Skip for now
          </Button>
        </FormFooter>
      </Form>
    </section>
  );
}
