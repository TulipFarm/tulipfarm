import { createHash } from "node:crypto";
import type { OimEventType, OimManifest, OimPollingIngress } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
import { bodyDigest, selectEventType } from "./delivery";
import { advancePollingCursor, pollingCursorRequestValue } from "./polling";
import type { VerifiedProviderIdentity } from "./receiver";

export interface PollingIngressKey {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export interface ResolvedPollingIngress extends PollingIngressKey {
  readonly manifest: OimManifest;
  readonly ingress: OimPollingIngress;
  readonly eventTypes: readonly OimEventType[];
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface PollingIngressStatePort {
  claim(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<{ readonly cursor: string | null } | null>;
  complete(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    cursor: string | null,
    intervalSeconds: number,
    now?: Date
  ): Promise<boolean>;
  release(
    businessId: string,
    connectionId: string,
    leaseToken: string,
    retryAfterSeconds: number,
    now?: Date
  ): Promise<boolean>;
}

export interface PollingProviderResponse {
  readonly response: unknown;
  /** Digest of authenticated provider response evidence, not an unsigned response identifier. */
  readonly authenticatedEvidenceDigest: string;
  /** Identity proven by the authenticated provider response or a trusted provider lookup. */
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export interface PollOimIngressDeps {
  readonly candidates: () => Promise<readonly PollingIngressKey[]>;
  readonly resolveSource: (key: PollingIngressKey) => Promise<ResolvedPollingIngress | null>;
  readonly execute: (input: {
    readonly source: ResolvedPollingIngress;
    readonly cursor: string | number | null;
    readonly leaseToken: string;
  }) => Promise<PollingProviderResponse>;
  readonly reauthorizeSource: (source: ResolvedPollingIngress) => Promise<boolean>;
  readonly state: PollingIngressStatePort;
  readonly recordVerifiedIfActive: (
    businessId: string,
    input: VerifiedWebhookDeliveryInput
  ) => Promise<RecordedDelivery>;
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly newDeliveryId: () => string;
  readonly newLeaseToken: () => string;
  readonly now?: () => Date;
  readonly leaseSeconds?: number;
  readonly retryAfterSeconds?: number;
}

export interface PollOimIngressSummary {
  readonly candidates: number;
  readonly claimed: number;
  readonly recorded: number;
  readonly duplicates: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly key: PollingIngressKey;
    readonly code:
      | "source_unavailable"
      | "source_identity_mismatch"
      | "provider_identity_unverified"
      | "source_revoked"
      | "lease_lost"
      | "polling_failed";
  }[];
}

function sameIdentity(a: VerifiedProviderIdentity, b: VerifiedProviderIdentity): boolean {
  return a.externalTenantId === b.externalTenantId && a.externalAccountId === b.externalAccountId;
}

function itemEvidenceDigest(
  responseEvidenceDigest: string,
  deduplicationKey: string,
  payloadDigest: string
): string {
  return createHash("sha256")
    .update("tulipfarm-oim-polling-item-v1\0")
    .update(responseEvidenceDigest)
    .update("\0")
    .update(deduplicationKey)
    .update("\0")
    .update(payloadDigest)
    .digest("hex");
}

export async function pollOimIngress(deps: PollOimIngressDeps): Promise<PollOimIngressSummary> {
  const candidates = await deps.candidates();
  const now = deps.now?.() ?? new Date();
  let claimed = 0;
  let recorded = 0;
  let duplicates = 0;
  let failed = 0;
  const failures: Array<PollOimIngressSummary["failures"][number]> = [];

  for (const key of candidates) {
    const leaseToken = deps.newLeaseToken();
    const lease = await deps.state.claim(
      key.businessId,
      key.connectionId,
      leaseToken,
      deps.leaseSeconds ?? 120,
      now
    );
    if (lease === null) continue;
    claimed += 1;
    try {
      const source = await deps.resolveSource(key);
      if (source === null) throw new Error("source_unavailable");
      if (
        source.businessId !== key.businessId ||
        source.connectionId !== key.connectionId ||
        source.integrationId !== key.integrationId ||
        source.integrationMajorVersion !== key.integrationMajorVersion ||
        source.manifest.metadata.id !== key.integrationId ||
        Number(source.manifest.metadata.version.split(".", 1)[0]) !== key.integrationMajorVersion
      ) {
        throw new Error("source_identity_mismatch");
      }
      const response = await deps.execute({
        source,
        cursor: pollingCursorRequestValue(lease.cursor, source.ingress.cursor),
        leaseToken,
      });
      if (
        !/^[0-9a-f]{64}$/.test(response.authenticatedEvidenceDigest) ||
        !sameIdentity(response.verifiedIdentity, source.verifiedIdentity)
      ) {
        throw new Error("provider_identity_unverified");
      }
      if (!(await deps.reauthorizeSource(source))) {
        throw new Error("source_revoked");
      }

      const advanced = advancePollingCursor(response.response, lease.cursor, source.ingress.cursor);
      for (const item of advanced.deliveries) {
        const eventType = selectEventType(
          { eventTypes: source.eventTypes },
          { body: item.payload, headers: {} }
        );
        if (eventType === undefined) continue;
        const raw = Buffer.from(JSON.stringify(item.payload), "utf8");
        const digest = bodyDigest(raw);
        const result = await deps.recordVerifiedIfActive(key.businessId, {
          id: deps.newDeliveryId(),
          integrationId: key.integrationId,
          integrationMajorVersion: key.integrationMajorVersion,
          connectionId: key.connectionId,
          externalTenantId: source.verifiedIdentity.externalTenantId,
          externalAccountId: source.verifiedIdentity.externalAccountId,
          deduplicationKey: item.deduplicationKey,
          bodySha256: digest,
          safeHeaders: {},
          encryptedBody: await deps.encryptPayload(raw),
          eventType: eventType.type,
          verification: "verified_polling",
          authenticatedEvidenceDigest: itemEvidenceDigest(
            response.authenticatedEvidenceDigest,
            item.deduplicationKey,
            digest
          ),
        });
        if (result.accepted) recorded += 1;
        else duplicates += 1;
      }
      if (
        !(await deps.state.complete(
          key.businessId,
          key.connectionId,
          leaseToken,
          advanced.cursor,
          source.ingress.intervalSeconds,
          now
        ))
      ) {
        throw new Error("lease_lost");
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "";
      const known = new Set([
        "source_unavailable",
        "source_identity_mismatch",
        "provider_identity_unverified",
        "source_revoked",
        "lease_lost",
      ]);
      failures.push({
        key,
        code: known.has(message)
          ? (message as PollOimIngressSummary["failures"][number]["code"])
          : "polling_failed",
      });
      await deps.state.release(
        key.businessId,
        key.connectionId,
        leaseToken,
        deps.retryAfterSeconds ?? 60,
        now
      );
    }
  }
  return { candidates: candidates.length, claimed, recorded, duplicates, failed, failures };
}
