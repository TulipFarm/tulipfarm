import { useState } from 'react';
import { Button, type ButtonState } from '@tulipfarm/sprout/button';
import { FormSection } from '@tulipfarm/sprout/form';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import type { agentApi, AgentDetail } from './api';
import { activationLabel, toolLabels } from './labels';
import { Disclosure } from '@/components/disclosure';
import { useAgentPolicy } from './queries';
import { AgentRead } from './feedback';
import { ScopeSummary } from './reference-names';

export function AgentActivations({
  api,
  detail,
  workspaceId,
  concealed,
  refresh,
}: {
  api: ReturnType<typeof agentApi>;
  detail: AgentDetail;
  workspaceId: string;
  concealed: boolean;
  refresh: () => Promise<void>;
}) {
  const policy = useAgentPolicy(api, detail.id, !concealed);
  const activationWrite = useTableWrite(
    (input: Parameters<typeof api.activate>[1]) => api.activate(detail.id, input),
    () => {},
  );
  const uncertainActivation = activationWrite.state.kind === 'uncertain' ? activationWrite.state.input : null;
  const activationRecovered =
    !!uncertainActivation &&
    detail.activations.some(
      activation =>
        activation.id === uncertainActivation.requestId &&
        activation.revision === uncertainActivation.revision &&
        JSON.stringify(activation.scope) === JSON.stringify(uncertainActivation.scope),
    );
  const [submitted, setSubmitted] = useState<string | null>(null);
  const write = useTableWrite(
    (activationId: string) => {
      setSubmitted(activationId);
      return api.revokeActivation(detail.id, activationId);
    },
    () => {},
  );
  const recovered = submitted !== null && !detail.activations.some(activation => activation.id === submitted);
  if (concealed) return null;
  const pendingId = write.state.kind === 'sending' ? write.state.input : null;
  const read = policy.state.kind === 'ready' ? policy.state : null;
  function activateState(enabled: boolean): ButtonState {
    if (read?.refreshing || activationWrite.state.kind === 'sending') return { kind: 'busy' };
    if (read?.error)
      return {
        kind: 'blocked',
        reason: 'Execution settings could not refresh.',
        fix: { kind: 'action', label: 'Try again', onClick: () => void policy.refresh() },
      };
    if (!enabled)
      return {
        kind: 'blocked',
        reason: 'Turn on Enable execution and save execution settings first.',
        fix: { kind: 'jump', label: 'Go to Enable execution', target: 'agent-enable-execution' },
      };
    if (activationWrite.state.kind === 'uncertain' && !activationRecovered)
      return { kind: 'blocked', reason: 'Check whether the last activation went through first.' };
    return { kind: 'ready' };
  }
  const revokeState = (activationId: string): ButtonState =>
    pendingId === activationId
      ? { kind: 'busy' }
      : pendingId
        ? { kind: 'blocked', reason: 'Wait for the current revoke to finish.' }
        : write.state.kind === 'uncertain' && !recovered
          ? { kind: 'blocked', reason: 'Check whether the last revoke went through first.' }
          : { kind: 'ready' };
  return (
    <FormSection
      id="agent-activations"
      title="Activate instructions"
      label="Agent activations"
      description="Runs use the version you activate. Activate again after you change the instructions."
    >
      <AgentRead state={policy.state} refresh={policy.refresh}>
        {value => (
          <div className="grid gap-3">
            <p className="text-sm">
              {detail.definition.tools.map(tool => toolLabels[tool]).join(', ') || 'No tools selected'}
            </p>
            <p className="break-words text-sm">
              <ScopeSummary workspaceId={workspaceId} scope={value.limits} />
            </p>
            <div id="agent-activate">
              <Button
                state={activateState(value.enabled)}
                pendingLabel={activationWrite.state.kind === 'sending' ? 'Activating…' : undefined}
                onClick={() =>
                  void activationWrite.submit({
                    requestId: crypto.randomUUID(),
                    revision: detail.definitionRevision,
                    scope: value.limits,
                  })
                }
              >
                Activate saved instructions
              </Button>
            </div>
            <Disclosure title="Technical identifiers">
              <p className="break-all text-sm">Definition {detail.definitionRevision}</p>
            </Disclosure>
          </div>
        )}
      </AgentRead>
      <WriteFeedback
        state={activationRecovered ? { kind: 'accepted' } : activationWrite.state}
        checkStatus={() => void refresh()}
        retry={input => void activationWrite.submit(input)}
      />
      {(activationWrite.state.kind === 'accepted' || activationRecovered) && (
        <p role="status" className="text-sm text-muted-foreground">
          Saved instructions are activated.
        </p>
      )}
      {detail.activations.length ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">Revoking stops new work that uses that version.</p>
          <ul className="grid gap-3">
            {detail.activations.map(activation => (
              <li key={activation.id} className="grid gap-2 rounded-lg border p-3">
                <p className="break-words text-sm font-medium text-foreground">{activationLabel(detail, activation)}</p>
                <p className="text-sm">Limited to {activation.scope.length} configured assets.</p>
                <p className="break-words text-sm">
                  <ScopeSummary workspaceId={workspaceId} scope={activation.scope} />
                </p>
                <Disclosure title="Technical identifiers">
                  <p className="break-all text-sm">Revision {activation.revision}</p>
                  <p className="break-all text-sm">Activation {activation.id}</p>
                </Disclosure>
                <Button
                  state={revokeState(activation.id)}
                  variant="outline"
                  pendingLabel="Revoking…"
                  onClick={() => void write.submit(activation.id)}
                >
                  Revoke activation
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <StatePanel
          kind="empty"
          heading="h3"
          title="No active versions"
          description="Activate the saved instructions to let this agent run."
        />
      )}
      {(write.state.kind === 'accepted' || recovered) && (
        <p role="status" className="text-sm text-muted-foreground">
          Activation revoked.
        </p>
      )}
      <WriteFeedback
        state={recovered ? { kind: 'accepted' } : write.state}
        checkStatus={() => void refresh()}
        retry={activationId => void write.submit(activationId)}
      />
    </FormSection>
  );
}
