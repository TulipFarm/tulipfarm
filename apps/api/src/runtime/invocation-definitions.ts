import {
  type RegisteredTrigger,
  type ResolvedRoutineInvocation,
  type RoutineInvocationResolver,
  routineStateDefinitionRef,
  type TriggerKind,
  type WebhookTrigger,
  type WebhookVerificationMethod,
} from "@tulipfarm/run-kernel";
import { definitions } from "@tulipfarm/schema";
import type { BundleVerifier, SoulPublicationCoordinator } from "@tulipfarm/soul";

const ROUTINE_DEFINITION_PREFIX = "published:routine:";

// Widened so `.includes` accepts a raw `string` read off an authored document rather than only a
// value already known to be a `TriggerType`.
const TRIGGER_TYPES: readonly string[] = definitions.trigger.TRIGGER_TYPES;
const WEBHOOK_VERIFICATION_METHODS: readonly string[] =
  definitions.trigger.WEBHOOK_VERIFICATION_METHODS;

type ActiveBundleReader = Pick<SoulPublicationCoordinator, "activeBundle">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined`: no mapping authored. `null`: authored but malformed — the caller must fail closed. */
function mapInputMappings(raw: unknown): Record<string, string> | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") return null;
    mapped[key] = value;
  }
  return mapped;
}

/**
 * Resolves a Routine only from the verified active Soul bundle. The live Git checkout and the
 * legacy Routine registry are deliberately not consulted: a missing, draft, or malformed active
 * definition denies the invocation before it can mint a Run.
 */
export class ActiveRoutineInvocationResolver implements RoutineInvocationResolver {
  constructor(
    private readonly publications: ActiveBundleReader,
    private readonly verifier: BundleVerifier
  ) {}

  async resolve(input: {
    readonly businessId: string;
    readonly definitionRef: string;
  }): Promise<ResolvedRoutineInvocation | undefined> {
    if (!input.definitionRef.startsWith(ROUTINE_DEFINITION_PREFIX)) return undefined;
    const slug = input.definitionRef.slice(ROUTINE_DEFINITION_PREFIX.length);
    if (slug.length === 0) return undefined;

    const bundle = await this.publications.activeBundle(input.businessId, this.verifier);
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
        definitionRef: routineStateDefinitionRef(
          { digest: bundle.digest, routineId: definition.id, routineVersion },
          start
        ),
      },
    };
  }
}

/**
 * Resolves a Trigger only from the verified active Soul bundle, for the same reason as
 * {@link ActiveRoutineInvocationResolver}: a missing, draft, or malformed active definition denies
 * the invocation before it can mint a Run. `semanticIntakeAgent` is never set — no authored Trigger
 * can declare it today — and `requireVerified` is never set, since the manual/internal_api envelopes
 * this resolver serves are always constructed `unverified` by the invoking route.
 */
export class ActiveTriggerInvocationResolver {
  constructor(
    private readonly publications: ActiveBundleReader,
    private readonly verifier: BundleVerifier,
    private readonly businessId: string
  ) {}

  async resolveTrigger(slug: string): Promise<RegisteredTrigger | null> {
    if (slug.length === 0) return null;

    const bundle = await this.publications.activeBundle(this.businessId, this.verifier);
    const definition = bundle?.get("Trigger", slug);
    if (!bundle || !definition) return null;

    const document = definition.document;
    const metadata = isRecord(document.metadata) ? document.metadata : undefined;
    const spec = isRecord(document.spec) ? document.spec : undefined;
    if (metadata?.lifecycle !== "published" || spec === undefined) return null;

    const type = spec.type;
    if (typeof type !== "string" || !TRIGGER_TYPES.includes(type)) return null;

    const routineRef = spec.routineRef;
    if (
      !isRecord(routineRef) ||
      typeof routineRef.name !== "string" ||
      routineRef.name.length === 0 ||
      typeof routineRef.version !== "string" ||
      routineRef.version.length === 0
    ) {
      return null;
    }

    const eventType = spec.eventType;
    const eventVersion = spec.eventVersion;
    if (
      typeof eventType !== "string" ||
      eventType.length === 0 ||
      typeof eventVersion !== "number"
    ) {
      return null;
    }

    const backgroundIdentity = spec.backgroundIdentity;
    if (
      !isRecord(backgroundIdentity) ||
      typeof backgroundIdentity.principalKind !== "string" ||
      backgroundIdentity.principalKind.length === 0 ||
      typeof backgroundIdentity.principalId !== "string" ||
      backgroundIdentity.principalId.length === 0
    ) {
      return null;
    }

    const inputMappings = mapInputMappings(spec.inputMapping);
    if (inputMappings === null) return null;

    return {
      triggerSlug: slug,
      authoredVersion: definition.authoredVersion,
      lifecycle: "published",
      type: type as TriggerKind,
      eventType,
      eventVersion,
      routineRef: { name: routineRef.name, version: routineRef.version },
      backgroundIdentity: {
        principalKind: backgroundIdentity.principalKind,
        principalId: backgroundIdentity.principalId,
      },
      ...(inputMappings === undefined ? {} : { inputMappings }),
    };
  }
}

/**
 * Resolves a webhook Trigger only from the verified active Soul bundle, for the same reason as
 * {@link ActiveTriggerInvocationResolver}. Never populates `filter`: the authored `filter` is a
 * plain dot-path string, structurally incompatible with `WebhookTrigger`'s `{path, equals}` shape.
 */
export class ActiveWebhookTriggerResolver {
  constructor(
    private readonly publications: ActiveBundleReader,
    private readonly verifier: BundleVerifier,
    private readonly businessId: string
  ) {}

  async resolveTrigger(provider: string, triggerSlug: string): Promise<WebhookTrigger | null> {
    if (provider.length === 0 || triggerSlug.length === 0) return null;

    const bundle = await this.publications.activeBundle(this.businessId, this.verifier);
    const definition = bundle?.get("Trigger", triggerSlug);
    if (!bundle || !definition) return null;

    const document = definition.document;
    const metadata = isRecord(document.metadata) ? document.metadata : undefined;
    const spec = isRecord(document.spec) ? document.spec : undefined;
    if (metadata?.lifecycle !== "published" || spec?.type !== "webhook") return null;

    if (spec.provider !== provider) return null;

    const eventType = spec.eventType;
    const eventVersion = spec.eventVersion;
    if (
      typeof eventType !== "string" ||
      eventType.length === 0 ||
      typeof eventVersion !== "number"
    ) {
      return null;
    }

    const verification = spec.verification;
    if (
      !isRecord(verification) ||
      typeof verification.method !== "string" ||
      !WEBHOOK_VERIFICATION_METHODS.includes(verification.method) ||
      typeof verification.secretRef !== "string" ||
      verification.secretRef.length === 0 ||
      typeof verification.signatureHeader !== "string" ||
      verification.signatureHeader.length === 0
    ) {
      return null;
    }
    const optionalStringField = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const signingTemplate = optionalStringField(verification.signingTemplate);
    const signatureFormat = optionalStringField(verification.signatureFormat);
    const timestampHeader = optionalStringField(verification.timestampHeader);
    const toleranceMs =
      typeof verification.toleranceMs === "number" ? verification.toleranceMs : undefined;

    const backgroundIdentity = spec.backgroundIdentity;
    if (
      !isRecord(backgroundIdentity) ||
      typeof backgroundIdentity.principalKind !== "string" ||
      backgroundIdentity.principalKind.length === 0 ||
      typeof backgroundIdentity.principalId !== "string" ||
      backgroundIdentity.principalId.length === 0
    ) {
      return null;
    }

    return {
      triggerSlug,
      businessId: this.businessId,
      provider,
      eventType,
      eventVersion,
      verification: {
        method: verification.method as WebhookVerificationMethod,
        secretRef: verification.secretRef,
        signatureHeader: verification.signatureHeader,
        ...(signingTemplate === undefined ? {} : { signingTemplate }),
        ...(signatureFormat === undefined ? {} : { signatureFormat }),
        ...(timestampHeader === undefined ? {} : { timestampHeader }),
        ...(toleranceMs === undefined ? {} : { toleranceMs }),
      },
      backgroundIdentity: {
        principalKind: backgroundIdentity.principalKind,
        principalId: backgroundIdentity.principalId,
      },
    };
  }
}
