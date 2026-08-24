import type { RuntimeBundle } from "./bundle";

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

function triggerSummary(spec: Record<string, unknown>): string {
  if (spec.type === "cron" && typeof spec.expression === "string") {
    return `cron ${spec.expression}`;
  }
  if (spec.type === "interval" && typeof spec.everyMs === "number") {
    return `every ${spec.everyMs}ms`;
  }
  if (spec.type === "datetime" && typeof spec.at === "string") {
    return `at ${spec.at}`;
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
    for (const definition of bundle.definitions) {
      if (definition.kind !== "Trigger") continue;
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
