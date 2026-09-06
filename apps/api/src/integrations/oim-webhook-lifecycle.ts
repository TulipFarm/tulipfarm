import { randomBytes } from "node:crypto";
import {
  compileOimHttpOperations,
  type EgressHttpPort,
  OimHttpToolAdapter,
} from "@tulipfarm/integrations";
import type { OimConnection, OimManifest } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";

type WebhookStep = Extract<NonNullable<OimManifest["auth"]>["steps"][number], { type: "webhook" }>;

export class OimWebhookLifecycleError extends Error {
  constructor(readonly code: "registration_failed" | "unregistration_failed") {
    super(code);
  }
}

function oimIngressUrl(apiUrl: string, slug: string, connection: PersistedConnection): string {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/v1/hooks/oim/${slug}`;
  return connection.owner.scope === "team"
    ? `${url}?connectionId=${encodeURIComponent(connection.id)}`
    : url;
}

function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function withPointer(body: Record<string, unknown>, pointer: string, value: string): void {
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/"));
  let current = body;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
}

function bindValue(
  arguments_: Record<string, unknown>,
  binding: WebhookStep["registration"]["callbackUrl"],
  value: string
): void {
  if (binding.in === "parameter") {
    arguments_[binding.name] = value;
    return;
  }
  const body = arguments_.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) arguments_.body = {};
  withPointer(arguments_.body as Record<string, unknown>, binding.pointer, value);
}

function webhookStep(manifest: OimManifest, operationId: string): WebhookStep | undefined {
  return (manifest.auth?.steps ?? []).find(
    (step): step is WebhookStep => step.type === "webhook" && step.operationId === operationId
  );
}

export class OimWebhookLifecycle {
  constructor(
    private readonly deps: {
      readonly connections: ConnectionStore;
      readonly secrets: SecretsService;
      readonly http: EgressHttpPort;
      readonly manifestFor: (
        integrationId: string
      ) => { readonly slug: string; readonly manifest: OimManifest } | undefined;
    }
  ) {}

  async register(
    manifest: OimManifest,
    connection: PersistedConnection,
    apiUrl: string,
    slug = manifest.metadata.id
  ): Promise<void> {
    const step =
      webhookStep(manifest, connection.webhookRegistration?.operationId ?? "") ??
      (manifest.auth?.steps ?? []).find(
        (candidate): candidate is WebhookStep => candidate.type === "webhook"
      );
    if (step === undefined) return;

    const ingressUrl = oimIngressUrl(apiUrl, slug, connection);
    if (connection.webhookRegistration?.ingressUrl === ingressUrl) return;
    const previous = connection.webhookRegistration;
    const initialSecretRef = connection.secretBindings[step.secretSlot];
    const secretKey =
      previous === undefined && initialSecretRef !== undefined
        ? initialSecretRef.replace(/^secret:\/\//, "")
        : `oim-delivery-${manifest.metadata.id}-${randomBytes(20).toString("hex")}`;
    const secret =
      previous === undefined && initialSecretRef !== undefined
        ? await this.deps.secrets.get(secretKey)
        : randomBytes(32).toString("base64url");
    if (previous !== undefined || initialSecretRef === undefined) {
      await this.deps.secrets.set(secretKey, secret);
    }

    try {
      const result = await this.dispatch(manifest, connection, step.operationId, {
        callbackUrl: step.registration.callbackUrl,
        ...(step.registration.secret === undefined ? {} : { secret: step.registration.secret }),
        values: { callbackUrl: ingressUrl, secret },
      });
      const subscriptionId = pointerValue(result, step.subscriptionIdPath);
      if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
        throw new OimWebhookLifecycleError("registration_failed");
      }

      const secretBindings = {
        ...connection.secretBindings,
        [step.secretSlot]: `secret://${secretKey}`,
      };
      const replacement: OimConnection = {
        ...connection,
        secretBindings,
        webhookRegistration: {
          ingressUrl,
          subscriptionId,
          operationId: step.operationId,
          unregisterOperationId: step.unregisterOperationId,
          secretSlot: step.secretSlot,
        },
        health: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      await this.deps.connections.put(connection.businessId, replacement);

      if (previous !== undefined) {
        try {
          await this.unregister(manifest, {
            ...connection,
            secretBindings: connection.secretBindings,
          });
          const oldKey = connection.secretBindings[previous.secretSlot]?.replace(
            /^secret:\/\//,
            ""
          );
          if (oldKey !== undefined) await this.deps.secrets.delete(oldKey);
        } catch {
          await this.deps.connections.updateHealth(
            connection.businessId,
            connection.id,
            { status: "action_required", checkedAt: new Date().toISOString() },
            connection.expiresAt
          );
        }
      }
    } catch (error) {
      if (previous !== undefined || initialSecretRef === undefined) {
        await this.deps.secrets.delete(secretKey);
      }
      await this.deps.connections.updateHealth(
        connection.businessId,
        connection.id,
        { status: "action_required", checkedAt: new Date().toISOString() },
        connection.expiresAt
      );
      if (error instanceof OimWebhookLifecycleError) throw error;
      throw new OimWebhookLifecycleError("registration_failed");
    }
  }

  async revoke(manifest: OimManifest, connection: PersistedConnection): Promise<void> {
    if (connection.webhookRegistration === undefined) return;
    try {
      await this.unregister(manifest, connection);
    } catch {
      await this.deps.connections.updateHealth(
        connection.businessId,
        connection.id,
        { status: "action_required", checkedAt: new Date().toISOString() },
        connection.expiresAt
      );
      throw new OimWebhookLifecycleError("unregistration_failed");
    }
  }

  async reconcile(apiUrl: string): Promise<void> {
    for (const connection of await this.deps.connections.listActiveWebhookRegistrations()) {
      const installed = this.deps.manifestFor(connection.integration.id);
      if (installed === undefined) continue;
      try {
        await this.register(installed.manifest, connection, apiUrl, installed.slug);
      } catch {
        // The Connection is already marked action-required. A public-origin update remains valid
        // even if one provider is temporarily unavailable.
      }
    }
  }

  private async unregister(manifest: OimManifest, connection: PersistedConnection): Promise<void> {
    const registration = connection.webhookRegistration;
    if (registration === undefined) return;
    const step = webhookStep(manifest, registration.operationId);
    if (step === undefined || step.unregisterOperationId !== registration.unregisterOperationId) {
      throw new OimWebhookLifecycleError("unregistration_failed");
    }
    await this.dispatch(manifest, connection, step.unregisterOperationId, {
      callbackUrl: step.unregistration.subscriptionId,
      values: { callbackUrl: registration.subscriptionId },
    });
  }

  private async dispatch(
    manifest: OimManifest,
    connection: PersistedConnection,
    operationId: string,
    binding: {
      readonly callbackUrl: WebhookStep["registration"]["callbackUrl"];
      readonly secret?: WebhookStep["registration"]["secret"];
      readonly values: { readonly callbackUrl: string; readonly secret?: string };
    }
  ): Promise<unknown> {
    const configuration = Object.fromEntries(
      Object.entries(connection.configuration).map(([key, value]) => [key, String(value)])
    );
    const compiled = compileOimHttpOperations(manifest, configuration).find(
      (candidate) => candidate.operation.id === operationId
    );
    if (compiled === undefined) throw new OimWebhookLifecycleError("registration_failed");

    const credentials: Record<string, string> = {};
    for (const slot of [
      compiled.operation.credentialSlot,
      compiled.operation.secondaryCredential?.slot,
    ]) {
      if (slot === undefined) continue;
      const reference = connection.secretBindings[slot];
      if (reference === undefined) throw new OimWebhookLifecycleError("registration_failed");
      credentials[slot] = await this.deps.secrets.get(reference.replace(/^secret:\/\//, ""));
    }
    const arguments_: Record<string, unknown> = {};
    bindValue(arguments_, binding.callbackUrl, binding.values.callbackUrl);
    if (binding.secret !== undefined && binding.values.secret !== undefined) {
      bindValue(arguments_, binding.secret, binding.values.secret);
    }
    return new OimHttpToolAdapter({
      binding: compiled.binding,
      http: this.deps.http,
      toolId: compiled.toolId,
      ...(compiled.projection === undefined ? {} : { projection: compiled.projection }),
    }).dispatch(
      {
        intent: {
          intentId: `webhook-${connection.id}-${operationId}`,
          businessId: connection.businessId,
          runId: `webhook-${connection.id}`,
          stateId: `webhook-${connection.id}`,
          toolId: compiled.toolId,
          toolVersion: manifest.metadata.version,
          action: `integration.${manifest.metadata.id}.${compiled.operation.name}`,
          targetRefs: [],
          arguments: arguments_,
          idempotencyKey: `webhook-${connection.id}-${operationId}`,
        },
        idempotencyKey: `webhook-${connection.id}-${operationId}`,
        attempt: 1,
      },
      compiled.operation.credentialSlot === undefined
        ? undefined
        : credentials[compiled.operation.credentialSlot],
      credentials
    );
  }
}
