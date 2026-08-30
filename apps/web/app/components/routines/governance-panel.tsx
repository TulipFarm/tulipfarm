import { Badge } from "~/components/ui/badge";
import { Panel } from "~/components/ui/panel";
import type { RoutineDetail } from "~/lib/routines";
import { type RoutineFacts, riskLabel, riskTone } from "~/lib/routines/facts";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="text-xs text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

const NAMES = (values: readonly string[]) =>
  values.length === 0 ? (
    <span className="text-muted-foreground">None</span>
  ) : (
    <span className="font-mono text-xs">{values.join(", ")}</span>
  );

/**
 * Who owns this Routine, how far it may reach, and what happens when it goes wrong.
 *
 * Bounds are worth a panel because a Routine's blast radius is not visible from its steps: a
 * declared `maxRiskClass` narrows what its Tool calls may do below whatever the caller could do,
 * and an absent one narrows nothing. `riskTone(null)` is deliberately a warning rather than a
 * calm "low" — the routine that declared no ceiling is the less constrained of the two.
 */
export function GovernancePanel({ detail, facts }: { detail: RoutineDetail; facts: RoutineFacts }) {
  const { definition } = detail;
  const limits = definition.spec.limits;

  return (
    <Panel title="Bounds and ownership" flush>
      <dl className="divide-y divide-border">
        <Row label="Owner">
          <span className="font-mono text-xs">{definition.spec.owner}</span>
        </Row>
        {definition.spec.maintainers?.length ? (
          <Row label="Maintainers">{NAMES(definition.spec.maintainers)}</Row>
        ) : null}
        <Row label="Risk ceiling">
          <Badge variant={riskTone(facts.maxRiskClass)}>{riskLabel(facts.maxRiskClass)}</Badge>
        </Row>
        <Row label="Needs a person">
          {facts.humanRoles.length === 0 ? (
            <span className="text-muted-foreground">Runs unattended</span>
          ) : (
            <>Waits for {NAMES(facts.humanRoles)}</>
          )}
        </Row>
        <Row label="Concurrency">
          {definition.spec.concurrency ? (
            <>
              {definition.spec.concurrency.policy.replaceAll("_", " ")}
              <span className="text-muted-foreground">
                {" "}
                by <span className="font-mono text-xs">{definition.spec.concurrency.key}</span>
                {definition.spec.concurrency.max ? `, max ${definition.spec.concurrency.max}` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Unlimited parallel runs</span>
          )}
        </Row>
        <Row label="On failure">
          {facts.guardedStates.length === 0 && facts.retryingStates.length === 0 ? (
            <span className="text-muted-foreground">
              A failing step ends the run. Nothing is retried or undone.
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              {facts.retryingStates.length > 0 ? (
                <span>Retries {NAMES(facts.retryingStates)}</span>
              ) : null}
              {facts.guardedStates.length > 0 ? (
                <span>Handles errors in {NAMES(facts.guardedStates)}</span>
              ) : null}
              {definition.spec.compensation ? (
                <span>
                  Compensation: {definition.spec.compensation.policy.replaceAll("_", " ")}
                </span>
              ) : null}
            </div>
          )}
        </Row>
        {limits ? (
          <Row label="Limits">
            <span className="font-mono text-xs">
              {[
                limits.wallClockMs ? `${Math.round(limits.wallClockMs / 1000)}s` : null,
                limits.tokens ? `${limits.tokens} tokens` : null,
                limits.costUsd ? `$${limits.costUsd}` : null,
                limits.iterations ? `${limits.iterations} iterations` : null,
                limits.fanOut ? `fan-out ${limits.fanOut}` : null,
                limits.parallelism ? `parallelism ${limits.parallelism}` : null,
                limits.retries ? `${limits.retries} retries` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </Row>
        ) : null}
        <Row label="Exits at">{NAMES(facts.terminalStates)}</Row>
        <Row label="Version">
          <span className="font-mono text-xs">
            v{definition.metadata.authoredVersion} · {definition.metadata.lifecycle}
          </span>
        </Row>
      </dl>
    </Panel>
  );
}
