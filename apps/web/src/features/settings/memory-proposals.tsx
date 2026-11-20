import { useEffect, useRef, useState } from 'react';
import { Edit } from 'reicon-react/icons/Edit';
import {
  memoryProposalsSchema,
  type MemoryProposal,
  type PersonalMemory,
} from '@tulipfarm/conversations/personal-memory-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { MemoryDiff } from '@/features/chat/memory-draft-card';
import { TableRequestError } from '@/features/tables/request-state';
import { settingsRequest } from './api';

type Action = 'confirm' | 'dismiss' | 'refresh';
type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; proposals: MemoryProposal[] };

const titles = { add: 'Add to your memory', change: 'Change your memory', remove: 'Remove from your memory' } as const;

/**
 * Suggested memory edits from background learning. Nothing changes until the member confirms one;
 * `blocked` holds actions while the editor above has unsaved or unresolved changes.
 */
export function MemoryProposals({
  path,
  revision,
  blocked,
  onMemory,
}: {
  path: string;
  revision: number;
  blocked: boolean;
  onMemory: (memory: PersonalMemory) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id?: string; text: string } | null>(null);
  const active = useRef<AbortController | null>(null);

  async function request(target: string, method = 'GET') {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    try {
      const result = memoryProposalsSchema.parse(
        await settingsRequest(target, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), method),
      );
      if (controller.signal.aborted) return;
      setState({ kind: 'ready', proposals: result.proposals });
      return result;
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function load() {
    setState({ kind: 'loading' });
    try {
      await request(`${path}/proposals`);
    } catch {
      if (!active.current) setState({ kind: 'error' });
    }
  }

  // Reload whenever the saved memory changes, so outdated suggestions show as outdated.
  useEffect(() => {
    void load();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [revision]);

  async function act(proposal: MemoryProposal, action: Action) {
    if (busy || blocked) return;
    setBusy(proposal.id);
    setMessage(null);
    try {
      const result = await request(`${path}/proposals/${encodeURIComponent(proposal.id)}/${action}`, 'POST');
      if (!result) return;
      if (action === 'confirm') onMemory(result.memory);
      setMessage({
        text:
          action === 'confirm'
            ? 'Memory updated. Your next private replies will use it.'
            : action === 'dismiss'
              ? 'Suggestion dismissed. Your memory didn’t change.'
              : 'Suggestion updated. Review it again before confirming.',
      });
    } catch (error) {
      const status = error instanceof TableRequestError ? error.status : undefined;
      if (status === 409 || status === 404) await load().catch(() => undefined);
      setMessage({
        id: proposal.id,
        text:
          status === 409
            ? action === 'refresh'
              ? 'This suggestion no longer fits your memory. Dismiss it.'
              : 'Your memory changed, so nothing was saved. Review the suggestion again.'
            : status === 404
              ? 'This suggestion is gone. Nothing changed.'
              : 'Something went wrong. Nothing changed. Try again.',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="memory-proposals-title" className="grid gap-3">
      <div>
        <h3 id="memory-proposals-title" className="text-sm font-medium">
          Suggested changes
        </h3>
        <p className="text-sm text-muted-foreground">
          Suggested from your private chats. Nothing changes until you confirm.
        </p>
      </div>
      {state.kind === 'loading' ? (
        <StatePanel kind="loading" heading="h4" title="Loading suggestions" description="Checking for suggestions." />
      ) : state.kind === 'error' ? (
        <StatePanel
          kind="error"
          heading="h4"
          title="Suggestions could not load"
          description="Your memory has not changed."
        >
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </StatePanel>
      ) : (
        <>
          {message && !message.id && (
            <p role="status" className="text-sm text-muted-foreground">
              {message.text}
            </p>
          )}
          {state.proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No suggestions right now.</p>
          ) : (
            <ul className="grid gap-3" aria-label="Suggested changes">
              {state.proposals.map(proposal => (
                <li key={proposal.id}>
                  <ReviewCard
                    icon={<Edit size={16} />}
                    title={titles[proposal.kind]}
                    label={`Suggested change: ${titles[proposal.kind]}`}
                    badge={
                      proposal.outdated
                        ? { label: 'Out of date', variant: 'warning' }
                        : { label: 'Needs approval', variant: 'warning' }
                    }
                    actions={
                      proposal.outdated ? (
                        <>
                          <Button
                            variant="outline"
                            disabled={!!busy || blocked}
                            aria-busy={busy === proposal.id}
                            onClick={() => void act(proposal, 'refresh')}
                          >
                            Update suggestion
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={!!busy || blocked}
                            onClick={() => void act(proposal, 'dismiss')}
                          >
                            Dismiss
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            disabled={!!busy || blocked}
                            aria-busy={busy === proposal.id}
                            onClick={() => void act(proposal, 'confirm')}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={!!busy || blocked}
                            onClick={() => void act(proposal, 'dismiss')}
                          >
                            Dismiss
                          </Button>
                        </>
                      )
                    }
                    status={
                      message?.id === proposal.id ? (
                        <p role="status" className="text-sm">
                          {message.text}
                        </p>
                      ) : proposal.outdated ? (
                        <p className="text-sm">
                          Your memory changed after this was suggested, so it can’t be confirmed as it is.
                        </p>
                      ) : blocked ? (
                        <p className="text-sm text-muted-foreground">Save or discard your edits first.</p>
                      ) : undefined
                    }
                  >
                    <MemoryDiff before={proposal.before ?? ''} after={proposal.after ?? ''} />
                    <blockquote className="border-l-2 pl-3 text-sm">
                      <span className="sr-only">You said: </span>“{proposal.quote}”
                    </blockquote>
                    <p className="text-xs text-muted-foreground">From the chat “{proposal.conversationTitle}”</p>
                  </ReviewCard>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
