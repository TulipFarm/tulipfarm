import { canonicalHash, type OimManifest } from "@tulipfarm/schema";
import type {
  PersistedConnection,
  PersistedWebhookRegistration,
  VerifiedConnectionExternalIdentity,
  WebhookRegistrationKey,
} from "@tulipfarm/storage";
import { oimManifestMajor } from "../connections/catalog";
import type { OimIngressRoute, WebhookIngressBinding } from "./receiver";

export interface WebhookIngressBindingDeps {
  readonly businessId: string;
  readonly packageFor: (
    integrationKey: string
  ) => Promise<{ readonly manifest: OimManifest } | null>;
  readonly connections: {
    findById(businessId: string, connectionId: string): Promise<PersistedConnection | null>;
  };
  readonly registrations: {
    findActive(
      key: WebhookRegistrationKey,
      integrationKey?: string
    ): Promise<PersistedWebhookRegistration | null>;
  };
  readonly identities: {
    find(
      businessId: string,
      connectionId: string
    ): Promise<VerifiedConnectionExternalIdentity | null>;
  };
  readonly now?: () => Date;
}

export async function resolveWebhookIngressBinding(
  route: OimIngressRoute,
  deps: WebhookIngressBindingDeps
): Promise<WebhookIngressBinding | null> {
  const pkg = await deps.packageFor(route.integrationKey);
  const manifest = pkg?.manifest;
  if (manifest?.events === undefined) return null;
  const majorVersion = oimManifestMajor(manifest);
  const key = {
    businessId: deps.businessId,
    connectionId: route.connectionId,
    integrationId: manifest.metadata.id,
    integrationMajorVersion: majorVersion,
  };
  const [connection, registration, identity] = await Promise.all([
    deps.connections.findById(deps.businessId, route.connectionId),
    deps.registrations.findActive(key, route.integrationKey),
    deps.identities.find(deps.businessId, route.connectionId),
  ]);
  const now = deps.now?.() ?? new Date();
  if (
    connection === null ||
    registration === null ||
    registration.active === null ||
    registration.desiredState !== "active" ||
    registration.state !== "active" ||
    identity === null ||
    connection.businessId !== deps.businessId ||
    connection.id !== route.connectionId ||
    connection.integration.id !== manifest.metadata.id ||
    connection.integration.majorVersion !== majorVersion ||
    connection.status !== "active" ||
    !["healthy", "expiring"].includes(connection.health.status) ||
    (connection.expiresAt !== null && new Date(connection.expiresAt) <= now) ||
    identity.integrationId !== manifest.metadata.id ||
    identity.integrationMajorVersion !== majorVersion ||
    registration.businessId !== deps.businessId ||
    registration.connectionId !== route.connectionId ||
    registration.integrationId !== manifest.metadata.id ||
    registration.integrationMajorVersion !== majorVersion ||
    registration.target.manifestDigest !== canonicalHash(manifest) ||
    registration.active.manifestDigest !== canonicalHash(manifest) ||
    registration.active.integrationKey !== route.integrationKey ||
    registration.active.callbackUrl !== registration.target.callbackUrl ||
    registration.active.secretSlot !== manifest.events.verification.secretSlot ||
    connection.secretBindings[registration.active.secretSlot] !== registration.active.secretRef
  ) {
    return null;
  }
  return {
    businessId: deps.businessId,
    integrationKey: route.integrationKey,
    integrationId: manifest.metadata.id,
    integrationMajorVersion: majorVersion,
    connectionId: route.connectionId,
    manifest,
    callbackUrl: registration.active.callbackUrl,
    registrationRevision: registration.revision,
    manifestDigest: registration.active.manifestDigest,
    configurationDigest: canonicalHash(connection.configuration),
    secretSlot: registration.active.secretSlot,
    secretRef: registration.active.secretRef,
    verifiedIdentity: {
      externalTenantId: identity.externalTenantId,
      externalAccountId: identity.externalAccountId,
    },
  };
}

export async function reauthorizeWebhookIngressBinding(
  binding: WebhookIngressBinding,
  deps: WebhookIngressBindingDeps
): Promise<boolean> {
  const current = await resolveWebhookIngressBinding(
    {
      integrationKey: binding.integrationKey,
      connectionId: binding.connectionId,
    },
    deps
  );
  return (
    current !== null &&
    current.businessId === binding.businessId &&
    current.integrationId === binding.integrationId &&
    current.integrationMajorVersion === binding.integrationMajorVersion &&
    current.registrationRevision === binding.registrationRevision &&
    current.manifestDigest === binding.manifestDigest &&
    current.configurationDigest === binding.configurationDigest &&
    current.secretSlot === binding.secretSlot &&
    current.secretRef === binding.secretRef &&
    current.callbackUrl === binding.callbackUrl &&
    current.verifiedIdentity.externalTenantId === binding.verifiedIdentity.externalTenantId &&
    current.verifiedIdentity.externalAccountId === binding.verifiedIdentity.externalAccountId
  );
}
