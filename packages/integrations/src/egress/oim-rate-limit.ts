import { type OimManifest, type OimOperation, oimOriginPlaceholder } from "@tulipfarm/schema";
import type {
  AdmitOimRateLimitInput,
  ImposeOimRateLimitCooldownInput,
  OimRateLimitAdmission,
  OimRateLimitStoreScope,
} from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { OIM_MAX_RETRY_AFTER_MS } from "./oim-rate-limit-header";

export { OIM_MAX_RETRY_AFTER_MS, parseOimRetryAfterMs } from "./oim-rate-limit-header";

export interface OimRateLimitAdmissionPort {
  admit(input: AdmitOimRateLimitInput): Promise<OimRateLimitAdmission>;
  imposeCooldown(input: ImposeOimRateLimitCooldownInput): Promise<void>;
}

export interface OimRateLimitedToolAdapterDeps {
  readonly delegate: ToolAdapter;
  readonly manifest: OimManifest;
  readonly operation: OimOperation;
  readonly limits: OimRateLimitAdmissionPort;
  readonly now?: () => Date;
}

function requiresConnection(operation: OimOperation): boolean {
  if (operation.credentialSlot !== undefined || operation.secondaryCredential !== undefined) {
    return true;
  }
  return (
    (operation.source.type === "http" || operation.source.type === "openapi") &&
    operation.source.baseUrl !== undefined &&
    oimOriginPlaceholder(operation.source.baseUrl) !== undefined
  );
}

/** Derives an exact Connection key, or an operation key for a fixed credential-free endpoint. */
export function oimRateLimitScope(
  manifest: OimManifest,
  operation: OimOperation,
  request: ToolAdapterRequest
): OimRateLimitStoreScope {
  const connection = request.intent.connection;
  const connectionRequired =
    requiresConnection(operation) ||
    request.intent.credentialRef !== undefined ||
    request.intent.secondaryCredentialRef !== undefined;
  if (connection !== undefined && connection.integrationId !== manifest.metadata.id) {
    throw new AdapterDispatchError("before_dispatch", "rate_limit_scope_missing", false);
  }
  const integrationMajorVersion = Number(manifest.metadata.version.split(".", 1)[0]);
  if (!Number.isSafeInteger(integrationMajorVersion) || integrationMajorVersion < 0) {
    throw new AdapterDispatchError("before_dispatch", "rate_limit_scope_invalid", false);
  }
  const base = {
    businessId: request.intent.businessId,
    integrationId: manifest.metadata.id,
    integrationMajorVersion,
  };
  if (!connectionRequired) {
    return { ...base, scope: "operation", operationId: operation.id };
  }
  if (connection === undefined) {
    throw new AdapterDispatchError("before_dispatch", "rate_limit_scope_missing", false);
  }
  const connectionBase = { ...base, connectionId: connection.connectionId };
  return operation.rateLimit?.scope === "operation"
    ? { ...connectionBase, scope: "operation", operationId: operation.id }
    : { ...connectionBase, scope: "connection" };
}

function retryAfterMs(retryAt: string, now: Date): number {
  return Math.max(0, Math.min(Date.parse(retryAt) - now.getTime(), OIM_MAX_RETRY_AFTER_MS));
}

/** Applies OIM hints immediately before the wrapped adapter sends a provider request. */
export class OimRateLimitedToolAdapter implements ToolAdapter {
  readonly kind;
  private readonly now: () => Date;

  constructor(private readonly deps: OimRateLimitedToolAdapterDeps) {
    this.kind = deps.delegate.kind;
    this.now = deps.now ?? (() => new Date());
  }

  async dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown> {
    const hint = this.deps.operation.rateLimit;
    const scope = oimRateLimitScope(this.deps.manifest, this.deps.operation, request);
    const quota =
      hint?.requests === undefined || hint.perSeconds === undefined
        ? undefined
        : { requests: hint.requests, perSeconds: hint.perSeconds };
    const now = this.now();
    let admission: OimRateLimitAdmission;
    try {
      admission = await this.deps.limits.admit({
        scope,
        quota,
        now,
      });
    } catch {
      throw new AdapterDispatchError("before_dispatch", "rate_limit_store_unavailable", false);
    }
    if (admission.outcome === "limited") {
      throw new AdapterDispatchError(
        "before_dispatch",
        "oim_rate_limited",
        true,
        undefined,
        retryAfterMs(admission.retryAt, now)
      );
    }

    try {
      return await this.deps.delegate.dispatch(request, credential, credentials);
    } catch (error) {
      if (
        error instanceof AdapterDispatchError &&
        error.code === "provider_rate_limited" &&
        error.retryAfterMs !== undefined &&
        error.retryAfterMs > 0
      ) {
        const cooldownNow = this.now();
        try {
          await this.deps.limits.imposeCooldown({
            scope,
            retryAt: new Date(cooldownNow.getTime() + error.retryAfterMs),
            now: cooldownNow,
          });
        } catch {
          throw new AdapterDispatchError("before_dispatch", "rate_limit_store_unavailable", false);
        }
      }
      throw error;
    }
  }
}
