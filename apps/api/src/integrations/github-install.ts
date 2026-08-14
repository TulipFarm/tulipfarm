import {
  GitHubCredentialError,
  type IntegrationHttpPort,
  mintInstallationToken,
  signAppJwt,
} from "@tulipfarm/integrations";
import { integrationAppById, integrationAppField, type SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import { GitHubInstallHttp } from "./github-http";

/** Records completed GitHub App installs; generic integration auth owns credential acquisition. */

const GITHUB_APP = integrationAppById("github");

export interface EnsureGitHubInstallationDeps {
  integrations: IntegrationStore;
  secretsService: SecretsService;
  businessId: string;
  http?: IntegrationHttpPort;
  now?: () => Date;
  log?: { warn: (obj: unknown, message?: string) => void };
}

async function readAppSecret(
  secrets: SecretsService,
  role: "app_id" | "private_key"
): Promise<string | undefined> {
  if (!GITHUB_APP) return undefined;
  const field = integrationAppField(GITHUB_APP, role);
  if (!field) return undefined;
  try {
    return await secrets.get(field.key);
  } catch {
    return undefined;
  }
}

function readPermissions(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export interface InstalledRepository {
  owner: string;
  repo: string;
  private: boolean;
}

export async function listInstalledRepositories(
  http: IntegrationHttpPort,
  installationToken: string
): Promise<InstalledRepository[]> {
  const res = await http.send(
    { method: "GET", path: "/installation/repositories" },
    installationToken
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`failed to list installation repositories: status ${res.status}`);
  }
  const body = res.body as { repositories?: unknown } | undefined;
  if (!Array.isArray(body?.repositories)) return [];
  const repositories: InstalledRepository[] = [];
  for (const repo of body.repositories) {
    const entry = repo as { full_name?: unknown; private?: unknown };
    if (typeof entry.full_name !== "string") continue;
    const [owner, name] = entry.full_name.split("/");
    if (!owner || !name) continue;
    repositories.push({ owner, repo: name, private: entry.private === true });
  }
  return repositories;
}

/** Fail soft after credential storage; reconnects upsert installation grants. */
export async function ensureGitHubInstallation(
  deps: EnsureGitHubInstallationDeps,
  installationId: string
): Promise<void> {
  const http = deps.http ?? new GitHubInstallHttp();
  const appId = await readAppSecret(deps.secretsService, "app_id");
  const privateKeyPem = await readAppSecret(deps.secretsService, "private_key");
  if (!appId || !privateKeyPem) {
    deps.log?.warn({ event: "integrations.github.record.skipped", reason: "app_not_configured" });
    return;
  }

  try {
    const appJwt = signAppJwt(appId, privateKeyPem, deps.now);

    const installRes = await http.send(
      { method: "GET", path: `/app/installations/${installationId}` },
      appJwt
    );
    if (installRes.status < 200 || installRes.status >= 300) {
      throw new Error(`installation lookup returned ${installRes.status}`);
    }
    const installBody = installRes.body as
      | { account?: { login?: unknown }; permissions?: Record<string, unknown> }
      | undefined;
    const accountLogin =
      typeof installBody?.account?.login === "string" ? installBody.account.login : installationId;

    const minted = await mintInstallationToken(http, appJwt, installationId);
    const repos = await listInstalledRepositories(http, minted.token);
    const repoIds = repos.map((r) => `${r.owner}/${r.repo}`);

    const appRowId = "github-app";
    const integrationId = `github:${installationId}`;
    const privateKeyField = GITHUB_APP ? integrationAppField(GITHUB_APP, "private_key") : undefined;

    await deps.integrations.putApp({
      id: appRowId,
      businessId: deps.businessId,
      provider: "github",
      externalAppId: appId,
      credentialRefs: privateKeyField ? [privateKeyField.key] : [],
      status: "active",
    });
    await deps.integrations.putIntegration({
      id: integrationId,
      businessId: deps.businessId,
      appId: appRowId,
      externalTenantId: installationId,
      externalAccountId: accountLogin,
      status: "active",
    });
    await deps.integrations.putAccessGrant({
      id: `${integrationId}:grant`,
      businessId: deps.businessId,
      integrationId,
      definition: {
        externalTargets: { type: "github.repository", ids: repoIds },
        permissions: readPermissions(installBody?.permissions),
      },
      status: "active",
    });
  } catch (err) {
    deps.log?.warn({
      event: "integrations.github.record.failed",
      reason: err instanceof GitHubCredentialError ? err.reason : "unexpected",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
