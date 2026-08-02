import type { ResolvedRoutineInvocation, RoutineInvocationResolver } from "@tulipfarm/run-kernel";
import type { BundleSigner, SoulPublicationCoordinator } from "@tulipfarm/soul";

const ROUTINE_DEFINITION_PREFIX = "published:routine:";

type ActiveBundleReader = Pick<SoulPublicationCoordinator, "activeBundle">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundledStateRef(
  digest: string,
  routineId: string,
  routineVersion: string,
  stateKey: string
): string {
  return [
    `bundle:${encodeURIComponent(digest)}`,
    `routines/${encodeURIComponent(routineId)}@${encodeURIComponent(routineVersion)}`,
    `states/${encodeURIComponent(stateKey)}`,
  ].join("/");
}

/**
 * Resolves a Routine only from the verified active Soul bundle. The live Git checkout and the
 * legacy Routine registry are deliberately not consulted: a missing, draft, or malformed active
 * definition denies the invocation before it can mint a Run.
 */
export class ActiveRoutineInvocationResolver implements RoutineInvocationResolver {
  constructor(
    private readonly publications: ActiveBundleReader,
    private readonly signer: BundleSigner
  ) {}

  async resolve(input: {
    readonly businessId: string;
    readonly definitionRef: string;
  }): Promise<ResolvedRoutineInvocation | undefined> {
    if (!input.definitionRef.startsWith(ROUTINE_DEFINITION_PREFIX)) return undefined;
    const slug = input.definitionRef.slice(ROUTINE_DEFINITION_PREFIX.length);
    if (slug.length === 0) return undefined;

    const bundle = await this.publications.activeBundle(input.businessId, this.signer);
    const definition = bundle?.get("Routine", slug);
    if (!bundle || !definition) return undefined;

    const document = definition.document;
    const metadata = isRecord(document.metadata) ? document.metadata : undefined;
    const spec = isRecord(document.spec) ? document.spec : undefined;
    const start = spec?.start;
    const states = spec?.states;
    if (
      metadata?.lifecycle !== "published" ||
      typeof start !== "string" ||
      start.length === 0 ||
      !Array.isArray(states) ||
      !states.some((state) => isRecord(state) && state.name === start)
    ) {
      return undefined;
    }

    const routineVersion = String(definition.authoredVersion);
    return {
      bundle: {
        digest: bundle.digest,
        routineId: definition.id,
        routineVersion,
      },
      startState: {
        key: start,
        definitionRef: bundledStateRef(bundle.digest, definition.id, routineVersion, start),
      },
    };
  }
}
