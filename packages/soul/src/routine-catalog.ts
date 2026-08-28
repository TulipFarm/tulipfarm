import type { RuntimeBundle } from "./bundle";
import { bundleTriggerDefinitions } from "./bundle-triggers";

/** Reads the one bundle the Runtime is currently serving, or nothing when none is active. */
export type ActiveBundleReader = () => Promise<RuntimeBundle | undefined>;

export interface RoutineCatalogTrigger {
  slug: string;
  type: string;
  summary: string;
}

export interface RoutineCatalogItem {
  id: string;
  slug: string;
  displayName: string | null;
  authoredVersion: number;
  triggers: RoutineCatalogTrigger[];
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
