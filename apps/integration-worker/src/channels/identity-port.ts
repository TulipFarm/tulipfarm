import type { ChannelIdentityPort } from "@tulipfarm/integrations";
import type { InternalApiClient } from "../internal/client";

interface ResolveResponse {
  linked: boolean;
  principal?: { kind: string; id: string };
}

/**
 * Calls `POST /api/v1/internal/channels/identity/resolve` — identity mapping lives in `apps/api`,
 * which this app may not import. An unmapped sender resolves to `undefined`, never a substitute.
 */
export function httpChannelIdentityPort(client: InternalApiClient): ChannelIdentityPort {
  return {
    async resolve(input) {
      const response = await client.require<ResolveResponse>(
        "POST",
        "/api/v1/internal/channels/identity/resolve",
        { provider: input.provider, externalSubject: input.externalSubject }
      );
      if (!response.linked || response.principal === undefined) return undefined;
      const kind = response.principal.kind;
      if (kind !== "user") return undefined;
      return { kind, id: response.principal.id };
    },
  };
}

export interface ChannelIdentityBindOfferPort {
  offer(input: {
    provider: string;
    externalSubject: string;
    channelId: string;
    threadId?: string;
  }): Promise<void>;
}

interface BindOfferResponse {
  outcome: "sent" | "no_offer" | "unconfigured";
}

/** Bind tokens are bearer credentials; only `apps/api` resolves and posts bind offers. */
export function httpChannelIdentityBindOfferPort(
  client: InternalApiClient,
  log: { warn: (message: string, error?: unknown) => void }
): ChannelIdentityBindOfferPort {
  return {
    async offer(input) {
      try {
        await client.require<BindOfferResponse>(
          "POST",
          "/api/v1/internal/channels/identity/bind-offer",
          input
        );
      } catch (error) {
        log.warn("slack bind-offer request failed", error);
      }
    },
  };
}
