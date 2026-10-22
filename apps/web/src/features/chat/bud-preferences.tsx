import { useState } from 'react';
import type { BudPreference } from '@tulipfarm/conversations/bud-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { ChoiceList } from '@tulipfarm/sprout/choice-list';
import { useBud } from './bud-context';

const replyStyles = [
  { id: 'short', label: 'Short answers', value: 'Keep replies short and direct. Lead with the answer.' },
  {
    id: 'detailed',
    label: 'Detailed answers',
    value: 'Give detailed replies with clear explanations and useful examples.',
  },
  { id: 'custom', label: 'Custom', value: '' },
];

function PreferenceCard({ preference }: { preference: BudPreference }) {
  const assistant = useBud();
  const [answer, setAnswer] = useState('');
  const [style, setStyle] = useState<string[]>([]);
  const replyStyle = preference.topic === 'reply-style';
  const value =
    replyStyle && style[0] !== 'custom' ? (replyStyles.find(item => item.id === style[0])?.value ?? '') : answer.trim();
  if (!assistant) return null;
  const { command, busy } = assistant;
  return (
    <section aria-label="Personal preference" className="space-y-2 text-sm">
      {preference.status === 'saved' ? (
        <>
          <p role="status">Remembered for this workspace</p>
          <p>{preference.value}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void command({ kind: 'undo-preference', id: preference.id })}
          >
            Undo
          </Button>
        </>
      ) : (
        <>
          <p>{preference.question}</p>
          {preference.status === 'asking' ? (
            <Form
              label="Answer Bud's preference question"
              disabled={busy}
              onSubmit={() => {
                if (value) void command({ kind: 'answer-preference', id: preference.id, value });
              }}
            >
              {replyStyle && (
                <ChoiceList
                  legend="Reply style"
                  options={replyStyles}
                  value={style}
                  onChange={setStyle}
                  disabled={busy}
                />
              )}
              {(!replyStyle || style[0] === 'custom') && (
                <Field
                  id={`bud-answer-${preference.id}`}
                  label="Your preference"
                  required
                  helper="Saved for this workspace. You can undo it."
                >
                  <Textarea value={answer} maxLength={2000} onChange={event => setAnswer(event.target.value)} />
                </Field>
              )}
              <FormFooter
                layout="compact"
                dirty={!!value}
                submit={{
                  label: 'Save answer',
                  pendingLabel: 'Saving answer...',
                  state: busy
                    ? { kind: 'busy' }
                    : value
                      ? { kind: 'ready' }
                      : { kind: 'blocked', reason: replyStyle ? 'Choose a reply style.' : 'Enter your preference.' },
                }}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void command({ kind: 'dismiss-preference', id: preference.id })}
                >
                  Skip
                </Button>
              </FormFooter>
            </Form>
          ) : (
            <>
              <p className="rounded-md bg-muted p-2">{preference.value}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void command({ kind: 'accept-preference', id: preference.id })}
                >
                  Remember this
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void command({ kind: 'dismiss-preference', id: preference.id })}
                >
                  Not now
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function BudPreferences({ chatId }: { chatId: string }) {
  const assistant = useBud();
  if (!assistant) return null;
  const { state, busy, command, error, refresh } = assistant;
  const preference = state?.preferences.find(item => item.conversationId === chatId || state.conversationId === chatId);
  return (
    <div className="space-y-2 empty:hidden">
      {state?.conversationId === chatId && state.onboarding === 'active' && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <p>Let's set up something useful.</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void command({ kind: 'skip' })}>
            Skip setup
          </Button>
        </div>
      )}
      {state?.conversationId === chatId && state.onboarding === 'completed' && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <p>You're set up. I'm here whenever you need me.</p>
          <Button size="sm" variant="ghost" onClick={assistant.returnFromSetup}>
            Continue
          </Button>
        </div>
      )}
      {preference && <PreferenceCard key={preference.id} preference={preference} />}
      {error && (state?.conversationId === chatId || preference) && (
        <div role="alert">
          <p>{error}</p>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Reload Bud
          </Button>
        </div>
      )}
    </div>
  );
}
