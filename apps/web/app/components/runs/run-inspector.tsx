import { useState } from "react";
import { DestructivePreview } from "~/components/shell/states";
import type { OperationalRun, RunCommandAction } from "~/lib/operations";

function EvidenceList({
  title,
  items,
}: {
  title: string;
  items: readonly Record<string, unknown>[];
}) {
  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-3 py-2 text-xs font-medium ">{title}</h2>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">none</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, index) => (
            <li key={`${title}-${index}`} className="overflow-x-auto px-3 py-2">
              <code className="text-xs">{JSON.stringify(item)}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RunInspector({
  run,
  busy = false,
  // Set once the server has answered 501 for a Run command. The controls stay visible but go
  // inert, and the server's own explanation is shown — the operator learns the capability is
  // absent from this deployment rather than that their click failed.
  unavailable,
  onCommand,
}: {
  run: OperationalRun;
  busy?: boolean;
  unavailable?: string;
  onCommand: (action: RunCommandAction) => void;
}) {
  const [preview, setPreview] = useState<RunCommandAction>();
  const locked = busy || unavailable !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <span className="rounded-sm border border-border px-2 py-1 text-xs">{run.status}</span>
        <code className="text-xs text-muted-foreground">{run.id}</code>
        <span className="text-xs text-muted-foreground">
          {run.routineId}@{run.routineVersion}
        </span>
        <span className="ml-auto text-xs tabular-nums">
          ${run.costs.amountUsd.toFixed(4)} · {run.costs.modelTokens} tokens
        </span>
      </header>

      <div className="flex flex-wrap gap-2">
        {(["pause", "resume", "retry", "reconcile"] as const).map((action) => (
          <button
            key={action}
            type="button"
            disabled={locked}
            title={unavailable}
            onClick={() => onCommand(action)}
            className="rounded-sm border border-border px-2 py-1 text-xs capitalize disabled:opacity-60"
          >
            {action}
          </button>
        ))}
        <button
          type="button"
          disabled={locked}
          title={unavailable}
          onClick={() => setPreview("cancel")}
          className="rounded-sm border border-destructive px-2 py-1 text-xs text-destructive disabled:opacity-60"
        >
          Cancel Run
        </button>
      </div>

      {unavailable ? (
        <p className="border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Run control is unavailable: {unavailable}
        </p>
      ) : null}

      {preview === "cancel" ? (
        <DestructivePreview
          action="Cancel Run"
          target={run.id}
          destination="TulipFarm Run authority"
          reversibility="New work stops; ambiguous effects still require reconciliation"
          busy={locked}
          onCancel={() => setPreview(undefined)}
          onConfirm={() => {
            setPreview(undefined);
            onCommand("cancel");
          }}
        />
      ) : null}

      <section className="border border-border bg-card">
        <h2 className="border-b border-border px-3 py-2 text-xs font-medium ">States</h2>
        <ol className="divide-y divide-border">
          {run.states.map((state) => (
            <li key={state.key} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-4">
              <strong>{state.key}</strong>
              <span>{state.status}</span>
              <span>{state.attempts} attempts</span>
              <code className="overflow-x-auto">{JSON.stringify(state.output ?? null)}</code>
            </li>
          ))}
        </ol>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <EvidenceList title="Effects" items={run.effects} />
        <EvidenceList title="Waits" items={run.waits} />
        <EvidenceList title="Guardrail decisions" items={run.guardrailDecisions} />
        <EvidenceList title="Lineage" items={run.lineage} />
      </div>
    </div>
  );
}
