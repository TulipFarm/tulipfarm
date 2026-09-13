import { type EgressHttpPort, sendGovernedRequest } from "@tulipfarm/integrations";
import type { OimReleaseTrustStore } from "@tulipfarm/storage";

const MAX_FEED_BYTES = 1024 * 1024;

export interface OimReleaseMaintenanceServiceDeps {
  readonly http: EgressHttpPort;
  readonly store: Pick<OimReleaseTrustStore, "getRevocationFeed">;
  readonly run: (
    feed: unknown,
    businessId: string
  ) => Promise<{
    readonly revocations: "unchanged" | "updated";
    readonly patches: readonly unknown[];
  }>;
}

function parseFeedBody(body: unknown): unknown {
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_FEED_BYTES) throw new Error("oim_release_feed_too_large");
    return JSON.parse(body);
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_FEED_BYTES) throw new Error("oim_release_feed_too_large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  }
  const encoded = JSON.stringify(body);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_FEED_BYTES) {
    throw new Error("oim_release_feed_too_large");
  }
  return body;
}

export function createOimReleaseMaintenanceService(deps: OimReleaseMaintenanceServiceDeps) {
  return Object.freeze({
    async runOnce(businessId: string) {
      const configured = await deps.store.getRevocationFeed();
      if (configured === null) {
        return { feed: "disabled" as const, patches: [] };
      }
      const boundedHttp: EgressHttpPort = {
        send(request) {
          return deps.http.send({ ...request, maxResponseBytes: MAX_FEED_BYTES });
        },
      };
      const fetched = await sendGovernedRequest(
        boundedHttp,
        {
          method: "GET",
          url: configured.url,
        },
        3
      );
      if (fetched.kind === "cross_origin_redirect") {
        throw new Error("oim_release_feed_cross_origin_redirect");
      }
      if (fetched.kind === "redirect_limit") {
        throw new Error("oim_release_feed_redirect_limit");
      }
      if (fetched.response.status < 200 || fetched.response.status >= 300) {
        throw new Error(`oim_release_feed_http_${fetched.response.status}`);
      }
      const cycle = await deps.run(parseFeedBody(fetched.response.body), businessId);
      return { feed: cycle.revocations, patches: cycle.patches };
    },
  });
}
