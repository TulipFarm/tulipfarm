import { Bot, Braces, Clock, GitBranch, Hand, Radio, Wrench } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Panel } from "~/components/ui/panel";
import type { RoutineEffectKind } from "~/lib/routines";
import { EFFECT_LABEL, type RoutineEffect, type RoutineFacts } from "~/lib/routines/facts";

const ICON: Record<RoutineEffectKind, typeof Bot> = {
  tool: Wrench,
  agent: Bot,
  child_routine: GitBranch,
  script: Braces,
  event: Radio,
  human: Hand,
  wait: Clock,
};

/** Only `tool` leaves the instance; everything else is loud but internal. */
const TONE: Record<RoutineEffectKind, "neutral" | "warning" | "info"> = {
  tool: "warning",
  agent: "info",
  child_routine: "info",
  script: "neutral",
  event: "neutral",
  human: "neutral",
  wait: "neutral",
};

function EffectRow({ effect }: { effect: RoutineEffect }) {
  const Icon = ICON[effect.kind];
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2 sm:w-52 sm:shrink-0">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm text-foreground">{EFFECT_LABEL[effect.kind]}</span>
      </div>
      <p className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{effect.target}</p>
      {effect.detail ? (
        <p className="min-w-0 truncate text-xs text-muted-foreground sm:w-44">{effect.detail}</p>
      ) : null}
      <Badge variant={TONE[effect.kind]} className="shrink-0">
        {effect.state}
      </Badge>
    </li>
  );
}

/**
 * Everything this Routine does to the world, traced to the step that does it.
 *
 * The page's most important panel and deliberately the plainest: one row per consequence, in the
 * order the canvas draws them, with the State name on the right so a reader can carry a row back
 * to the graph. Nothing is aggregated away — two Tool calls to the same provider are two rows,
 * because "it calls Slack" and "it calls Slack twice" are different facts to a person deciding
 * whether to press Run.
 */
export function EffectsPanel({ facts }: { facts: RoutineFacts }) {
  return (
    <Panel
      title="What this routine does"
      description={
        facts.effects.length === 0
          ? undefined
          : `${facts.effects.length} ${facts.effects.length === 1 ? "consequence" : "consequences"} across ${facts.stateCount} ${facts.stateCount === 1 ? "step" : "steps"}.`
      }
      flush
    >
      {facts.effects.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          Every step only derives values from its input. This routine reaches nothing outside the
          instance, calls no model and needs no person.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {facts.effects.map((effect) => (
            <EffectRow key={`${effect.state}:${effect.target}`} effect={effect} />
          ))}
        </ul>
      )}

      {facts.credentials.length > 0 ? (
        <div className="border-t border-border bg-muted/40 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Leases {facts.credentials.length === 1 ? "the credential" : "the credentials"}{" "}
            <span className="font-mono text-foreground">{facts.credentials.join(", ")}</span>
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
