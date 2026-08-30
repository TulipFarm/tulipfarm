import type { routine as routineSchema } from "@tulipfarm/schema";
import type {
  RiskClass,
  RoutineEffectKind,
  RoutineSummary,
  RoutineTrigger,
  RunStatus,
} from "../routines";
import { describeCron } from "./cron";

/**
 * Reading a Routine's own claims about what it does.
 *
 * Pure and total: every export takes plain data and returns plain data, so both the catalog and the
 * Routine screen answer "what will this do to my business" from one implementation. Nothing here
 * infers a consequence the document did not state — an unrecognised State contributes nothing
 * rather than a guess, because a screen that overstates reach is as misleading as one that hides
 * it.
 */

type RoutineState = routineSchema.RoutineState;

/* -------------------------------------------------------------------------- */
/* Triggers                                                                   */
/* -------------------------------------------------------------------------- */

/** How a Routine starts, at the grain a person filters by. */
export type TriggerKind = "schedule" | "event" | "request" | "human";

const TRIGGER_KIND: Readonly<Record<string, TriggerKind>> = {
  cron: "schedule",
  interval: "schedule",
  datetime: "schedule",
  internal_event: "event",
  integration_event: "event",
  webhook: "request",
  internal_api: "request",
  manual: "human",
  form: "human",
};

export const TRIGGER_KIND_LABEL: Readonly<Record<TriggerKind, string>> = {
  schedule: "On a schedule",
  event: "When something happens",
  request: "When called",
  human: "When a person asks",
};

export function triggerKind(trigger: Pick<RoutineTrigger, "type">): TriggerKind {
  return TRIGGER_KIND[trigger.type] ?? "request";
}

/**
 * The Trigger as a sentence, not a jargon token.
 *
 * The catalog renders the machine-readable part (`cron 0 9 * * 1`, `every 2 minutes`); this puts
 * the verb in front of it so the chip reads as a claim rather than a label, and translates a cron
 * expression into English where it can do so exactly. `describeCron` returns `null` for any shape
 * it cannot translate exactly, and the expression is then shown verbatim — a confidently wrong
 * schedule is worse than an unreadable one. `triggerExpression` keeps the raw form reachable.
 */
export function triggerPhrase(trigger: RoutineTrigger): string {
  const summary = trigger.summary.trim();
  if (trigger.type === "manual") return "Started by hand";
  if (trigger.type === "form") return "Submitted from a form";
  if (trigger.type === "webhook") return "Called by a webhook";
  if (trigger.type === "internal_api") return "Called over the API";
  if (summary.startsWith("cron ")) {
    const english = describeCron(summary.slice("cron ".length));
    return english ?? `Runs on cron ${summary.slice("cron ".length)}`;
  }
  if (summary.startsWith("every ")) return `Runs ${summary}`;
  if (summary.startsWith("at ")) return `Runs once ${summary}`;
  if (trigger.type.endsWith("event")) return `Runs on ${summary.replaceAll("_", " ")}`;
  return summary || trigger.type.replaceAll("_", " ");
}

/**
 * The raw cron expression, where `triggerPhrase` replaced it with English.
 *
 * @returns the expression, or `undefined` when the phrase already shows everything the summary
 * says — so a caller can surface the exact schedule without repeating it.
 */
export function triggerExpression(trigger: RoutineTrigger): string | undefined {
  const summary = trigger.summary.trim();
  if (!summary.startsWith("cron ")) return undefined;
  const expression = summary.slice("cron ".length);
  return describeCron(expression) ? expression : undefined;
}

/* -------------------------------------------------------------------------- */
/* Effects                                                                    */
/* -------------------------------------------------------------------------- */

export const EFFECT_LABEL: Readonly<Record<RoutineEffectKind, string>> = {
  agent: "Runs an agent",
  tool: "Calls a tool",
  child_routine: "Starts another routine",
  event: "Announces an event",
  script: "Runs code",
  human: "Needs a person",
  wait: "Waits",
};

/** The same seven consequences as one word, for a dense row that cannot carry the sentence. */
export const EFFECT_NOUN: Readonly<Record<RoutineEffectKind, string>> = {
  agent: "Agent",
  tool: "Tool",
  child_routine: "Routine",
  event: "Event",
  script: "Code",
  human: "Person",
  wait: "Wait",
};

/** Ordered loudest-consequence first, so a reader meets the riskiest claim before the quietest. */
export const EFFECT_ORDER: readonly RoutineEffectKind[] = [
  "tool",
  "agent",
  "child_routine",
  "script",
  "event",
  "human",
  "wait",
];

/** One consequence, traced to the State that causes it. */
export interface RoutineEffect {
  kind: RoutineEffectKind;
  /** The State name, so the reader can find it on the canvas. */
  state: string;
  /** What it reaches: an agent name, `tool.action`, a routine name, an event type. */
  target: string;
  /** A qualifier the reader needs to judge it — a credential, roles, a duration. */
  detail?: string;
}

function waitDetail(state: Extract<RoutineState, { type: "wait" }>): RoutineEffect {
  const { waitFor } = state;
  const target =
    waitFor.kind === "timer"
      ? waitFor.durationMs
        ? `${Math.round(waitFor.durationMs / 1000)}s timer`
        : "timer"
      : (waitFor.eventType ?? "an event");
  return { kind: "wait", state: state.name, target, detail: waitFor.correlation };
}

/**
 * Every consequence this Routine can have, in State order.
 *
 * State order rather than severity order: the reader is holding a canvas that runs left to right,
 * and a list sorted differently from the thing beside it costs more to reconcile than it saves.
 */
export function routineEffects(definition: routineSchema.RoutineDefinition): RoutineEffect[] {
  const effects: RoutineEffect[] = [];
  for (const state of definition.spec.states) {
    if (state.type === "agent") {
      effects.push({ kind: "agent", state: state.name, target: state.agentRef.name });
    } else if (state.type === "tool") {
      effects.push({
        kind: "tool",
        state: state.name,
        target: `${state.toolRef.name}.${state.action}`,
        detail: state.credentialRef ? "uses a credential" : state.destination,
      });
    } else if (state.type === "action") {
      effects.push({ kind: "tool", state: state.name, target: state.action });
    } else if (state.type === "child_routine") {
      effects.push({
        kind: "child_routine",
        state: state.name,
        target: state.routineRef.name,
        detail: state.mode === "detach" ? "does not wait" : "waits for it",
      });
    } else if (state.type === "emit") {
      effects.push({ kind: "event", state: state.name, target: state.event.type });
    } else if (state.type === "script") {
      effects.push({
        kind: "script",
        state: state.name,
        target: state.entry ?? "run",
        detail: "sealed isolate, no network",
      });
    } else if (state.type === "approval") {
      effects.push({
        kind: "human",
        state: state.name,
        target: "approval",
        detail: state.approverRoles.join(", "),
      });
    } else if (state.type === "human_task") {
      effects.push({
        kind: "human",
        state: state.name,
        target: "task",
        detail: state.assigneeRoles.join(", "),
      });
    } else if (state.type === "form") {
      effects.push({ kind: "human", state: state.name, target: state.formRef.name });
    } else if (state.type === "wait") {
      effects.push(waitDetail(state));
    }
  }
  return effects;
}

/* -------------------------------------------------------------------------- */
/* Whole-routine facts                                                        */
/* -------------------------------------------------------------------------- */

export interface RoutineFacts {
  start: string;
  stateCount: number;
  effects: RoutineEffect[];
  /** Distinct names by kind, for the "what it touches" summary lines. */
  agents: string[];
  tools: string[];
  childRoutines: string[];
  events: string[];
  /** Secrets named by a `tool` State's `credentialRef`. */
  credentials: string[];
  /** Every role that must act before a Run can finish. */
  humanRoles: string[];
  /** States that can end the Routine, so the reader can see every exit. */
  terminalStates: string[];
  /** States carrying at least one `onError` handler. */
  guardedStates: string[];
  /** States carrying a `retry` policy. */
  retryingStates: string[];
  maxRiskClass: RiskClass | null;
}

const RISK_ORDER: readonly RiskClass[] = ["low", "medium", "high"];

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

export function routineFacts(definition: routineSchema.RoutineDefinition): RoutineFacts {
  const states = definition.spec.states;
  const effects = routineEffects(definition);
  const byKind = (kind: RoutineEffectKind) =>
    unique(effects.filter((effect) => effect.kind === kind).map((effect) => effect.target));

  let maxRiskClass: RiskClass | null = null;
  for (const state of states) {
    const risk = state.permissionCeiling?.maxRiskClass;
    if (risk && (!maxRiskClass || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(maxRiskClass))) {
      maxRiskClass = risk;
    }
  }

  return {
    start: definition.spec.start,
    stateCount: states.length,
    effects,
    agents: byKind("agent"),
    tools: byKind("tool"),
    childRoutines: byKind("child_routine"),
    events: byKind("event"),
    credentials: unique(
      states.map((state) => (state.type === "tool" ? state.credentialRef : undefined))
    ),
    humanRoles: unique(
      states.flatMap((state) =>
        state.type === "approval"
          ? state.approverRoles
          : state.type === "human_task"
            ? state.assigneeRoles
            : []
      )
    ),
    terminalStates: states
      .filter((state) => state.end === true || endsInBranch(state))
      .map((state) => state.name),
    guardedStates: states.filter((state) => (state.onError ?? []).length > 0).map((s) => s.name),
    retryingStates: states.filter((state) => state.retry).map((state) => state.name),
    maxRiskClass,
  };
}

function endsInBranch(state: RoutineState): boolean {
  if (state.type !== "branch") return false;
  return (
    state.conditions.some((condition) => condition.end === true) || state.default?.end === true
  );
}

/* -------------------------------------------------------------------------- */
/* Risk                                                                       */
/* -------------------------------------------------------------------------- */

export const RISK_LABEL: Readonly<Record<RiskClass, string>> = {
  low: "Low risk ceiling",
  medium: "Medium risk ceiling",
  high: "High risk ceiling",
};

/**
 * How to render a declared ceiling.
 *
 * `null` reads as "no ceiling declared" and takes the warning tone rather than the calm one: a
 * Routine that names no ceiling is less constrained than one that names `high`, so showing the
 * absence as reassuring would invert the fact.
 */
export function riskTone(risk: RiskClass | null): "neutral" | "warning" | "danger" {
  if (risk === "low") return "neutral";
  if (risk === "high") return "danger";
  return "warning";
}

export function riskLabel(risk: RiskClass | null): string {
  return risk ? RISK_LABEL[risk] : "No risk ceiling declared";
}

/**
 * The same fact, short enough for a fixed-width catalog column.
 *
 * A column that truncates its own value is worse than a shorter word: the reader gets neither the
 * fact nor a way to reach it. So the list gets a label that always fits, and the detail page —
 * which has the room — gets the full sentence from `riskLabel`.
 */
export function riskShortLabel(risk: RiskClass | null): string {
  return risk ? `${risk[0].toUpperCase()}${risk.slice(1)} risk` : "No ceiling";
}

/* -------------------------------------------------------------------------- */
/* Run health                                                                 */
/* -------------------------------------------------------------------------- */

export type RunHealth = "healthy" | "attention" | "failing" | "never-run";

const FAILING: ReadonlySet<RunStatus> = new Set(["failed", "needs_reconciliation"]);
const ATTENTION: ReadonlySet<RunStatus> = new Set(["attention_required", "waiting", "cancelling"]);

/**
 * The health of a Routine, read from its newest Run only.
 *
 * Deliberately not a success rate over a window. A rate answers "has this been reliable", but the
 * question a catalog row is asked is "is this broken right now", and an 80% rate reads as fine
 * while the thing has been failing every run since Tuesday.
 */
export function runHealth(latest: { status: RunStatus } | undefined): RunHealth {
  if (!latest) return "never-run";
  if (FAILING.has(latest.status)) return "failing";
  if (ATTENTION.has(latest.status)) return "attention";
  return "healthy";
}

/* -------------------------------------------------------------------------- */
/* Catalog search and grouping                                                */
/* -------------------------------------------------------------------------- */

export function routineDisplayName(routine: Pick<RoutineSummary, "slug" | "displayName">): string {
  return routine.displayName ?? routine.slug;
}

/**
 * Whether a Routine answers a free-text query.
 *
 * Matches the Trigger summaries and the owner as well as the name, because "what runs every
 * morning" and "what does finance own" are the two questions a catalog is actually asked, and
 * neither is answerable from a name.
 */
export function matchesRoutineQuery(routine: RoutineSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    routine.slug,
    routine.displayName,
    routine.summary.owner,
    ...routine.summary.stateTypes,
    ...routine.summary.toolAbilities,
    ...routine.triggers.map((trigger) => trigger.summary),
    ...routine.triggers.map((trigger) => trigger.type),
  ];
  return haystack.some((entry) => entry?.toLowerCase().includes(needle));
}

/** Every Trigger kind a Routine has, so one Routine can appear under each way it starts. */
export function routineTriggerKinds(routine: RoutineSummary): TriggerKind[] {
  const kinds = new Set(routine.triggers.map(triggerKind));
  return [...kinds];
}

const GROUP_ORDER: readonly TriggerKind[] = ["schedule", "event", "request", "human"];

/**
 * Routines grouped by how they start, plus the ones no published Trigger names.
 *
 * A Routine with several Triggers is filed under its first in `GROUP_ORDER` rather than repeated:
 * a catalog whose total exceeds its item count cannot be counted by eye, and the row itself lists
 * every Trigger anyway.
 */
export function groupByTriggerKind(
  routines: readonly RoutineSummary[]
): Array<[TriggerKind | "untriggered", RoutineSummary[]]> {
  const groups = new Map<TriggerKind | "untriggered", RoutineSummary[]>();
  for (const routine of routines) {
    const kinds = routineTriggerKinds(routine);
    const key = GROUP_ORDER.find((kind) => kinds.includes(kind)) ?? "untriggered";
    groups.set(key, [...(groups.get(key) ?? []), routine]);
  }
  return [...groups.entries()].sort(
    (a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0])
  );
}

function groupRank(key: TriggerKind | "untriggered"): number {
  const index = GROUP_ORDER.indexOf(key as TriggerKind);
  return index === -1 ? GROUP_ORDER.length : index;
}

export const GROUP_LABEL: Readonly<Record<TriggerKind | "untriggered", string>> = {
  ...TRIGGER_KIND_LABEL,
  untriggered: "Not triggered automatically",
};
