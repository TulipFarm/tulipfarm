/**
 * What an administrator is shown before approving an Integration package.
 *
 * The review answers one question — *what authority does installing this grant?* — from the
 * manifest alone, so it stays true of the exact bytes being approved rather than of whatever the
 * source repository holds later. Nothing here fetches, connects or executes.
 *
 * Everything reported is derived, never authored: a manifest cannot supply its own summary, so a
 * package cannot describe itself as harmless while declaring otherwise.
 */

import type { OIM_EFFECT_CLASSES, OIM_IDENTITY_MODES, OimManifest } from "@tulipfarm/schema";
import { oimPackageDigest } from "@tulipfarm/schema";

type OimEffectClass = (typeof OIM_EFFECT_CLASSES)[number];
type OimIdentityMode = (typeof OIM_IDENTITY_MODES)[number];

export interface OimOperationReview {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly effect: OimEffectClass;
  /** True when this operation changes something at the provider. */
  readonly mutating: boolean;
  readonly identityMode: OimIdentityMode;
  readonly credentialSlot?: string;
  readonly destination?: string;
}

export interface OimCapabilityReview {
  readonly integrationId: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly maintainers: readonly string[];
  /** The exact bytes being approved. A later change to the source produces a different value. */
  readonly packageDigest: string;
  /** Every host this package may reach, deduplicated and sorted. */
  readonly destinations: readonly string[];
  /**
   * Hosts the installation may point a templated destination at. Non-empty means the destinations
   * above are not the whole story, so a reviewer must be shown the bound rather than only the
   * placeholder.
   */
  readonly allowedOriginHosts: readonly string[];
  readonly credentialSlots: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly required: boolean;
  }[];
  /** Configuration an installation supplies; `agentVisible` fields are readable by Agents. */
  readonly configurationFields: readonly {
    readonly id: string;
    readonly label: string;
    readonly type: string;
    readonly agentVisible: boolean;
  }[];
  readonly identityModes: readonly OimIdentityMode[];
  readonly operations: readonly OimOperationReview[];
  readonly effects: readonly OimEffectClass[];
  /** Present when the package accepts provider-initiated deliveries. */
  readonly ingress?: {
    readonly path: string;
    readonly verification: string;
    readonly eventTypes: readonly string[];
    readonly rawRetentionDays?: number;
  };
  readonly knowledge?: {
    readonly sourceKinds: readonly string[];
    readonly propagatesDeletions: boolean;
    readonly liveAuthorization: boolean;
  };
  /** Files the package carries, so a reviewer sees a hook before approving one. */
  readonly files: readonly { readonly path: string; readonly role: string }[];
  /** True when the package declares JavaScript that would run inside TulipFarm. */
  readonly declaresHooks: boolean;
}

const MUTATING_EFFECTS = new Set<OimEffectClass>(["create", "update", "delete", "send", "admin"]);

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function destinationOf(operation: OimManifest["operations"][number]): string | undefined {
  const { source } = operation;
  const raw =
    "baseUrl" in source && typeof source.baseUrl === "string" ? source.baseUrl : undefined;
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    // A base URL that will not parse is reported verbatim rather than dropped: hiding a
    // destination from the reviewer is worse than showing an odd-looking string.
    return raw;
  }
}

export function describeOimCapabilities(manifest: OimManifest): OimCapabilityReview {
  const operations: OimOperationReview[] = manifest.operations.map((operation) => {
    const destination = destinationOf(operation);
    return {
      id: operation.id,
      name: operation.name,
      description: operation.description,
      effect: operation.effect,
      mutating: MUTATING_EFFECTS.has(operation.effect),
      identityMode: operation.identityMode,
      ...(operation.credentialSlot === undefined
        ? {}
        : { credentialSlot: operation.credentialSlot }),
      ...(destination === undefined ? {} : { destination }),
    };
  });

  const files = manifest.files ?? [];
  const hookFiles = new Set((manifest.hooks ?? []).map((hook) => hook.file));

  return {
    integrationId: manifest.metadata.id,
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    license: manifest.metadata.license,
    maintainers: (manifest.metadata.maintainers ?? []).map((maintainer) => maintainer.name),
    packageDigest: oimPackageDigest(manifest),
    allowedOriginHosts: sortedUnique(manifest.auth?.allowedOriginHosts ?? []),
    destinations: sortedUnique(
      operations.flatMap((operation) =>
        operation.destination === undefined ? [] : [operation.destination]
      )
    ),
    credentialSlots: (manifest.auth?.credentialSlots ?? []).map((slot) => ({
      id: slot.id,
      label: slot.label,
      kind: slot.kind,
      required: slot.required ?? false,
    })),
    configurationFields: (manifest.auth?.configurationFields ?? []).map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      agentVisible: field.agentVisible ?? false,
    })),
    identityModes: sortedUnique(
      operations.map((operation) => operation.identityMode)
    ) as OimIdentityMode[],
    operations,
    effects: sortedUnique(operations.map((operation) => operation.effect)) as OimEffectClass[],
    ...(manifest.events === undefined
      ? {}
      : {
          ingress: {
            path: manifest.events.path,
            verification: manifest.events.verification.scheme,
            eventTypes: manifest.events.eventTypes.map((eventType) => eventType.type),
            ...(manifest.events.rawRetentionDays === undefined
              ? {}
              : { rawRetentionDays: manifest.events.rawRetentionDays }),
          },
        }),
    ...(manifest.knowledge === undefined
      ? {}
      : {
          knowledge: {
            sourceKinds: manifest.knowledge.sourceKinds.map((kind) => kind.id),
            propagatesDeletions: manifest.knowledge.deletion.kind !== "none",
            liveAuthorization: manifest.knowledge.liveAuthorization !== undefined,
          },
        }),
    files: files.map((file) => ({ path: file.path, role: file.role })),
    // Both signals, because either alone can be wrong: a `hook` file nothing references still
    // ships JavaScript, and a declared hook naming an undeclared file is a package that will not
    // load. A reviewer must be warned in both cases.
    declaresHooks:
      files.some((file) => file.role === "hook") ||
      files.some((file) => hookFiles.has(file.path)) ||
      hookFiles.size > 0,
  };
}
