import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Panel } from "~/components/ui/panel";
import type { DryRunResult } from "~/lib/routines/dry-run";

const json = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

/**
 * What the rehearsal found.
 *
 * The effect list is the point of the whole feature, so it leads: each row is a call the Routine
 * *would* have made, with the arguments it would have passed. `dispatched: false` and
 * `secretLeased: false` come from the kernel — a simulated Run is denied the live ports outright
 * rather than asked not to use them — so the reassurance printed here is a fact the browser read,
 * not a claim it made up.
 *
 * The result hash is shown because two dry runs of the same routine over the same fixture produce
 * the same hash. That is what lets a person tell "I changed something" from "it behaves
 * differently today".
 */
export function DryRunResultPanel({
  result,
  onClear,
}: {
  result: DryRunResult;
  onClear: () => void;
}) {
  return (
    <Panel
      title="Dry run result"
      description={`Walked ${result.steps.length} ${result.steps.length === 1 ? "step" : "steps"} in ${result.durationMs}ms. Nothing was dispatched and no secret was leased.`}
      actions={
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Clear
        </button>
      }
      flush
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Badge variant={result.risk === "high" ? "warning" : "neutral"}>
          <ShieldCheck aria-hidden="true" className="size-3" />
          {result.risk} risk
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {result.resultHash.slice(0, 12)}
        </span>
      </div>

      {result.stubbedStates.length > 0 ? (
        <p className="border-b border-border bg-warning/5 px-4 py-3 text-xs text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="mr-1.5 inline size-3.5 text-warning" />
          Nothing was called, so{" "}
          {result.stubbedStates.length === 1 ? "one step was" : "these steps were"} given an empty
          result: {result.stubbedStates.join(", ")}. The calls below are what this routine would
          make. The path it took to reach them may differ once real answers come back.
        </p>
      ) : null}

      {result.effects.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No outbound call would have been made.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {result.effects.map((effect) => (
            <li key={`${effect.stateName}:${effect.action}`} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-foreground">
                  {/* An `action` State names its Tool in `action`, so both read the same here. */}
                  {effect.toolRef === effect.action
                    ? effect.action
                    : `${effect.toolRef}.${effect.action}`}
                </span>
                <Badge variant="neutral">{effect.stateName}</Badge>
                <Badge variant="success">not dispatched</Badge>
                {effect.credentialRef ? <Badge variant="success">secret not leased</Badge> : null}
              </div>
              {effect.input ? (
                <pre className="mt-2 max-h-40 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
                  {json(effect.input)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <details className="border-t border-border">
        <summary className="cursor-pointer px-4 py-3 text-xs text-muted-foreground hover:bg-accent">
          Every step the simulation took
        </summary>
        <ol className="divide-y divide-border border-t border-border">
          {result.steps.map((step, index) => (
            <li
              key={`${step.stateName}-${index}`}
              className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-2 font-mono text-[11px]"
            >
              <span className="text-muted-foreground tabular-nums">{index + 1}</span>
              <span>
                <span className="text-foreground">{step.stateName}</span>
                <span className="text-muted-foreground"> · {step.type}</span>
                {step.next ? (
                  <span className="text-muted-foreground">
                    {" "}
                    → {step.next.kind === "transition" ? step.next.target : "end"}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </Panel>
  );
}
