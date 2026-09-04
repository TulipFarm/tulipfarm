import { Calendar, Hand, Radio, Webhook } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Tooltip } from "~/components/ui/tooltip";
import type { RoutineTrigger } from "~/lib/routines";
import {
  type TriggerKind,
  triggerExpression,
  triggerKind,
  triggerPhrase,
} from "~/lib/routines/facts";

const KIND_ICON: Record<TriggerKind, typeof Calendar> = {
  schedule: Calendar,
  event: Radio,
  request: Webhook,
  human: Hand,
};

/**
 * One way this Routine starts, as a sentence.
 *
 * The chip carries a value, not a label. A cron expression is translated into English where that
 * can be done exactly, with the expression itself kept in the tooltip.
 */
export function TriggerChip({ trigger }: { trigger: RoutineTrigger }) {
  const kind = triggerKind(trigger);
  const Icon = KIND_ICON[kind];
  // The phrase replaced the cron expression with English; the tooltip keeps the exact schedule
  // reachable, so an author can still verify what the chip claims.
  const expression = triggerExpression(trigger);
  const detail = `${trigger.slug} · ${trigger.type.replaceAll("_", " ")}`;
  return (
    <Tooltip content={expression ? `${detail} · ${expression}` : detail}>
      <Badge variant="neutral" className="max-w-full gap-1.5 font-normal">
        <Icon aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{triggerPhrase(trigger)}</span>
      </Badge>
    </Tooltip>
  );
}

/**
 * Every way a Routine starts, or an explicit statement that nothing starts it.
 *
 * The empty case is a sentence rather than a blank: "no triggers" and "I have not loaded yet" look
 * identical when both render nothing, and the difference matters — a Routine nothing triggers only
 * ever runs when a person presses the button.
 */
export function TriggerList({ triggers }: { triggers: readonly RoutineTrigger[] }) {
  if (triggers.length === 0) {
    return <span className="text-xs text-muted-foreground">Only runs when started by hand</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {triggers.map((trigger) => (
        <TriggerChip key={trigger.slug} trigger={trigger} />
      ))}
    </span>
  );
}
