import type { RuntimeBundle } from "./bundle";
import { bundleTriggerDefinitions } from "./bundle-triggers";

/** Reads the one bundle the Runtime is currently serving, or nothing when none is active. */
export type ActiveBundleReader = () => Promise<RuntimeBundle | undefined>;

export interface RoutineCatalogTrigger {
  slug: string;
  type: string;
  summary: string;
}

/**
 * A kind of consequence a Routine can have, as the catalog can see it from the document alone.
 *
 * Coarse on purpose. This answers "what could this thing do to my business" at list density, where
 * the reader is comparing dozens of Routines; the Routine screen answers which Agent, which Tool
 * and which arguments. Every kind here is a claim the document makes about itself, never a guess.
 */
export type RoutineEffectKind =
  | "agent"
  | "tool"
  | "child_routine"
  | "event"
  | "script"
  | "human"
  | "wait";

const EFFECT_BY_STATE_TYPE: Readonly<Record<string, RoutineEffectKind>> = {
  agent: "agent",
  tool: "tool",
  action: "tool",
  child_routine: "child_routine",
  emit: "event",
  script: "script",
  approval: "human",
  human_task: "human",
  form: "human",
  wait: "wait",
};

/** What the list screen needs to rank and filter a Routine without reading its whole document. */
export interface RoutineCatalogSummary {
  /** The Soul principal accountable for this Routine. */
  owner: string | null;
  stateCount: number;
  /** Unique canonical State `type` values, sorted, so a reader can see the shape of the flow. */
  stateTypes: string[];
  /** Coarse consequence kinds, sorted. Empty means the Routine only computes. */
  effects: RoutineEffectKind[];
  /** `spec.requiredToolAbilities`, verbatim — the abilities a Run must be granted to execute. */
  toolAbilities: string[];
  /**
   * The highest `permissionCeiling.maxRiskClass` any State declares, or `null` when none does.
   *
   * `null` is "the author declared no ceiling", never "low". A Routine that names no ceiling is
   * less constrained than one that names `high`, so showing it as the safest value would invert
   * the fact.
   */
  maxRiskClass: "low" | "medium" | "high" | null;
  /** A person must act before the Run can finish. */
  requiresApproval: boolean;
  concurrencyPolicy: string | null;
  compensationPolicy: string | null;
}

export interface RoutineCatalogItem {
  id: string;
  slug: string;
  displayName: string | null;
  authoredVersion: number;
  triggers: RoutineCatalogTrigger[];
  summary: RoutineCatalogSummary;
}

/** One published Routine, with the canonical document the browser renders it from. */
export interface RoutineCatalogDetail extends RoutineCatalogItem {
  /** The canonical Routine document, exactly as the active bundle carries it. */
  definition: Record<string, unknown>;
  /** Content address of the bundle this document came from, so a stale view is detectable. */
  bundleDigest: string;
}

export interface RoutineCatalog {
  list(): Promise<RoutineCatalogItem[]>;
  /** `undefined` when no bundle is active, or the bundle publishes no such Routine. */
  get(slug: string): Promise<RoutineCatalogDetail | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INTERVAL_UNITS = [
  { ms: 86_400_000, one: "day", many: "days" },
  { ms: 3_600_000, one: "hour", many: "hours" },
  { ms: 60_000, one: "minute", many: "minutes" },
  { ms: 1_000, one: "second", many: "seconds" },
] as const;

/**
 * A schedule interval in the units a person would have said it in.
 *
 * `everyMs` is milliseconds because that is what the dispatcher counts down, but nobody asks for a
 * Routine that way: "every 120000ms" is the same schedule as "every 2 minutes" and strictly harder
 * to check at a glance. Two units at most — a third is noise at the sizes a schedule uses.
 */
function formatInterval(everyMs: number): string {
  if (!Number.isFinite(everyMs) || everyMs < 1_000) return `${Math.round(everyMs)}ms`;
  const parts: string[] = [];
  let remaining = Math.round(everyMs);
  for (const unit of INTERVAL_UNITS) {
    const count = Math.floor(remaining / unit.ms);
    if (count === 0) continue;
    parts.push(`${count} ${count === 1 ? unit.one : unit.many}`);
    remaining -= count * unit.ms;
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/**
 * A one-off schedule instant, to the minute, labelled with the zone it is actually in.
 *
 * Rendered here rather than in the browser because this summary is also read where no viewer
 * exists. UTC is named rather than quietly converted: a scheduled time shown in a zone it was not
 * written in is worse than one the reader has to convert, because it looks already converted.
 */
function formatInstant(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return at;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function triggerSummary(spec: Record<string, unknown>): string {
  if (spec.type === "cron" && typeof spec.expression === "string") {
    return `cron ${spec.expression}`;
  }
  if (spec.type === "interval" && typeof spec.everyMs === "number") {
    return `every ${formatInterval(spec.everyMs)}`;
  }
  if (spec.type === "datetime" && typeof spec.at === "string") {
    return `at ${formatInstant(spec.at)}`;
  }
  return typeof spec.type === "string" ? spec.type.replaceAll("_", " ") : "unknown";
}

function isPublished(definition: RuntimeBundle["definitions"][number]): boolean {
  const metadata = isRecord(definition.document.metadata)
    ? definition.document.metadata
    : undefined;
  return metadata?.lifecycle === "published";
}

const RISK_ORDER = ["low", "medium", "high"] as const;
type RiskClass = (typeof RISK_ORDER)[number];

function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_ORDER as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Reads a published Routine's own claims about what it does.
 *
 * Every field is read, never inferred: an unrecognised State type contributes no effect rather
 * than a guessed one, because a list that overstates reach is as misleading as one that hides it.
 */
function routineSummary(document: Record<string, unknown>): RoutineCatalogSummary {
  const spec = isRecord(document.spec) ? document.spec : {};
  const states = Array.isArray(spec.states) ? spec.states.filter(isRecord) : [];
  const stateTypes = new Set<string>();
  const effects = new Set<RoutineEffectKind>();
  let maxRiskClass: RiskClass | null = null;
  let requiresApproval = false;

  for (const state of states) {
    if (typeof state.type !== "string") continue;
    stateTypes.add(state.type);
    const effect = EFFECT_BY_STATE_TYPE[state.type];
    if (effect) effects.add(effect);
    if (state.type === "approval" || state.type === "human_task") requiresApproval = true;
    const ceiling = isRecord(state.permissionCeiling) ? state.permissionCeiling : undefined;
    const risk = ceiling?.maxRiskClass;
    if (
      isRiskClass(risk) &&
      (!maxRiskClass || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(maxRiskClass))
    ) {
      maxRiskClass = risk;
    }
  }

  const concurrency = isRecord(spec.concurrency) ? spec.concurrency : undefined;
  const compensation = isRecord(spec.compensation) ? spec.compensation : undefined;

  return {
    owner: typeof spec.owner === "string" ? spec.owner : null,
    stateCount: states.length,
    stateTypes: [...stateTypes].sort(),
    effects: [...effects].sort(),
    toolAbilities: stringList(spec.requiredToolAbilities).sort(),
    maxRiskClass,
    requiresApproval,
    concurrencyPolicy: typeof concurrency?.policy === "string" ? concurrency.policy : null,
    compensationPolicy: typeof compensation?.policy === "string" ? compensation.policy : null,
  };
}

function catalogItem(
  definition: RuntimeBundle["definitions"][number],
  triggers: RoutineCatalogTrigger[]
): RoutineCatalogItem {
  const metadata = isRecord(definition.document.metadata)
    ? definition.document.metadata
    : undefined;
  return {
    id: definition.id,
    slug: definition.slug,
    displayName: typeof metadata?.displayName === "string" ? metadata.displayName : null,
    authoredVersion: definition.authoredVersion,
    triggers,
    summary: routineSummary(definition.document as Record<string, unknown>),
  };
}

/** Browser read model sourced only from the verified active Soul publication. */
export class ActiveRoutineCatalog implements RoutineCatalog {
  constructor(private readonly activeBundle: ActiveBundleReader) {}

  async list(): Promise<RoutineCatalogItem[]> {
    const bundle = await this.activeBundle();
    if (!bundle) return [];
    const triggersByRoutine = this.triggersByRoutine(bundle);
    return bundle.definitions
      .filter((definition) => definition.kind === "Routine" && isPublished(definition))
      .map((definition) => catalogItem(definition, triggersByRoutine.get(definition.slug) ?? []))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async get(slug: string): Promise<RoutineCatalogDetail | undefined> {
    const bundle = await this.activeBundle();
    const definition = bundle?.get("Routine", slug);
    if (!bundle || !definition || !isPublished(definition)) return undefined;
    return {
      ...catalogItem(definition, this.triggersByRoutine(bundle).get(slug) ?? []),
      definition: definition.document as Record<string, unknown>,
      bundleDigest: bundle.digest,
    };
  }

  private triggersByRoutine(bundle: RuntimeBundle): Map<string, RoutineCatalogTrigger[]> {
    const triggersByRoutine = new Map<string, RoutineCatalogTrigger[]>();
    for (const definition of bundleTriggerDefinitions(bundle)) {
      const metadata = isRecord(definition.document.metadata)
        ? definition.document.metadata
        : undefined;
      const spec = isRecord(definition.document.spec) ? definition.document.spec : undefined;
      const routineRef = isRecord(spec?.routineRef) ? spec.routineRef : undefined;
      if (
        metadata?.lifecycle !== "published" ||
        typeof spec?.type !== "string" ||
        typeof routineRef?.name !== "string"
      ) {
        continue;
      }
      const triggers = triggersByRoutine.get(routineRef.name) ?? [];
      triggers.push({
        slug: definition.slug,
        type: spec.type,
        summary: triggerSummary(spec),
      });
      triggersByRoutine.set(routineRef.name, triggers);
    }
    for (const triggers of triggersByRoutine.values()) {
      triggers.sort((a, b) => a.slug.localeCompare(b.slug));
    }
    return triggersByRoutine;
  }
}
