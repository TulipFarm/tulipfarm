import {
  compileTriggerFilter,
  type RegisteredTrigger,
  type ResolvedRoutineInvocation,
  type RoutineInvocationResolver,
  routineStateDefinitionRef,
  type TriggerKind,
  type WebhookTrigger,
  type WebhookVerificationMethod,
} from "@tulipfarm/run-kernel";
import { definitions } from "@tulipfarm/schema";
import type { BundleDefinition, BundleVerifier, SoulPublicationCoordinator } from "@tulipfarm/soul";
import { bundleTriggerDefinitions, findBundleTrigger } from "@tulipfarm/soul";

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

/** undefined: no mapping authored. null: malformed mapping; callers must fail closed. */
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
 * Resolve Routines only from verified active Soul bundles; drafts and live checkout do not mint
 * Runs.
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
 * Trigger types bound to an event by matching rather than by name. `webhook` is excluded on
 * purpose: its route already knows the exact slug from the URL, so matching could only make a
 * precise binding ambiguous.
 */
const EVENT_TRIGGER_TYPES: readonly string[] = ["integration_event", "internal_event", "form"];

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Decode one bundle definition into the matcher's view, or `null` when any authored field is
 * malformed. Fails closed: a Trigger that cannot be decoded exactly must never bind an event.
 */
function toRegisteredTrigger(slug: string, definition: BundleDefinition): RegisteredTrigger | null {
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
  if (typeof eventType !== "string" || eventType.length === 0 || typeof eventVersion !== "number") {
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

  // `integration_event` and `internal_event` declare the event they *listen for* separately from
  // the event they represent, because the envelope arrives already typed by its source.
  const matchEventType = optionalNonEmptyString(spec.matchEventType);
  const matchEventVersion =
    typeof spec.matchEventVersion === "number" ? spec.matchEventVersion : undefined;

  const filter = optionalNonEmptyString(spec.filter);
  if (filter !== undefined) {
    try {
      compileTriggerFilter(filter);
    } catch {
      return null;
    }
  }

  return {
    triggerSlug: slug,
    authoredVersion: definition.authoredVersion,
    lifecycle: "published",
    type: type as TriggerKind,
    eventType: matchEventType ?? eventType,
    eventVersion: matchEventVersion ?? eventVersion,
    routineRef: { name: routineRef.name, version: routineRef.version },
    backgroundIdentity: {
      principalKind: backgroundIdentity.principalKind,
      principalId: backgroundIdentity.principalId,
    },
    ...(inputMappings === undefined ? {} : { inputMappings }),
    ...(optionalNonEmptyString(spec.provider) === undefined
      ? {}
      : { provider: spec.provider as string }),
    ...(optionalNonEmptyString(spec.formRef) === undefined
      ? {}
      : { formRef: spec.formRef as string }),
    ...(filter === undefined ? {} : { filter }),
  };
}

/**
 * Resolve Triggers only from verified active bundles; manual/internal_api envelopes stay
 * unverified.
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
    const definition = findBundleTrigger(bundle, slug);
    if (!bundle || !definition) return null;

    return toRegisteredTrigger(slug, definition);
  }

  /** Every published Trigger that binds an event by matching. Never throws; an unreadable
   * publication yields none, so a bad bundle cannot mint Runs. */
  async listEventTriggers(): Promise<readonly RegisteredTrigger[]> {
    const bundle = await this.publications.activeBundle(this.businessId, this.verifier);
    if (!bundle) return [];

    const registered: RegisteredTrigger[] = [];
    for (const definition of bundleTriggerDefinitions(bundle)) {
      const trigger = toRegisteredTrigger(definition.slug, definition);
      if (trigger !== null && EVENT_TRIGGER_TYPES.includes(trigger.type)) registered.push(trigger);
    }
    return registered;
  }
}

/**
 * Resolve webhook Triggers only from verified active bundles; authored dot-path filters are
 * incompatible.
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
    const definition = findBundleTrigger(bundle, triggerSlug);
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
