import { useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { Button, type ButtonState } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormSection } from '@tulipfarm/sprout/form';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useAgentAvailability, useAgentTurn, agentTurnPending as pending } from './queries';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { AgentRead } from './feedback';
import type { agentApi, AgentDetail } from './api';
import { ModelReceipt } from './model-receipt';
import { activationLabel } from './labels';

export function AgentChat({
  api,
  detail,
  concealed,
}: {
  api: ReturnType<typeof agentApi>;
  detail: AgentDetail;
  concealed: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const [activationId, setActivationId] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const activation = detail.activations.find(item => item.id === activationId);
  if (activationId && !activation) setActivationId('');
  const hash = useLocation({ select: location => location.hash });
  const navigate = useNavigate();
  const turnId = z.uuid().safeParse(hash.startsWith('agent-turn=') ? hash.slice(11) : '').data ?? null;
  const setTurnId = (id: string | null) => {
    void navigate({ hash: id ? `agent-turn=${id}` : '', replace: true });
  };
  const availability = useAgentAvailability(api, detail.id, !concealed);
  const write = useTableWrite(
    async (input: Parameters<typeof api.chat>[1]) => {
      setTurnId(input.id);
      return api.chat(detail.id, input);
    },
    receipt => setTurnId(receipt.id),
  );
  const read = useAgentTurn(api, detail.id, turnId, !concealed && write.state.kind !== 'sending');
  if (concealed) return null;
  const recovered =
    write.state.kind === 'uncertain' && read.state.kind === 'ready' && read.state.data.id === write.state.input.id;
  const unconfirmed = write.state.kind === 'uncertain' && !recovered;
  const turnPending = !!turnId && (read.state.kind !== 'ready' || pending(read.state.data));
  const turnUnknown = !!turnId && (read.state.kind === 'error' || read.state.kind === 'unavailable');
  const send: ButtonState =
    write.state.kind === 'sending'
      ? { kind: 'busy' }
      : unconfirmed
        ? { kind: 'blocked', reason: 'Check whether your last request went through first.' }
        : turnUnknown
          ? { kind: 'blocked', reason: 'Check the request status, or start a different request.' }
          : turnPending
            ? { kind: 'blocked', reason: 'Wait for the current request to finish.' }
            : !detail.activations.length
              ? {
                  kind: 'blocked',
                  reason: 'Ask an agent manager to activate this agent first.',
                  fix: { kind: 'jump', label: 'See setup steps', target: 'agent-setup' },
                }
              : availability.state.kind === 'loading'
                ? { kind: 'blocked', reason: 'Wait for the model provider check to finish.' }
                : availability.state.kind !== 'ready'
                  ? { kind: 'blocked', reason: 'Check access again to confirm the model provider.' }
                  : !availability.state.data.configured
                    ? { kind: 'blocked', reason: 'An operator must configure the model provider first.' }
                    : { kind: 'ready' };
  const errors = showErrors
    ? {
        activation: activation ? undefined : 'Choose an activation.',
        prompt: prompt.trim() ? undefined : 'Write a request.',
      }
    : {};
  function submit(): 'invalid' | undefined {
    if (send.kind !== 'ready') return;
    if (!activation || !prompt.trim()) {
      setShowErrors(true);
      return 'invalid';
    }
    setShowErrors(false);
    void write.submit({ id: crypto.randomUUID(), activationId: activation.id, scope: activation.scope, prompt });
  }
  return (
    <FormSection
      title="Chat with this agent"
      label="Agent chat"
      description="Send one request to an active version; it can use one permitted tool."
    >
      <AgentRead state={availability.state} refresh={availability.refresh}>
        {value =>
          value.configured ? (
            <p role="status" className="text-sm text-muted-foreground">
              Model configured. Your submitted prompt and activated instructions go to the selected model provider. Tool
              results stay in this workspace.
            </p>
          ) : (
            <StatePanel
              kind="unavailable"
              title="Model not configured"
              description="An operator must configure the model provider before chat can run. Saved definitions and schedules remain available."
            />
          )
        }
      </AgentRead>
      <Form disabled={write.state.kind === 'sending' || unconfirmed || turnPending} onSubmit={submit}>
        <div className="grid gap-5">
          <Field
            id="chat-activation"
            label="Chat activation"
            required
            disabled={!detail.activations.length}
            helper={activation ? `Limited to ${activation.scope.length} configured tables.` : undefined}
            error={errors.activation}
          >
            <Select value={activation?.id ?? ''} onValueChange={value => setActivationId(value ?? '')}>
              <SelectTrigger>
                <SelectValue>
                  {activation ? activationLabel(detail, activation) : 'Choose activated instructions'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {detail.activations.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {activationLabel(detail, item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="agent-prompt" label="Request" required error={errors.prompt}>
            <Textarea value={prompt} maxLength={8000} onChange={event => setPrompt(event.target.value)} />
          </Field>
          <Button type="submit" state={send} pendingLabel="Sending request…">
            Send request
          </Button>
        </div>
      </Form>
      <WriteFeedback
        state={recovered ? { kind: 'accepted' } : write.state}
        retry={input => void write.submit(input)}
        checkStatus={() => {
          if (write.state.kind === 'uncertain') setTurnId(write.state.input.id);
          void read.refresh();
        }}
      />
      {turnId && (read.state.kind === 'error' || read.state.kind === 'unavailable') && (
        <div>
          <Button
            variant="outline"
            onClick={() => {
              setTurnId(null);
              write.reset();
            }}
          >
            Start a different request
          </Button>
        </div>
      )}
      {turnId && (
        <>
          <AgentRead state={read.state} refresh={read.refresh}>
            {turn => (
              <ModelReceipt
                key={turn.id}
                api={api}
                agentId={detail.id}
                turn={turn}
                refresh={read.refresh}
                refreshing={read.state.kind === 'ready' && (read.state.refreshing || !!read.state.error)}
              />
            )}
          </AgentRead>
          <div>
            <Button
              variant="outline"
              disabled={read.state.kind === 'ready' && read.state.refreshing}
              onClick={() => void read.refresh()}
            >
              Check request status
            </Button>
          </div>
          {read.delayed && (
            <p role="status" className="text-sm">
              Automatic checks stopped. The request continues on the server.
            </p>
          )}
        </>
      )}
    </FormSection>
  );
}
