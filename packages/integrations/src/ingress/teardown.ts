import type { PersistedWebhookRegistration, WebhookRegistrationKey } from "@tulipfarm/storage";

export interface IngressTeardownFencePort {
  disable(key: WebhookRegistrationKey, now?: Date): Promise<boolean>;
}

export interface PollingTeardownPort {
  remove(businessId: string, connectionId: string): Promise<boolean>;
}

export interface WebhookTeardownPort {
  remove(key: WebhookRegistrationKey): Promise<PersistedWebhookRegistration | null>;
}

export interface IngressTeardownResult {
  readonly ingressDisabled: true;
  readonly pollingStateRemoved: boolean;
  readonly webhook: PersistedWebhookRegistration | null;
  readonly remoteCleanupComplete: boolean;
}

export class OimIngressTeardownService {
  constructor(
    private readonly fence: IngressTeardownFencePort,
    private readonly polling: PollingTeardownPort,
    private readonly webhooks: WebhookTeardownPort
  ) {}

  async remove(key: WebhookRegistrationKey, now = new Date()): Promise<IngressTeardownResult> {
    const disabled = await this.fence.disable(key, now);
    if (!disabled) throw new Error("ingress_connection_unavailable");
    const pollingStateRemoved = await this.polling.remove(key.businessId, key.connectionId);
    const webhook = await this.webhooks.remove(key);
    return {
      ingressDisabled: true,
      pollingStateRemoved,
      webhook,
      remoteCleanupComplete: webhook === null || webhook.state === "removed",
    };
  }
}
