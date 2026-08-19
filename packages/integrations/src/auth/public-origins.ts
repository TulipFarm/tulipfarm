export const INTEGRATION_AUTH_CALLBACK_PATH = "/api/v1/integrations/auth/callback";

export interface AuthEndpoints {
  readonly callbackUrl: string;
  readonly webUrl: string;
  readonly apiUrl: string;
}

export function resolveAuthEndpoints(env: NodeJS.ProcessEnv = process.env): AuthEndpoints {
  const apiUrl = (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT ?? 4010}`).replace(/\/+$/, "");
  const webUrl = (env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  return { apiUrl, webUrl, callbackUrl: `${apiUrl}${INTEGRATION_AUTH_CALLBACK_PATH}` };
}

export function integrationAuthEndpointVars(
  endpoints: AuthEndpoints,
  env: Record<string, string>
): Record<string, string> {
  return {
    ...env,
    callback_url: endpoints.callbackUrl,
    web_url: endpoints.webUrl,
    api_url: endpoints.apiUrl,
  };
}

export function ingressWebhookUrl(endpoints: AuthEndpoints, slug: string): string {
  return `${endpoints.apiUrl.replace(/\/+$/, "")}/api/v1/hooks/integrations/${slug}`;
}

export interface StoredPublicOrigins {
  readonly webOrigin: string;
  readonly apiOrigin: string | null;
}

export type PublicOriginSource = "database" | "environment" | "default";

export interface PublicOrigins {
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly callbackUrl: string;
  readonly source: PublicOriginSource;
  readonly locked: boolean;
}

export interface PublicOriginRepository {
  get(businessId: string): Promise<StoredPublicOrigins | null>;
  put(businessId: string, origins: StoredPublicOrigins): Promise<void>;
  delete(businessId: string): Promise<void>;
}

export class PublicOriginError extends Error {
  constructor(
    readonly code: "invalid_origin" | "environment_locked",
    message: string
  ) {
    super(message);
    this.name = "PublicOriginError";
  }
}

export function normalizePublicOrigin(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PublicOriginError("invalid_origin", "Enter a full http:// or https:// address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicOriginError("invalid_origin", "The address must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new PublicOriginError(
      "invalid_origin",
      "The address cannot contain a username or password."
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new PublicOriginError(
      "invalid_origin",
      "Enter only the origin, without a path, query, or fragment."
    );
  }
  return url.origin;
}

function fromEnvironment(env: NodeJS.ProcessEnv): Omit<PublicOrigins, "locked"> {
  const webConfigured = env.PUBLIC_URL?.trim();
  const apiConfigured = env.PUBLIC_API_URL?.trim();
  const webOrigin = (webConfigured ?? "http://localhost:4000").replace(/\/+$/, "");
  const apiOrigin = (
    apiConfigured ??
    webConfigured ??
    `http://localhost:${env.PORT ?? 4010}`
  ).replace(/\/+$/, "");
  return {
    webOrigin,
    apiOrigin,
    callbackUrl: `${apiOrigin}${INTEGRATION_AUTH_CALLBACK_PATH}`,
    source: webConfigured || apiConfigured ? "environment" : "default",
  };
}

/** Resolves database-managed public origins while keeping env configuration as the fallback. */
export class PublicOriginsService {
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly locked: boolean;
  private resolved: PublicOrigins;

  constructor(
    private readonly repository: PublicOriginRepository,
    private readonly businessId: string,
    private readonly runtimeEnvironment: NodeJS.ProcessEnv = process.env
  ) {
    this.baseEnvironment = { ...runtimeEnvironment };
    this.locked = runtimeEnvironment.PUBLIC_ORIGINS_LOCKED === "true";
    this.resolved = { ...fromEnvironment(this.baseEnvironment), locked: this.locked };
  }

  async initialize(): Promise<void> {
    await this.refresh();
  }

  current(): PublicOrigins {
    return this.resolved;
  }

  async authEndpoints(): Promise<{ callbackUrl: string; webUrl: string; apiUrl: string }> {
    const origins = await this.refresh();
    return {
      callbackUrl: origins.callbackUrl,
      webUrl: origins.webOrigin,
      apiUrl: origins.apiOrigin,
    };
  }

  async refresh(): Promise<PublicOrigins> {
    const stored = this.locked ? null : await this.repository.get(this.businessId);
    this.resolved = stored
      ? this.fromStored(stored)
      : { ...fromEnvironment(this.baseEnvironment), locked: this.locked };
    this.applyRuntimeEnvironment();
    return this.resolved;
  }

  async save(input: { webOrigin: string; apiOrigin?: string | null }): Promise<PublicOrigins> {
    this.assertWritable();
    const webOrigin = normalizePublicOrigin(input.webOrigin);
    const apiOrigin = input.apiOrigin?.trim() ? normalizePublicOrigin(input.apiOrigin) : null;
    await this.repository.put(this.businessId, { webOrigin, apiOrigin });
    this.resolved = this.fromStored({ webOrigin, apiOrigin });
    this.applyRuntimeEnvironment();
    return this.resolved;
  }

  async reset(): Promise<PublicOrigins> {
    this.assertWritable();
    await this.repository.delete(this.businessId);
    this.resolved = { ...fromEnvironment(this.baseEnvironment), locked: this.locked };
    this.applyRuntimeEnvironment();
    return this.resolved;
  }

  private fromStored(stored: StoredPublicOrigins): PublicOrigins {
    const apiOrigin = stored.apiOrigin ?? stored.webOrigin;
    return {
      webOrigin: stored.webOrigin,
      apiOrigin,
      callbackUrl: `${apiOrigin}${INTEGRATION_AUTH_CALLBACK_PATH}`,
      source: "database",
      locked: this.locked,
    };
  }

  private assertWritable(): void {
    if (this.locked) {
      throw new PublicOriginError(
        "environment_locked",
        "Public addresses are managed by this deployment's environment."
      );
    }
  }

  private applyRuntimeEnvironment(): void {
    this.runtimeEnvironment.PUBLIC_URL = this.resolved.webOrigin;
    this.runtimeEnvironment.PUBLIC_API_URL = this.resolved.apiOrigin;
  }
}
