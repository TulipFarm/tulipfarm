import type { AgentGovernance } from "~/lib/agents";

function Values({ values }: { values: readonly string[] }) {
  if (values.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <span key={value} className="rounded-sm border border-border px-1.5 py-0.5">
          {value}
        </span>
      ))}
    </span>
  );
}

export function AgentGovernanceCard({
  governance,
  busy = false,
  result,
  onPublish,
}: {
  governance: AgentGovernance;
  busy?: boolean;
  result?: string;
  onPublish: () => void;
}) {
  const candidate = governance.publication.candidateVersion;
  return (
    <section className="border border-border bg-card" aria-labelledby="agent-governance-title">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 id="agent-governance-title" className="text-xs font-medium ">
          Governance
        </h2>
        <span className="text-xs text-muted-foreground">version {governance.version}</span>
        <span className="ml-auto text-xs text-primary">candidate {candidate}</span>
      </div>
      <dl className="grid gap-3 px-3 py-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="mb-1 text-muted-foreground">Roles</dt>
          <dd>
            <Values values={governance.roles} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">Skills</dt>
          <dd>
            <Values values={governance.skills} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">Tools</dt>
          <dd>
            <Values values={governance.tools} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">Model profile</dt>
          <dd>{governance.modelProfile}</dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">Limits</dt>
          <dd>
            {Object.entries(governance.limits)
              .map(([key, value]) => `${key}: ${value}`)
              .join(" · ")}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">Evaluation</dt>
          <dd>
            {governance.evaluation.status} · {governance.evaluation.suite}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {governance.publication.reason ?? governance.publication.status}
        </span>
        {result ? (
          <span role="status" className="text-xs text-primary">
            {result}
          </span>
        ) : null}
        <button
          type="button"
          disabled={!governance.publication.canPublish || busy}
          onClick={onPublish}
          className="ml-auto rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Proposing…" : `Propose version ${candidate}`}
        </button>
      </div>
    </section>
  );
}
