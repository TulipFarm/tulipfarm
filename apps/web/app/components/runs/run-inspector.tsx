import { useState } from "react";
import { DestructivePreview } from "~/components/shell/states";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import type { OperationalRun, RunCommandAction } from "~/lib/operations";
import { RunContext } from "./run-context";

const OUTCOMES: Record<string, { title: string; description: string; tone: StatusTone }> = {
  succeeded: {
    title: "Run completed",
    description: "This Run finished successfully.",
    tone: "success",
  },
  failed: { title: "Run failed", description: "This Run stopped with a failure.", tone: "danger" },
  cancelled: {
    title: "Run cancelled",
    description: "This Run was cancelled. Earlier effects may still have occurred.",
    tone: "neutral",
  },
  running: {
    title: "Run in progress",
    description: "This Run is still working. Results may be incomplete.",
    tone: "info",
  },
  waiting: {
    title: "Run waiting",
    description: "This Run is waiting before it can continue.",
    tone: "warning",
  },
  attention_required: {
    title: "Run needs attention",
    description: "This Run needs operator attention before it can continue.",
    tone: "warning",
  },
  needs_reconciliation: {
    title: "Run needs reconciliation",
    description: "The outcome of some work is uncertain. Review the evidence before continuing.",
    tone: "danger",
  },
  queued: { title: "Run queued", description: "This Run has not started yet.", tone: "neutral" },
  claimed: { title: "Run claimed", description: "A worker has claimed this Run.", tone: "info" },
  cancelling: {
    title: "Run cancellation requested",
    description: "Cancellation is in progress. Work may still be stopping.",
    tone: "warning",
  },
};

function fieldLabel(key: string) {
  if (key === "artifactId") return "Artifact ID";
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="min-w-0 text-xs">
      <summary className="cursor-pointer rounded-sm py-1.5 text-muted-foreground">{title}</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-muted/30 p-3 text-xs [overflow-wrap:anywhere]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function ReadableValue({ value }: { value: unknown }) {
  if (value == null) return <p className="text-muted-foreground">No inline output available.</p>;
  if (typeof value !== "object") {
    return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{String(value)}</p>;
  }
  const fields = Object.entries(value).filter(
    ([, item]) => item === null || typeof item !== "object"
  );
  if (!fields.length) {
    return (
      <p className="text-muted-foreground">
        Structured output recorded. Expand Output JSON to inspect it.
      </p>
    );
  }
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      {fields.map(([key, item]) => (
        <div key={key} className="min-w-0 sm:contents">
          <dt className="capitalize text-muted-foreground [overflow-wrap:anywhere]">
            {fieldLabel(key)}
          </dt>
          <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {item === null ? "null" : String(item)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceList({
  title,
  items,
}: {
  title: string;
  items: readonly Record<string, unknown>[];
}) {
  return (
    <details className="min-w-0 border-b border-border">
      <summary className="cursor-pointer rounded-sm py-3 text-xs font-medium">
        {title} ({items.length})
      </summary>
      {items.length === 0 ? (
        <p className="pb-3 text-xs text-muted-foreground">No {title.toLowerCase()} recorded.</p>
      ) : (
        <ol className="min-w-0 divide-y divide-border">
          {items.map((item, index) => (
            <li key={`${title}-${index}`} className="min-w-0 py-2 text-xs">
              <ReadableValue value={item} />
              {title === "Effects" &&
              item.latestAttempt !== null &&
              typeof item.latestAttempt === "object" ? (
                <div className="mt-3 min-w-0">
                  <p className="mb-1 font-medium">Latest attempt</p>
                  <ReadableValue value={item.latestAttempt} />
                </div>
              ) : null}
              <JsonDetails title={`${title} evidence JSON`} value={item} />
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function RecordedTime({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <time dateTime={value}>{date.toLocaleString()}</time>
      </dd>
    </div>
  );
}

function recordedDuration(run: OperationalRun) {
  if (!run.startedAt || !run.finishedAt) return null;
  const duration = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return null;
  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function RunInspector({
  run,
  busy = false,
  unavailable,
  onCommand,
}: {
  run: OperationalRun;
  busy?: boolean;
  unavailable?: string;
  onCommand: (action: RunCommandAction) => void;
}) {
  const [preview, setPreview] = useState<string>();
  const locked = busy || unavailable !== undefined;
  const commands = run.availableCommands ?? [];
  const outcome: (typeof OUTCOMES)[string] = OUTCOMES[run.status] ?? {
    title: "Run status",
    description: "Review the recorded States and evidence below.",
    tone: "neutral",
  };
  const duration = recordedDuration(run);
  const counts = new Map<string, number>();
  for (const state of run.states) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        aria-labelledby="run-outcome"
        className="flex min-w-0 flex-col gap-2 border-b border-border pb-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="run-outcome" className="text-sm font-medium">
            {outcome.title}
          </h2>
          <StatusBadge label={run.status.replace(/_/g, " ")} tone={outcome.tone} />
        </div>
        <p className="text-sm text-muted-foreground">{outcome.description}</p>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <RecordedTime label="Created" value={run.createdAt} />
          <RecordedTime label="Started" value={run.startedAt} />
          <RecordedTime label="Finished" value={run.finishedAt} />
          {duration ? (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="tabular-nums">{duration}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-xs tabular-nums text-muted-foreground">
          ${run.costs.amountUsd.toFixed(4)} · {run.costs.modelTokens.toLocaleString()} tokens
        </p>
      </section>

      <RunContext context={run.context} />

      {commands.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {commands.map((action) => (
            <button
              key={action}
              type="button"
              disabled={locked}
              onClick={() => (action === "cancel" ? setPreview(run.id) : onCommand(action))}
              className={`min-h-8 rounded-sm border px-3 py-1 text-xs capitalize disabled:opacity-60 ${action === "cancel" ? "border-destructive/40 text-destructive" : "border-border"}`}
            >
              {action === "cancel" ? "Cancel Run" : action}
            </button>
          ))}
        </div>
      ) : null}
      {unavailable ? (
        <p className="text-xs text-muted-foreground">Run control is unavailable: {unavailable}</p>
      ) : null}
      {preview === run.id && commands.includes("cancel") ? (
        <div className="min-w-0 [overflow-wrap:anywhere]">
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
        </div>
      ) : null}

      <section aria-labelledby="run-states" className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pb-2">
          <h2 id="run-states" className="text-xs font-medium">
            State results ({run.states.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            {Array.from(counts, ([status, count]) => `${count} ${status.replace(/_/g, " ")}`).join(
              " · "
            )}
          </p>
        </div>
        {run.states.length === 0 ? (
          <p className="text-xs text-muted-foreground">No State results recorded yet.</p>
        ) : null}
        <ol className="min-w-0 divide-y divide-border">
          {run.states.map((state) => (
            <li key={state.key} className="flex min-w-0 flex-col gap-2 py-3 text-xs">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="min-w-0 font-medium [overflow-wrap:anywhere]">{state.key}</h3>
                <StatusBadge
                  label={state.status.replace(/_/g, " ")}
                  tone={OUTCOMES[state.status]?.tone ?? "neutral"}
                />
                <span className="text-muted-foreground">
                  {state.attempts} {state.attempts === 1 ? "attempt" : "attempts"}
                </span>
              </div>
              <ReadableValue value={state.output} />
              {state.resultArtifactId ? (
                <p className="text-muted-foreground [overflow-wrap:anywhere]">
                  Result Artifact: <span>{state.resultArtifactId}</span>
                </p>
              ) : null}
              {state.errorEvidenceRef ? (
                <p className="text-status-danger [overflow-wrap:anywhere]">
                  Error evidence: <span>{state.errorEvidenceRef}</span>
                </p>
              ) : null}
              {state.output !== undefined ? (
                <JsonDetails title="Output JSON" value={state.output} />
              ) : null}
              {state.input !== undefined ? (
                <JsonDetails title="Input JSON" value={state.input} />
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="run-evidence" className="min-w-0">
        <h2 id="run-evidence" className="text-xs font-medium">
          Run details
        </h2>
        <details className="min-w-0 border-b border-border">
          <summary className="cursor-pointer rounded-sm py-3 text-xs font-medium">
            Identifiers
          </summary>
          <dl className="grid min-w-0 gap-1 pb-3 text-xs [overflow-wrap:anywhere]">
            <dt className="text-muted-foreground">Run ID</dt>
            <dd>{run.id}</dd>
            <dt className="text-muted-foreground">Routine ID</dt>
            <dd>{run.routineId}</dd>
            <dt className="text-muted-foreground">Routine version</dt>
            <dd>{run.routineVersion}</dd>
            <dt className="text-muted-foreground">Run version</dt>
            <dd>{run.version}</dd>
          </dl>
        </details>
        <EvidenceList title="Effects" items={run.effects} />
        <EvidenceList title="Waits" items={run.waits} />
        <EvidenceList title="Guardrail decisions" items={run.guardrailDecisions} />
        <EvidenceList title="Lineage" items={run.lineage} />
      </section>
    </div>
  );
}
