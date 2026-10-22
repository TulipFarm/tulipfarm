import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { onboardingDetailsSchema } from '@tulipfarm/workspaces/onboarding-contracts';
import type { Workspace } from '@tulipfarm/workspaces/contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Message, MessageContent, MessageGroup, MessageHeader } from '@tulipfarm/sprout/message';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useWorkspaceSetup } from '@/features/workspaces/queries';
import { newOnboardingToken, resumeOnboarding, saveOnboarding } from '@/lib/onboarding';

type Draft = Awaited<ReturnType<typeof resumeOnboarding>>;

export function OnboardingChatHistory({ draft }: { draft: Draft }) {
  return (
    <section aria-label="Your saved onboarding chat" className="space-y-8">
      <MessageGroup>
        {draft.details.messages.map((message, index) => (
          <Message key={`${draft.id}-${index}`} align={message.role === 'user' ? 'end' : 'start'}>
            <MessageContent>
              <MessageHeader>{message.role === 'user' ? 'You' : 'TulipFarm guide'}</MessageHeader>
              <div className={message.role === 'user' ? 'max-w-full rounded-xl bg-muted px-4 py-3' : 'px-3 py-2'}>
                <p className="whitespace-pre-wrap text-base wrap-anywhere">{message.content}</p>
              </div>
            </MessageContent>
          </Message>
        ))}
        <Message>
          <MessageContent>
            <MessageHeader>TulipFarm guide</MessageHeader>
            <p className="px-3 text-base">You are signed in. Let's finish setting up {draft.details.name}.</p>
          </MessageContent>
        </Message>
      </MessageGroup>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-y py-4">
        <h2 className="min-w-0 font-medium wrap-anywhere">{draft.details.name}</h2>
        <p className="text-sm text-muted-foreground">
          {draft.details.accountType === 'business' ? 'Business' : 'Personal'} workspace
        </p>
      </div>
    </section>
  );
}

export function OnboardingChatSetup({
  workspace,
  onOpen,
  onSignIn,
}: {
  workspace: Workspace;
  onOpen: () => void;
  onSignIn: () => void;
}) {
  const read = useWorkspaceSetup(workspace.id);
  useEffect(() => {
    if (read.state.kind === 'unavailable' && read.state.status === 401) onSignIn();
  }, [read.state.kind, read.state.kind === 'unavailable' && read.state.status, onSignIn]);
  if (read.state.kind === 'unavailable' || (read.state.kind === 'ready' && read.state.data.stage === 'unavailable'))
    return (
      <StatePanel
        kind="unavailable"
        title="Workspace setup is unavailable"
        description="This account may no longer have access. Your workspace has not been created again."
      >
        <Button nativeButton={false} render={<Link to="/" />}>
          Back to your workspaces
        </Button>
      </StatePanel>
    );
  if (read.state.kind === 'ready' && read.state.data.stage === 'ready')
    return (
      <StatePanel
        kind="success"
        title="Your workspace is ready"
        description={`Continue in ${workspace.name} to start your first task.`}
      >
        <Button onClick={onOpen}>Open workspace</Button>
      </StatePanel>
    );
  const failed =
    read.state.kind === 'error' || (read.state.kind === 'ready' && (read.state.error || read.state.data.error));
  if (failed || read.delayed)
    return (
      <StatePanel
        kind="error"
        title={failed ? 'Could not confirm workspace setup' : 'Setup is taking longer than expected'}
        description="Your workspace already exists. Check its status again; do not create another one."
      >
        <Button disabled={read.state.kind === 'ready' && read.state.refreshing} onClick={() => void read.refresh()}>
          Check status again
        </Button>
      </StatePanel>
    );
  return (
    <StatePanel
      kind="loading"
      title="Setting up your workspace"
      description={`${workspace.name} has been created. Setup continues if you leave this page.`}
    />
  );
}

export function OnboardingChatSlug({ draft, onSaved }: { draft: Draft; onSaved: (token: string) => Promise<void> }) {
  const [slug, setSlug] = useState(draft.details.slug);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ slug: string; token: string; saved: boolean } | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const parsed = onboardingDetailsSchema.safeParse({ ...draft.details, slug });
  const fieldError =
    submitted && (!parsed.success || slug === draft.details.slug)
      ? 'Choose a different URL with 3-48 lowercase letters, numbers, or single hyphens.'
      : undefined;
  const save = () => {
    setSubmitted(true);
    if (!parsed.success || slug === draft.details.slug) return 'invalid' as const;
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError('');
    if (attempt.current?.slug !== slug) attempt.current = { slug, token: newOnboardingToken(), saved: false };
    const current = attempt.current;
    void (async () => {
      try {
        if (!current.saved) {
          await saveOnboarding(current.token, parsed.data);
          current.saved = true;
        }
        if (mounted.current) await onSaved(current.token);
      } catch {
        if (mounted.current)
          setError(
            current.saved
              ? 'Your new URL was saved, but could not be opened. Try again.'
              : 'We could not confirm the new URL was saved. Your chat is kept. Try again.',
          );
      } finally {
        running.current = false;
        if (mounted.current) setPending(false);
      }
    })();
  };
  return (
    <Form onSubmit={save} disabled={pending}>
      <div className="w-full space-y-4 text-left">
        <Field id="onboarding-chat-slug" label="Workspace URL" required error={fieldError}>
          <Input value={slug} maxLength={48} onChange={event => setSlug(event.target.value)} />
        </Field>
        <FormFooter
          dirty={slug !== draft.details.slug}
          error={error || undefined}
          submit={{
            label: 'Save new URL',
            pendingLabel: 'Saving new URL...',
            state: pending ? { kind: 'busy' } : { kind: 'ready' },
          }}
        />
      </div>
    </Form>
  );
}
