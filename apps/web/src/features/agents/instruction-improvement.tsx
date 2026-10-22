import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  isAgentAuthoringSourceCurrent,
  type AgentAuthoringSource,
  type ImprovedAgentInstructions,
} from '@tulipfarm/agents/authoring-assistance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Disclosure } from '@/components/disclosure';
import { TableRequestError } from '@/features/tables/request-state';
import { agentAuthoringApi } from './authoring-assistance-api';

export function InstructionImprovement({
  workspaceId,
  agentName,
  instructions,
  source,
  disabled,
  onApply,
  onBusy,
}: {
  workspaceId: string;
  agentName: string;
  instructions: string;
  source: AgentAuthoringSource;
  disabled: boolean;
  onApply: (instructions: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<ImprovedAgentInstructions | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const stale = suggestion && !isAgentAuthoringSourceCurrent(suggestion.source, source);
  async function improve() {
    if (controller.current || disabled || !instructions.trim()) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    onBusy(true);
    setError('');
    setSuggestion(null);
    try {
      const result = await agentAuthoringApi(workspaceId).improve(
        { requestId: crypto.randomUUID(), source, instructions, agentName },
        pending.signal,
      );
      if (!pending.signal.aborted) setSuggestion(result);
    } catch (error) {
      setError(
        pending.signal.aborted
          ? 'Request cancelled. Your draft is unchanged. Credits may apply for work already done.'
          : error instanceof TableRequestError
            ? error.message
            : 'Could not confirm the model response. Your draft is unchanged. Check workspace credits before retrying.',
      );
    } finally {
      controller.current = null;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section aria-label="Improve instructions" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={disabled || busy || !instructions.trim()} onClick={() => void improve()}>
          <Sparkles aria-hidden="true" />
          {busy ? 'Improving instructions…' : 'Improve instructions'}
        </Button>
        {busy && (
          <Button variant="ghost" onClick={() => controller.current?.abort()}>
            Cancel request
          </Button>
        )}
        <p className="text-xs text-muted-foreground">GPT Luna. Uses workspace credits. You review before applying.</p>
      </div>
      {busy && (
        <p role="status" className="sr-only">
          Luna is improving your instructions.
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {suggestion && (
        <div className="grid gap-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Luna's suggestion</h3>
            <p className="text-xs text-muted-foreground">{suggestion.suggestion.length.toLocaleString()} characters</p>
          </div>
          <Disclosure title="Read suggested instructions" defaultOpen>
            <p className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">
              {suggestion.suggestion}
            </p>
          </Disclosure>
          {stale && (
            <p role="status" className="text-sm text-warning">
              Your draft changed after this request. This suggestion cannot replace the newer text. Discard it and
              improve the current draft.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={disabled || !!stale}
              onClick={() => {
                if (!stale) {
                  onApply(suggestion.suggestion);
                  setSuggestion(null);
                }
              }}
            >
              Apply suggestion
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => setSuggestion(null)}>
              Discard suggestion
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {suggestion.usage.credits.toLocaleString(undefined, { maximumFractionDigits: 4 })} credits used
          </p>
        </div>
      )}
    </section>
  );
}
