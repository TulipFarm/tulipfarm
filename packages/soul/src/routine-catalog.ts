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

export interface RoutineCatalog {
  list(): Promise<RoutineCatalogItem[]>;
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

/** Browser read model sourced only from the verified active Soul publication. */
export class ActiveRoutineCatalog implements RoutineCatalog {
  constructor(private readonly activeBundle: ActiveBundleReader) {}

  async list(): Promise<RoutineCatalogItem[]> {
    const bundle = await this.activeBundle();
    if (!bundle) return [];

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

    return bundle.definitions
      .filter((definition) => {
        if (definition.kind !== "Routine") return false;
        const metadata = isRecord(definition.document.metadata)
          ? definition.document.metadata
          : undefined;
        return metadata?.lifecycle === "published";
      })
      .map((definition) => {
        const metadata = isRecord(definition.document.metadata)
          ? definition.document.metadata
          : undefined;
        return {
          id: definition.id,
          slug: definition.slug,
          displayName: typeof metadata?.displayName === "string" ? metadata.displayName : null,
          authoredVersion: definition.authoredVersion,
          triggers: (triggersByRoutine.get(definition.slug) ?? []).sort((a, b) =>
            a.slug.localeCompare(b.slug)
          ),
        };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }
}
