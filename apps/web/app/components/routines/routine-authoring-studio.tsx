import { createRoutineAuthoringSession, RoutineAuthoringError } from "@tulipfarm/editor";
import type { routine as routineSchema } from "@tulipfarm/schema";
import { useRef, useState } from "react";
import { stringify as stringifyYaml } from "yaml";
import { Button } from "~/components/ui/button";
import {
  analyzeRoutine,
  proposeRoutineChangeset,
  type RoutineAuthoringAnalysis,
  type RoutineAuthoringBody,
} from "~/lib/routines/authoring";

type Mode = "Simple" | "Graph" | "YAML";

export interface RoutineAuthoringStudioProps {
  readonly definition: routineSchema.RoutineDefinition;
  readonly baseCommit: string;
  readonly analyze?: (
    slug: string,
    body: RoutineAuthoringBody
  ) => Promise<RoutineAuthoringAnalysis>;
  readonly propose?: (
    slug: string,
    body: RoutineAuthoringBody
  ) => Promise<{ readonly changesetId: string; readonly status: string }>;
}

function message(status: string): string {
  return status === "awaiting_approval" ? "awaiting approval" : status.replaceAll("_", " ");
}

/** Three editing modes over one canonical, validation-backed Routine draft. */
export function RoutineAuthoringStudio({
  definition,
  baseCommit,
  analyze = analyzeRoutine,
  propose = proposeRoutineChangeset,
}: RoutineAuthoringStudioProps) {
  const sessionRef = useRef<ReturnType<typeof createRoutineAuthoringSession> | null>(null);
  sessionRef.current ??= createRoutineAuthoringSession(definition, baseCommit);
  const session = sessionRef.current;
  const [mode, setMode] = useState<Mode>("Simple");
  const [revision, setRevision] = useState(0);
  const [displayName, setDisplayName] = useState(() => session.snapshot().metadata.displayName);
  const [owner, setOwner] = useState(() => session.snapshot().spec.owner ?? "");
  const [graphSource, setGraphSource] = useState(() =>
    JSON.stringify(session.snapshot().spec.states, null, 2)
  );
  const [yamlSource, setYamlSource] = useState(() => session.yaml());
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [analysis, setAnalysis] = useState<RoutineAuthoringAnalysis | null>(null);
  const [proposalStatus, setProposalStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<Mode, HTMLButtonElement>>>({});
  const draft = session.snapshot();
  void revision;

  const refresh = () => {
    setRevision((value) => value + 1);
    setYamlSource(session.yaml());
    setGraphSource(JSON.stringify(session.snapshot().spec.states, null, 2));
    setIssues([]);
    setAnalysis(null);
  };

  const updateSimple = (input: { readonly displayName?: string; readonly owner?: string }) => {
    try {
      session.updateSimple(input);
      refresh();
    } catch (error) {
      setIssues(
        error instanceof RoutineAuthoringError
          ? error.issues.map((entry) => `${entry.path}: ${entry.message}`)
          : ["The simple draft is invalid."]
      );
    }
  };

  const body = (): RoutineAuthoringBody => ({
    baseCommit,
    yaml: session.yaml(),
    fixture: { startedAtMs: 0 },
  });

  const selectMode = (next: Mode, focus = false) => {
    setMode(next);
    setYamlSource(session.yaml());
    setGraphSource(JSON.stringify(session.snapshot().spec.states, null, 2));
    if (focus) queueMicrotask(() => tabRefs.current[next]?.focus());
  };

  const applyGraph = () => {
    try {
      const states = JSON.parse(graphSource) as readonly routineSchema.RoutineState[];
      const candidate = session.snapshot();
      const start = states[0]?.name ?? candidate.spec.start;
      const result = session.updateYaml(
        stringifyYaml({ ...candidate, spec: { ...candidate.spec, start, states } })
      );
      if (result.issues.length > 0) {
        setIssues(result.issues.map((entry) => `${entry.path}: ${entry.message}`));
        return;
      }
      refresh();
    } catch {
      setIssues(["Graph must be a JSON array of canonical Routine states."]);
    }
  };

  const applyYaml = () => {
    const result = session.updateYaml(yamlSource);
    if (result.issues.length > 0) {
      setIssues(result.issues.map((entry) => `${entry.path}: ${entry.message}`));
      return;
    }
    refresh();
  };

  const runAnalysis = async () => {
    setBusy(true);
    setIssues([]);
    try {
      setAnalysis(await analyze(draft.metadata.slug, body()));
    } catch {
      setIssues(["The draft could not be validated or simulated."]);
    } finally {
      setBusy(false);
    }
  };

  const runProposal = async () => {
    setBusy(true);
    setIssues([]);
    try {
      const result = await propose(draft.metadata.slug, body());
      setProposalStatus(`Changeset ${result.changesetId} is ${message(result.status)}`);
    } catch {
      setIssues(["The changeset could not be proposed."]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex w-full min-w-0 flex-col gap-4" aria-label="Routine authoring studio">
      <div role="tablist" aria-label="Authoring mode" className="flex flex-wrap gap-2">
        {(["Simple", "Graph", "YAML"] as const).map((tab) => (
          <Button
            key={tab}
            type="button"
            role="tab"
            ref={(element) => {
              tabRefs.current[tab] = element ?? undefined;
            }}
            size="sm"
            variant={mode === tab ? "default" : "outline"}
            aria-selected={mode === tab}
            tabIndex={mode === tab ? 0 : -1}
            onClick={() => selectMode(tab)}
            onKeyDown={(event) => {
              const tabs: readonly Mode[] = ["Simple", "Graph", "YAML"];
              const index = tabs.indexOf(tab);
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (direction === 0) return;
              event.preventDefault();
              const next = tabs[(index + direction + tabs.length) % tabs.length];
              if (next) selectMode(next, true);
            }}
          >
            {tab}
          </Button>
        ))}
      </div>

      {mode === "Simple" ? (
        <div role="tabpanel" className="grid gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onBlur={() => updateSimple({ displayName })}
              className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Owner
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              onBlur={() => updateSimple({ owner })}
              className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5"
            />
          </label>
        </div>
      ) : null}

      {mode === "Graph" ? (
        <div role="tabpanel" className="flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Routine states
            <textarea
              value={graphSource}
              onChange={(event) => setGraphSource(event.target.value)}
              rows={16}
              className="w-full min-w-0 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-xs"
            />
          </label>
          <Button type="button" size="sm" className="self-start" onClick={applyGraph}>
            Apply graph
          </Button>
        </div>
      ) : null}

      {mode === "YAML" ? (
        <div role="tabpanel" className="flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            Routine YAML
            <textarea
              value={yamlSource}
              onChange={(event) => setYamlSource(event.target.value)}
              rows={20}
              className="w-full min-w-0 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-xs"
            />
          </label>
          <Button type="button" size="sm" className="self-start" onClick={applyYaml}>
            Apply YAML
          </Button>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <ul role="alert" className="text-destructive text-sm">
          {issues.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      ) : null}

      {analysis ? (
        <dl className="grid gap-1 rounded-sm border border-border p-3 text-sm sm:grid-cols-2">
          <div>Validation: {analysis.validationState}</div>
          <div>Risk: {analysis.risk}</div>
          <div>Approval: {analysis.approval}</div>
          <div>Publication: {analysis.publicationState}</div>
          <div className="sm:col-span-2">
            Simulation: {analysis.simulation.status} · {analysis.simulation.steps.length}{" "}
            {analysis.simulation.steps.length === 1 ? "step" : "steps"} ·{" "}
            {analysis.simulation.effects.length} effects
          </div>
        </dl>
      ) : null}

      {proposalStatus ? <p role="status">{proposalStatus}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={runAnalysis}>
          Validate and simulate
        </Button>
        <Button type="button" disabled={busy || analysis === null} onClick={runProposal}>
          Propose changeset
        </Button>
      </div>
    </section>
  );
}
