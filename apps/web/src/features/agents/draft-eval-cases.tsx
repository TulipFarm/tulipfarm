import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { DraftEvalCase } from '@tulipfarm/evals/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { TableRequestError } from '@/features/tables/request-state';
import { describeCheck } from './eval-labels';
import { useEvalSet, useEvalsApi } from './evals-api';

/**
 * Starter test cases the chat wrote with an agent draft. They are listed for review and, once the agent is saved, an
 * editor adds the ones not yet in its Evals. Matching by name keeps a second click from adding them twice.
 */
export function DraftEvalCases({
  workspaceId,
  workspaceSlug,
  agentId,
  cases,
  saved,
}: {
  workspaceId: string;
  workspaceSlug: string;
  agentId: string;
  cases: DraftEvalCase[] | undefined;
  /** The agent's definition is saved, so its Evals exist. */
  saved: boolean;
}) {
  if (!cases?.length) return null;
  return (
    <section aria-label="Test cases" className="grid gap-2 rounded-lg border border-border p-3">
      <div className="grid gap-0.5">
        <h4 className="text-sm font-medium text-foreground">Test cases ({cases.length})</h4>
        <p className="text-xs text-muted-foreground">
          Starter tests for this agent&apos;s Evals. They are not saved with the agent.
        </p>
      </div>
      <ul className="grid gap-1">
        {cases.map(item => (
          <li key={item.name}>
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>{item.name}</CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid gap-1 px-3 pb-2 text-sm">
                  <p className="text-foreground">“{item.message}”</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {item.checks.map((check, index) => (
                      <li key={index}>{describeCheck(check)}</li>
                    ))}
                  </ul>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </li>
        ))}
      </ul>
      {saved && <AddToEvals workspaceId={workspaceId} workspaceSlug={workspaceSlug} agentId={agentId} cases={cases} />}
    </section>
  );
}

function AddToEvals({
  workspaceId,
  workspaceSlug,
  agentId,
  cases,
}: {
  workspaceId: string;
  workspaceSlug: string;
  agentId: string;
  cases: DraftEvalCase[];
}) {
  const api = useEvalsApi(workspaceId, agentId);
  const set = useEvalSet(api, agentId, true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (set.state.kind === 'loading') return <p className="text-sm text-muted-foreground">Checking Evals…</p>;
  if (set.state.kind !== 'ready')
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">This agent&apos;s Evals could not load.</span>
        <Button variant="outline" size="sm" onClick={() => void set.refresh()}>
          Retry
        </Button>
      </div>
    );
  const data = set.state.data;
  const existing = new Set(data.cases.map(item => item.name.trim()));
  const missing = cases.filter(item => !existing.has(item.name.trim()));
  const room = Math.max(0, data.limits.casesPerSet - data.cases.length);
  const toAdd = missing.slice(0, room);
  const open = (
    <Button
      variant="link"
      size="sm"
      nativeButton={false}
      render={
        <Link to="/$workspaceSlug/agents/$agentId" params={{ workspaceSlug, agentId }} search={{ tab: 'evals' }} />
      }
    >
      Open Evals
    </Button>
  );
  if (!missing.length)
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <p role="status">Added to Evals.</p>
        {open}
      </div>
    );
  if (!data.canEdit)
    return <p className="text-sm text-muted-foreground">Only people who can edit this agent can add test cases.</p>;
  if (!toAdd.length)
    return (
      <p className="text-sm text-muted-foreground">
        This agent already has {data.limits.casesPerSet} test cases. Delete some in Evals to add these.
      </p>
    );
  async function add() {
    setAdding(true);
    setError(null);
    try {
      for (const item of toAdd) await api.createCase(item);
    } catch (failure) {
      setError(failure instanceof TableRequestError ? failure.message : 'Some test cases were not added. Try again.');
    } finally {
      setAdding(false);
      void set.refresh();
    }
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" state={adding ? { kind: 'busy' } : { kind: 'ready' }} onClick={() => void add()}>
          {toAdd.length === 1 ? 'Add 1 test case to Evals' : `Add ${toAdd.length} test cases to Evals`}
        </Button>
        {missing.length < cases.length && open}
      </div>
      {toAdd.length < missing.length && (
        <p className="text-xs text-muted-foreground">Evals has room for {toAdd.length} more. The rest are not added.</p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
