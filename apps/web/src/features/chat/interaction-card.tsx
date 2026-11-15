import { useEffect, useId, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check } from 'reicon-react/icons/Check';
import { HelpCircle } from 'reicon-react/icons/HelpCircle';
import { useRegisterPendingQuestion } from './pending-question';
import { useResultAttention } from './canvas-state';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { ChoiceList } from '@tulipfarm/sprout/choice-list';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { ChatConfirmation, type ConfirmationState } from '@tulipfarm/sprout/chat-confirmation';
import { Label } from '@tulipfarm/sprout/label';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { UnsavedChanges } from '@/features/tables/feedback';
import { SecretRequestCard } from '@/features/secrets/request-card';
import { textError, type ConversationApi } from './conversation-api';
import { useConversationCommand } from './conversation-state';
import { useConversationInteraction, useConversationChanges } from './queries';
import {
  approvalDetails,
  effectSchema,
  interactionPending,
  isQuestion,
  type QuestionRequest,
  type InteractionCommand,
  type InteractionReference,
} from './interaction-contracts';
import './conversation.css';

export function InteractionCard({
  api,
  chatId,
  reference,
}: {
  api: ConversationApi;
  chatId: string;
  reference: InteractionReference;
}) {
  const requestId = reference.kind === 'request' ? reference.requestId : reference.approvalId;
  const kind = reference.kind === 'request' ? 'request' : 'approval';
  const changes = useConversationChanges();
  const [reviewed, setReviewed] = useState(false);
  const write = useConversationCommand(api, () => {});
  const writeDenied = write.state.kind === 'rejected' && [401, 403, 404].includes(write.state.status);
  const read = useConversationInteraction(api, chatId, reference, !writeDenied);
  const region = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const submittedHere = useRef(false);
  const pending = read.state.kind === 'ready' && interactionPending(read.state.data);
  // A secrets form is private to one member and stays in the transcript, so it doesn't take over the composer.
  const secrets =
    read.state.kind === 'ready' && read.state.data.kind === 'information' && !isQuestion(read.state.data.request);
  useRegisterPendingQuestion(kind === 'request' && pending && !writeDenied && !secrets);
  useEffect(() => {
    if (kind !== 'request' || !pending || secrets) return;
    const frame = requestAnimationFrame(() => region.current?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [kind, pending, secrets]);
  useResultAttention(
    `interaction:${kind}:${requestId}`,
    pending,
    kind === 'request' ? 'Your answer is needed' : 'An action needs your review',
  );
  const wasPending = useRef(false);
  useEffect(() => {
    if (writeDenied || read.state.kind === 'unavailable') return;
    if (!pending && submittedHere.current && read.state.kind === 'ready') {
      result.current?.focus();
      submittedHere.current = false;
    }
    if (wasPending.current && !pending && read.state.kind === 'ready') void changes.interaction(chatId);
    wasPending.current = pending;
  }, [pending, read.state.kind, changes, chatId, writeDenied]);
  const unavailable = read.state.kind === 'unavailable' || writeDenied;
  const refresh = async () => {
    await read.refresh();
    setReviewed(true);
  };
  const busy = read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const rejected = write.state.kind === 'rejected';
  useEffect(() => {
    if (rejected) void latestRefresh.current();
  }, [rejected]);
  const locked = write.locked || write.state.kind === 'accepted' || read.state.kind !== 'ready' || !!read.state.error;
  const blockedReason =
    read.state.kind === 'ready' && read.state.error
      ? 'Try again below to enable your answer.'
      : write.state.kind === 'uncertain'
        ? 'Retry your saved response below to confirm the outcome.'
        : write.state.kind === 'accepted'
          ? 'Your response is saved. Waiting for the updated request.'
          : 'Checking the request, then you can review your retained answer.';
  const interaction = read.state.kind === 'ready' ? read.state.data : null;
  const submit = (command: InteractionCommand) => {
    if (locked || !pending) return;
    submittedHere.current = region.current?.contains(document.activeElement) ?? false;
    setReviewed(false);
    void write.submit(command);
  };
  if (unavailable)
    return (
      <StatePanel
        kind="unavailable"
        title="Request unavailable"
        description="This request is missing or your current access does not allow it. Its details have been cleared."
      />
    );
  const stalled = pending && read.state.kind === 'ready' && !!read.state.error;
  const metadata = read.state.kind === 'ready' && ((kind === 'approval' && pending) || stalled) && (
    <div
      data-slot="request-status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-xs text-muted-foreground"
    >
      {kind === 'approval' && pending && interaction && (
        <div className="min-w-0">
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Details</CollapsibleTrigger>
            <CollapsibleContent>
              <p className="max-w-sm py-1">
                Request revision {interaction.request.revision}. Expires{' '}
                {new Date(interaction.request.expiresAt).toLocaleString()}.
              </p>
              <p className="max-w-sm py-1">
                Only this card records your approval. Your current permission is checked when you decide.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
      {stalled && (
        <>
          <span role="status" className="min-w-0 flex-1">
            Could not check this request
          </span>
          <Button
            size="sm"
            variant="link"
            aria-busy={busy}
            disabled={busy || write.state.kind === 'sending'}
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </>
      )}
    </div>
  );
  return (
    <div
      ref={region}
      aria-label={kind === 'request' ? 'Information request' : 'Table approval'}
      className={kind === 'request' && pending ? 'space-y-1' : 'space-y-3'}
    >
      <UnsavedChanges dirty={pending && (write.state.kind === 'sending' || write.state.kind === 'uncertain')} />
      {read.state.kind === 'loading' && (
        <div role="status" aria-label="Loading request" className="space-y-3">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading request…</span>
        </div>
      )}
      {read.state.kind === 'error' && (
        <StatePanel
          kind="error"
          title="Could not load request"
          description="The current request state is unknown. Check your connection and retry."
        >
          <Button variant="outline" onClick={() => void refresh()}>
            Retry loading request
          </Button>
        </StatePanel>
      )}
      {interaction && (
        <>
          <div ref={result} tabIndex={-1}>
            {interaction.kind === 'information' ? (
              isQuestion(interaction.request) ? (
                <InformationCard
                  request={interaction.request}
                  locked={locked}
                  blockedReason={blockedReason}
                  sending={write.state.kind === 'sending'}
                  submit={answer =>
                    submit({
                      kind: 'answer',
                      chatId,
                      requestId,
                      commandId: crypto.randomUUID(),
                      responseId: crypto.randomUUID(),
                      expectedRevision: interaction.request.revision,
                      answer,
                    })
                  }
                  cancel={() =>
                    submit({
                      kind: 'cancel-request',
                      chatId,
                      requestId,
                      commandId: crypto.randomUUID(),
                      expectedRevision: interaction.request.revision,
                    })
                  }
                />
              ) : (
                <SecretRequestCard
                  request={interaction.request}
                  onSettled={async () => {
                    await read.refresh();
                  }}
                />
              )
            ) : (
              <ChatConfirmation
                title={interaction.request.prompt}
                description="Review these changes before approving."
                details={approvalDetails(interaction.request)}
                disabled={locked || !effectSchema.safeParse(interaction.request.action.effect).success}
                state={confirmationState(interaction.request.resolution?.status, write.state)}
                onDecision={decision =>
                  submit({
                    kind: 'decide',
                    chatId,
                    requestId,
                    commandId: crypto.randomUUID(),
                    expectedRevision: interaction.request.revision,
                    decision,
                  })
                }
              />
            )}
          </div>
          {read.state.kind === 'ready' && read.state.error && (
            <Alert variant="destructive">
              <AlertDescription>
                Could not refresh this request. Your input is retained. Try again before submitting.
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      {write.state.kind === 'sending' && (
        <p role="status" className="sr-only">
          Saving your response…
        </p>
      )}
      {write.state.kind === 'accepted' && pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Response saved. Updating…
        </p>
      )}
      {pending && (write.state.kind === 'uncertain' || write.state.kind === 'rejected') && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>
              {write.state.kind === 'uncertain'
                ? 'We could not confirm the outcome. Your exact response is retained in this tab. Retry it without creating another decision.'
                : write.state.message}
            </AlertDescription>
          </Alert>
          {write.state.kind === 'uncertain' ? (
            <Button
              variant="outline"
              onClick={() => {
                if (write.state.kind === 'uncertain') void write.submit(write.state.command);
              }}
            >
              Retry same response
            </Button>
          ) : (
            reviewed &&
            read.state.kind === 'ready' &&
            !read.state.error &&
            !read.state.refreshing && (
              <Button
                variant="outline"
                onClick={() => {
                  setReviewed(false);
                  write.reset();
                }}
              >
                Review retained response
              </Button>
            )
          )}
        </div>
      )}
      {metadata}
    </div>
  );
}

function confirmationState(
  status: 'approved' | 'rejected' | 'cancelled' | 'expired' | undefined,
  write: ReturnType<typeof useConversationCommand>['state'],
): ConfirmationState {
  if (status) return { kind: status };
  if (write.kind === 'sending' && write.command.kind === 'decide' && write.command.decision !== 'cancel')
    return { kind: 'submitting', decision: write.command.decision };
  return { kind: 'pending' };
}

function InformationCard({
  request,
  locked,
  blockedReason,
  sending,
  submit,
  cancel,
}: {
  request: QuestionRequest;
  locked: boolean;
  blockedReason: string;
  sending: boolean;
  submit: (answer: Extract<InteractionCommand, { kind: 'answer' }>['answer']) => void;
  cancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<string[]>([]);
  const [typed, setTyped] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const pending = request.status === 'pending';
  const textAnswer = request.answerSchema.kind === 'text' || typed;
  const validation = textAnswer ? textError(text) : choices.length ? null : 'Choose an answer.';
  const blankText = textAnswer && !text.trim();
  const error = attempted ? (blankText ? 'Enter your answer.' : validation) : null;
  const answer = request.response?.answer;
  const labels = new Map(
    request.answerSchema.kind === 'choices'
      ? request.answerSchema.choices.map(choice => [choice.id, choice.label])
      : [],
  );
  const recordedAnswer = answer
    ? answer.kind === 'text'
      ? answer.text
      : answer.kind === 'secrets'
        ? undefined
        : answer.choiceIds.map(id => labels.get(id) ?? 'Unavailable choice').join(', ')
    : undefined;
  if (!pending)
    return (
      <section aria-labelledby={`${id}-title`} className="space-y-1">
        <div
          data-slot="choice-summary"
          className="relative flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-sm"
        >
          <span className="absolute top-0.5 left-0 text-muted-foreground">
            <HelpCircle size={16} aria-hidden="true" />
          </span>
          <h4 id={`${id}-title`} className="min-w-0 text-muted-foreground">
            <QuestionPrompt>{request.prompt}</QuestionPrompt>
          </h4>
          {recordedAnswer && (
            <Badge variant="secondary">
              <Check aria-hidden="true" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{recordedAnswer}</span>
            </Badge>
          )}
        </div>
        {request.status !== 'answered' && (
          <p role="status" className="pl-6 text-xs text-muted-foreground">
            {request.status === 'expired'
              ? 'This request expired without an answer.'
              : 'This request was cancelled without an answer.'}
          </p>
        )}
      </section>
    );
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="question-panel space-y-1 rounded-xl border border-border bg-card px-3 py-2 text-card-foreground"
    >
      <UnsavedChanges dirty={!!text || choices.length > 0} />
      <h4 id={`${id}-title`} className="min-w-0 whitespace-pre-wrap break-words text-sm font-medium">
        <QuestionPrompt>{request.prompt}</QuestionPrompt>
      </h4>
      <Form
        disabled={locked}
        onSubmit={() => {
          if (locked) return;
          setAttempted(true);
          if (validation || blankText) return 'invalid';
          submit(textAnswer ? { kind: 'text', text } : { kind: 'choices', choiceIds: choices });
        }}
      >
        {request.answerSchema.kind === 'text' ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-answer`}>Your answer</Label>
            <Textarea
              id={`${id}-answer`}
              placeholder="Type your answer…"
              value={text}
              disabled={locked}
              aria-describedby={`${id}-error`}
              aria-invalid={!!error}
              onChange={event => setText(event.target.value)}
            />
            <div id={`${id}-error`}>{error && <p className="text-sm text-destructive">{error}</p>}</div>
          </div>
        ) : (
          <ChoiceList
            layout="compact"
            legend={request.answerSchema.multiple ? 'Choose one or more answers' : 'Choose one answer'}
            multiple={request.answerSchema.multiple}
            options={request.answerSchema.choices}
            value={typed ? [] : choices}
            disabled={locked}
            error={!typed ? (error ?? undefined) : undefined}
            onChange={value => {
              setChoices(value);
              setTyped(false);
            }}
            textOption={
              request.answerSchema.allowText
                ? {
                    id: `${id}-custom`,
                    value: text,
                    active: typed,
                    onChange: value => {
                      setText(value);
                      setTyped(true);
                    },
                    onFocus: () => setTyped(true),
                    error: typed ? error : null,
                  }
                : undefined
            }
          />
        )}
        <FormFooter
          layout="compact"
          summary={
            <div className="flex flex-wrap items-start gap-1">
              {request.answerSchema.kind === 'choices' && request.answerSchema.allowText && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  aria-expanded={typed}
                  aria-controls={`${id}-custom`}
                  onClick={() => setTyped(!typed)}
                >
                  {typed ? 'Use a listed answer' : 'Other answer'}
                </Button>
              )}
            </div>
          }
          dirty={!!text || choices.length > 0}
          submit={{
            label: 'Continue',
            pendingLabel: 'Saving response…',
            state: sending ? { kind: 'busy' } : locked ? { kind: 'blocked', reason: blockedReason } : { kind: 'ready' },
          }}
          error={error ? 'Choose or enter an answer to continue.' : undefined}
        >
          <Button variant="ghost" size="sm" disabled={locked} onClick={cancel}>
            Skip
          </Button>
        </FormFooter>
      </Form>
    </section>
  );
}

function QuestionPrompt({ children }: { children: string }) {
  return (
    <span className="sprout-message-response text-sm leading-5 text-inherit [&>*]:mt-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        allowedElements={['a', 'br', 'code', 'del', 'em', 'strong']}
        unwrapDisallowed
        skipHtml
        // Mirrors the Sprout reply renderer's link and HTML safety.
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </span>
  );
}
