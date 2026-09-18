import {
  type IntegrationHttpPort,
  type NativeWebhookProvider,
  signAppJwt,
} from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import { integrationSecretKey } from "../connection-env";
import { GitHubInstallHttp } from "../github-http";

export class NativeChannelError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503 = 403
  ) {
    super(code);
    this.name = "NativeChannelError";
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class NativeChannelCredentials {
  readonly http: IntegrationHttpPort;

  constructor(
    private readonly secrets: Pick<SecretsService, "get">,
    private readonly soul: SoulLoader,
    http?: IntegrationHttpPort
  ) {
    this.http =
      http ??
      new GitHubInstallHttp({
        fetch: (url, init) =>
          fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }),
      });
  }

  assertEnabled(provider: NativeWebhookProvider): void {
    if (this.soul.integrations.get(provider)?.connection?.enabled !== true) {
      throw new NativeChannelError("native_channel_disconnected", 404);
    }
  }

  async secret(provider: NativeWebhookProvider, name: string): Promise<string> {
    this.assertEnabled(provider);
    const value = await this.secrets
      .get(integrationSecretKey(provider, name))
      .catch(() => undefined);
    if (!value) throw new NativeChannelError("native_credential_unavailable", 503);
    return value;
  }

  signingSecret(provider: NativeWebhookProvider): Promise<string> {
    return this.secret(
      provider,
      provider === "slack" ? "SLACK_SIGNING_SECRET" : "GITHUB_WEBHOOK_SECRET"
    );
  }

  async githubApp(): Promise<{ appId: string; jwt: string; botLogin: string }> {
    const appId = await this.secret("github", "GITHUB_APP_ID");
    const privateKey = await this.secret("github", "GITHUB_APP_PRIVATE_KEY");
    const jwt = signAppJwt(appId, privateKey);
    const response = await this.http.send({ method: "GET", path: "/app" }, jwt);
    const app = object(response.body);
    if (
      response.status !== 200 ||
      String(app?.id) !== appId ||
      typeof app?.slug !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(app.slug)
    ) {
      throw new NativeChannelError("github_app_verification_failed", 503);
    }
    return { appId, jwt, botLogin: `${app.slug}[bot]` };
  }

  async githubReply(input: {
    readonly externalAppId: string;
    readonly installationId: string;
    readonly repository: string;
  }): Promise<{ token: string; botUserId: string }> {
    if (!/^[1-9]\d*$/.test(input.installationId)) {
      throw new NativeChannelError("github_installation_invalid");
    }
    const app = await this.githubApp();
    if (app.appId !== input.externalAppId) throw new NativeChannelError("github_app_changed");
    const [owner, repository, extra] = input.repository.split("/");
    if (!owner || !repository || extra || !/^[\w.-]+$/.test(repository)) {
      throw new NativeChannelError("github_repository_invalid", 400);
    }
    const minted = await this.http.send(
      {
        method: "POST",
        path: `/app/installations/${input.installationId}/access_tokens`,
        body: {
          repositories: [repository],
          permissions: { issues: "write", pull_requests: "write" },
        },
      },
      app.jwt
    );
    const token = object(minted.body);
    if (
      minted.status !== 201 ||
      typeof token?.token !== "string" ||
      typeof token.expires_at !== "string" ||
      !(Date.parse(token.expires_at) > Date.now())
    ) {
      throw new NativeChannelError("github_reply_token_unavailable", 503);
    }
    const target = await this.http.send(
      {
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      },
      token.token
    );
    if (
      target.status !== 200 ||
      String(object(target.body)?.full_name).toLowerCase() !== input.repository.toLowerCase()
    ) {
      throw new NativeChannelError("github_repository_not_authorized");
    }
    const bot = await this.http.send(
      { method: "GET", path: `/users/${encodeURIComponent(app.botLogin)}` },
      token.token
    );
    const identity = object(bot.body);
    if (
      bot.status !== 200 ||
      identity?.type !== "Bot" ||
      identity.login !== app.botLogin ||
      !/^[1-9]\d*$/.test(String(identity.id))
    ) {
      throw new NativeChannelError("github_reply_identity_unavailable", 503);
    }
    return { token: token.token, botUserId: String(identity.id) };
  }
}
