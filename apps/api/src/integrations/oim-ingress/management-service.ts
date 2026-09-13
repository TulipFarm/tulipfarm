import type { OimManifest } from "@tulipfarm/schema";
import type {
  PersistedWebhookRegistration,
  WebhookRegistrationKey,
  WebhookRegistrationTarget,
} from "@tulipfarm/storage";
import type { ConnectionActor, OimConnectionService } from "../connections/service";
import { OimConnectionRequestError } from "../connections/service";
import type {
  OimWebhookManagementActor,
  OimWebhookManagementService,
  OimWebhookRegistrationView,
} from "./management-routes";
import { OimWebhookManagementRequestError } from "./management-routes";

export interface OimWebhookLifecyclePort {
  register(
    key: WebhookRegistrationKey,
    target: WebhookRegistrationTarget
  ): Promise<PersistedWebhookRegistration>;
  remove(key: WebhookRegistrationKey): Promise<PersistedWebhookRegistration | null>;
}

export interface OimWebhookManagementServiceDeps {
  readonly businessId: string;
  readonly publicApiUrl: string;
  readonly connections: Pick<OimConnectionService, "get">;
  readonly packageFor: (
    integrationKey: string
  ) => Promise<{ readonly manifest: OimManifest } | null>;
  readonly plan: (input: {
    readonly businessId: string;
    readonly integrationKey: string;
    readonly connectionId: string;
    readonly manifest: OimManifest;
    readonly publicApiUrl: string;
  }) => { readonly key: WebhookRegistrationKey; readonly target: WebhookRegistrationTarget };
  readonly lifecycle: OimWebhookLifecyclePort;
}

function view(registration: PersistedWebhookRegistration): OimWebhookRegistrationView {
  return {
    connectionId: registration.connectionId,
    integrationId: registration.integrationId,
    integrationMajorVersion: registration.integrationMajorVersion,
    state: registration.state,
    desiredState: registration.desiredState,
    callbackUrl: registration.target.callbackUrl,
    lastError: registration.lastError,
  };
}

export class DefaultOimWebhookManagementService implements OimWebhookManagementService {
  constructor(private readonly deps: OimWebhookManagementServiceDeps) {}

  async register(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView> {
    const planned = await this.plan(integrationKey, connectionId, actor);
    try {
      return view(await this.deps.lifecycle.register(planned.key, planned.target));
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async remove(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView | null> {
    const planned = await this.plan(integrationKey, connectionId, actor);
    let removed: PersistedWebhookRegistration | null;
    try {
      removed = await this.deps.lifecycle.remove(planned.key);
    } catch (error) {
      throw lifecycleError(error);
    }
    return removed === null ? null : view(removed);
  }

  async reconcile(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView> {
    return this.register(integrationKey, connectionId, actor);
  }

  private async plan(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ) {
    const connectionActor: ConnectionActor = actor;
    const [connection, pkg] = await Promise.all([
      this.deps.connections.get(integrationKey, connectionId, connectionActor),
      this.deps.packageFor(integrationKey),
    ]);
    if (
      pkg === null ||
      connection.businessId !== this.deps.businessId ||
      connection.integration.id !== pkg.manifest.metadata.id ||
      connection.integration.majorVersion !== Number(pkg.manifest.metadata.version.split(".", 1)[0])
    ) {
      throw new OimConnectionRequestError(404, "connection_not_found");
    }
    return this.deps.plan({
      businessId: this.deps.businessId,
      integrationKey,
      connectionId,
      manifest: pkg.manifest,
      publicApiUrl: this.deps.publicApiUrl,
    });
  }
}

function lifecycleError(error: unknown): OimWebhookManagementRequestError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "registration_failed";
  if (code === "manifest_unavailable") {
    return new OimWebhookManagementRequestError(404, code);
  }
  if (code === "manifest_changed" || code === "registration_stale") {
    return new OimWebhookManagementRequestError(409, code);
  }
  return new OimWebhookManagementRequestError(502, code);
}
