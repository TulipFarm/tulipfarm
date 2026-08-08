import {
  GitHubCredentialError,
  type GitHubCredentialErrorReason,
  type IntegrationHttpPort,
  mintInstallationToken,
  signAppJwt,
} from "@tulipfarm/integrations";
import { integrationAppById, integrationAppField, type SecretsService } from "@tulipfarm/secrets";
import type { IntegrationStore, SoulRepositoryStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { GitHubInstallHttp } from "./github-http";
import {
  githubInstallStateKeyResolver,
  issueInstallState,
  verifyInstallState,
} from "./github-install-state";

/*
 * GitHub App install flow (plan Phase 2): one TulipFarm-owned App, each customer installs it into
 * their own org/repos. `/install/start` redirects the browser to GitHub with a signed, short-lived
 * `state`; GitHub redirects back to `/install/callback` with `installation_id` once the customer
 * approves. From there this app mints its own App JWT (Phase 1's `signAppJwt`), looks up the
 * installation and its repositories, and writes the `integration_apps` / `integrations` /
 * `integration_access_grants` rows the rest of the platform reads (`packages/storage`'s
 * `IntegrationStore`) — the same multi-tenant shape Slack's bind flow already uses
 * (`integrations/slack-binding.ts`), just reached via a GitHub-side redirect instead of a pasted
 * bot token.
 *
 * Phase 10 extends the same flow with a repo-pick/create step for the business's Soul checkout:
 * once an installation exists, the customer either connects one of its already-granted repos
 * (`connected_existing`) or has the App create a fresh one (`created_via_app`, which needs
 * `administration: write` — requested only as an incremental re-auth via GitHub's
 * "update permissions" URL, never in the base install). Either path writes one row to
 * `soul_repositories` (`SoulRepositoryStore`, one business -> one Soul repo).
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface GitHubInstallDeps {
  integrations: IntegrationStore;
  secretsService: SecretsService;
  businessId: string;
  requireAuth: PreHandler;
  /** Business -> Soul repo mapping (Phase 10 repo-pick/create step). */
  soulRepositories: SoulRepositoryStore;
  /** Overridable for tests — defaults to a real `api.github.com` client. */
  http?: IntegrationHttpPort;
  now?: () => Date;
}

const GITHUB_APP = integrationAppById("github");

function statusForCredentialError(reason: GitHubCredentialErrorReason): 500 | 404 | 502 {
  switch (reason) {
    case "invalid_private_key":
      return 500;
    case "installation_not_found":
      return 404;
    case "token_exchange_failed":
      return 502;
  }
}

/** Reads one registry field's stored value, or `undefined` if the App isn't configured yet. */
async function readAppField(
  secrets: SecretsService,
  role: "app_id" | "app_slug" | "private_key"
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

export function registerGitHubInstallRoutes(app: FastifyInstance, deps: GitHubInstallDeps): void {
  const stateKey = githubInstallStateKeyResolver(deps.secretsService);
  const http = deps.http ?? new GitHubInstallHttp();
  const installationTokenCache: InstallationTokenCache = new Map();

  app.get(
    "/api/v1/integrations/github/status",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "List this business's GitHub App installations and the repos each covers.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["installations"],
            properties: {
              installations: {
                type: "array",
                items: {
                  type: "object",
                  required: ["installationId", "account", "repositories"],
                  properties: {
                    installationId: { type: "string" },
                    account: { type: "string" },
                    repositories: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const snapshot = await deps.integrations.loadProviderSnapshot(deps.businessId, "github");
      const grantsByIntegration = new Map(
        snapshot.accessGrants.map((grant) => [grant.integrationId, grant])
      );
      const installations = snapshot.integrations
        .filter((integration) => integration.status === "active")
        .map((integration) => {
          const grant = grantsByIntegration.get(integration.id);
          const definition = grant?.definition as
            | { externalTargets?: { ids?: unknown } }
            | undefined;
          const ids = definition?.externalTargets?.ids;
          return {
            installationId: integration.externalTenantId,
            account: integration.externalAccountId ?? integration.externalTenantId,
            repositories: Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === "string")
              : [],
          };
        });
      return { installations };
    }
  );

  app.post(
    "/api/v1/integrations/github/installations/:installationId/disconnect",
    {
      preHandler: deps.requireAuth,
      schema: {
        description:
          "Revoke this business's own bookkeeping for one GitHub App installation. Does not " +
          "uninstall the App on GitHub's side — use GitHub's installation settings for that.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["installationId"],
          properties: { installationId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { installationId } = req.params as { installationId: string };
      const snapshot = await deps.integrations.loadProviderSnapshot(deps.businessId, "github");
      const integration = snapshot.integrations.find(
        (candidate) =>
          candidate.status === "active" && candidate.externalTenantId === installationId
      );
      if (!integration) {
        return reply.code(404).send({ error: "installation not found" });
      }
      await deps.integrations.revokeIntegration(deps.businessId, integration.id);
      return reply.code(200).send({ status: "disconnected" });
    }
  );

  app.get(
    "/api/v1/integrations/github/install/start",
    {
      preHandler: deps.requireAuth,
      schema: {
        description:
          "Begin a GitHub App installation: redirects to github.com to pick an org/repos.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 302: { type: "null" }, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (_req, reply) => {
      const appSlug = await readAppField(deps.secretsService, "app_slug");
      if (!appSlug) {
        return reply.code(400).send({ error: "GitHub App is not configured" });
      }
      const state = issueInstallState(await stateKey(), deps.now);
      return reply.redirect(
        `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(state)}`,
        302
      );
    }
  );

  app.get(
    "/api/v1/integrations/github/install/callback",
    {
      // No requireAuth: GitHub redirects the browser here directly from github.com, a cross-site
      // top-level navigation that never carries our SameSite=Strict session cookie. The signed,
      // short-lived `state` param (verified below) is this route's actual authenticity check —
      // it proves the callback follows a redirect this deployment's `/install/start` issued.
      schema: {
        description: "GitHub App install callback: verifies state, records the installation.",
        tags: ["integrations"],
        querystring: {
          type: "object",
          required: ["setup_action", "state"],
          properties: {
            installation_id: { type: "string" },
            setup_action: { type: "string" },
            state: { type: "string" },
          },
        },
        response: {
          302: { type: "null" },
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const {
        installation_id: installationId,
        setup_action: setupAction,
        state,
      } = req.query as {
        installation_id?: string;
        setup_action: string;
        state: string;
      };

      if (!verifyInstallState(await stateKey(), state, deps.now)) {
        req.log?.warn({ event: "integrations.github.install.denied", reason: "invalid_state" });
        return reply.code(401).send({ error: "install state is invalid or expired" });
      }

      // An org member requested the install but an admin hasn't approved it yet — nothing to
      // record until the approval round-trips back through this same callback with an id.
      if (setupAction === "request" || !installationId) {
        return reply.code(200).send({ status: "pending_approval" });
      }

      const appId = await readAppField(deps.secretsService, "app_id");
      const privateKeyPem = await readAppField(deps.secretsService, "private_key");
      if (!appId || !privateKeyPem) {
        return reply.code(400).send({ error: "GitHub App is not configured" });
      }

      let appJwt: string;
      try {
        appJwt = signAppJwt(appId, privateKeyPem, deps.now);
      } catch (err) {
        const reason = err instanceof GitHubCredentialError ? err.reason : "invalid_private_key";
        req.log?.warn({ event: "integrations.github.install.denied", reason });
        return reply
          .code(statusForCredentialError(reason))
          .send({ error: "GitHub App JWT signing failed" });
      }

      const installRes = await http.send(
        { method: "GET", path: `/app/installations/${installationId}` },
        appJwt
      );
      if (installRes.status < 200 || installRes.status >= 300) {
        return reply.code(502).send({ error: "failed to read installation details from GitHub" });
      }
      const installBody = installRes.body as
        | { account?: { login?: unknown }; permissions?: Record<string, unknown> }
        | undefined;
      const accountLogin =
        typeof installBody?.account?.login === "string"
          ? installBody.account.login
          : installationId;
      const permissions = readPermissions(installBody?.permissions);

      let minted: Awaited<ReturnType<typeof mintInstallationToken>>;
      try {
        minted = await mintInstallationToken(http, appJwt, installationId);
      } catch (err) {
        const reason = err instanceof GitHubCredentialError ? err.reason : "token_exchange_failed";
        req.log?.warn({ event: "integrations.github.install.denied", reason });
        return reply
          .code(statusForCredentialError(reason))
          .send({ error: "failed to mint installation token" });
      }

      let repoIds: string[];
      try {
        repoIds = await listInstalledRepositoryIds(http, minted.token);
      } catch (err) {
        req.log?.warn({
          event: "integrations.github.install.denied",
          reason: "repo_list_failed",
          message: err instanceof Error ? err.message : String(err),
        });
        return reply.code(502).send({ error: "failed to list installation repositories" });
      }

      const appRowId = "github-app";
      const integrationId = `github:${installationId}`;
      const appField = GITHUB_APP ? integrationAppField(GITHUB_APP, "private_key") : undefined;

      await deps.integrations.putApp({
        id: appRowId,
        businessId: deps.businessId,
        provider: "github",
        externalAppId: appId,
        credentialRefs: appField ? [appField.key] : [],
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
          permissions,
        },
        status: "active",
      });

      const webAppOrigin = (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/+$/, "");
      return reply.redirect(`${webAppOrigin}/integrations/github?installed=1`, 302);
    }
  );

  app.get(
    "/api/v1/integrations/github/soul-repo",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "Read this business's selected Soul repository, if one is set.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["soulRepo"],
            properties: {
              soulRepo: {
                type: ["object", "null"],
                required: ["integrationId", "owner", "repo", "createdVia"],
                properties: {
                  integrationId: { type: "string" },
                  owner: { type: "string" },
                  repo: { type: "string" },
                  createdVia: { type: "string" },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const soulRepo = await deps.soulRepositories.get(deps.businessId);
      if (!soulRepo) return { soulRepo: null };
      return {
        soulRepo: {
          integrationId: soulRepo.integrationId,
          owner: soulRepo.owner,
          repo: soulRepo.repo,
          createdVia: soulRepo.createdVia,
        },
      };
    }
  );

  app.get(
    "/api/v1/integrations/github/installations/:installationId/repos",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "List the repos an installation currently grants access to (repo picker).",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["installationId"],
          properties: { installationId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["repositories"],
            properties: {
              repositories: {
                type: "array",
                items: {
                  type: "object",
                  required: ["owner", "repo", "private"],
                  properties: {
                    owner: { type: "string" },
                    repo: { type: "string" },
                    private: { type: "boolean" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { installationId } = req.params as { installationId: string };
      const minted = await mintTokenForInstallation(
        deps,
        http,
        installationId,
        installationTokenCache
      );
      if (!minted.ok) return reply.code(minted.status).send({ error: minted.error });

      let repositories: InstalledRepository[];
      try {
        repositories = await listInstalledRepositories(http, minted.token);
      } catch {
        return reply.code(502).send({ error: "failed to list installation repositories" });
      }
      return { repositories };
    }
  );

  app.post(
    "/api/v1/integrations/github/soul-repo",
    {
      preHandler: deps.requireAuth,
      schema: {
        description: "Connect an already-granted repo as this business's Soul repo.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["installationId", "owner", "repo"],
          properties: {
            installationId: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { installationId, owner, repo } = req.body as {
        installationId: string;
        owner: string;
        repo: string;
      };

      const minted = await mintTokenForInstallation(
        deps,
        http,
        installationId,
        installationTokenCache
      );
      if (!minted.ok) return reply.code(minted.status).send({ error: minted.error });

      let repositories: InstalledRepository[];
      try {
        repositories = await listInstalledRepositories(http, minted.token);
      } catch {
        return reply.code(502).send({ error: "failed to list installation repositories" });
      }
      const granted = repositories.some((r) => r.owner === owner && r.repo === repo);
      if (!granted) {
        return reply
          .code(400)
          .send({ error: "installation does not grant access to that repository" });
      }

      await deps.soulRepositories.put({
        businessId: deps.businessId,
        integrationId: `github:${installationId}`,
        owner,
        repo,
        createdVia: "connected_existing",
      });
      return reply.code(200).send({ status: "connected" });
    }
  );

  app.post(
    "/api/v1/integrations/github/soul-repo/create",
    {
      preHandler: deps.requireAuth,
      schema: {
        description:
          "Create a new repo via the App to hold this business's Soul. Requires " +
          "administration:write on the installation — granted as an incremental re-auth, not the " +
          "base install.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["installationId", "owner", "repo"],
          properties: {
            installationId: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: {
            type: "object",
            required: ["error", "upgradeUrl"],
            properties: { error: { type: "string" }, upgradeUrl: { type: "string" } },
          },
          500: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { installationId, owner, repo } = req.body as {
        installationId: string;
        owner: string;
        repo: string;
      };

      const snapshot = await deps.integrations.loadProviderSnapshot(deps.businessId, "github");
      const integration = snapshot.integrations.find(
        (candidate) =>
          candidate.externalTenantId === installationId && candidate.status === "active"
      );
      if (!integration) return reply.code(404).send({ error: "installation not found" });
      const grant = snapshot.accessGrants.find(
        (candidate) => candidate.integrationId === integration.id
      );
      const permissions = (
        grant?.definition as { permissions?: Record<string, unknown> } | undefined
      )?.permissions;
      if (permissions?.administration !== "write") {
        return reply.code(409).send({
          error: "administration:write is required to create a repo via the App",
          upgradeUrl: `https://github.com/settings/installations/${installationId}/permissions/update`,
        });
      }

      const minted = await mintTokenForInstallation(
        deps,
        http,
        installationId,
        installationTokenCache
      );
      if (!minted.ok) return reply.code(minted.status).send({ error: minted.error });

      const createRes = await http.send(
        { method: "POST", path: `/orgs/${owner}/repos`, body: { name: repo, private: true } },
        minted.token
      );
      if (createRes.status < 200 || createRes.status >= 300) {
        req.log?.warn({
          event: "integrations.github.soul_repo.create_failed",
          status: createRes.status,
        });
        return reply.code(502).send({ error: "failed to create repository via GitHub App" });
      }

      await deps.soulRepositories.put({
        businessId: deps.businessId,
        integrationId: `github:${installationId}`,
        owner,
        repo,
        createdVia: "created_via_app",
      });
      return reply.code(200).send({ status: "created" });
    }
  );
}

/**
 * GitHub's install callback returns permissions as `{ issues: "write", ... }` — the only durable
 * source for `GitHubInstallationScope.permissions`, since the App manifest only states the
 * *requested* ceiling, not what an org admin actually granted.
 */
function readPermissions(
  raw: Record<string, unknown> | undefined
): Record<string, "read" | "write"> {
  const permissions: Record<string, "read" | "write"> = {};
  if (!raw) return permissions;
  for (const [key, value] of Object.entries(raw)) {
    if (value === "read" || value === "write") permissions[key] = value;
  }
  return permissions;
}

interface InstalledRepository {
  owner: string;
  repo: string;
  private: boolean;
}

/**
 * Throws on a non-2xx GitHub response rather than returning `[]` — there is no periodic resync of
 * an installation's repo grant, so silently treating an API error as "zero repos" would have
 * persisted that empty state permanently instead of surfacing the failure to the caller.
 */
async function listInstalledRepositories(
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

async function listInstalledRepositoryIds(
  http: IntegrationHttpPort,
  installationToken: string
): Promise<string[]> {
  const repositories = await listInstalledRepositories(http, installationToken);
  return repositories.map((r) => `${r.owner}/${r.repo}`);
}

type MintResult =
  | { ok: true; token: string }
  | { ok: false; status: 404 | 500 | 502; error: string };

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** Per-installation token cache for the repo-picker/create routes, keyed by installation id. */
type InstallationTokenCache = Map<string, CachedInstallationToken>;

/** Refresh ahead of GitHub's ~1hr expiry so a cached token is never handed out about to expire. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Mints a fresh installation token for a repo-picker/create request, or returns the cached one if
 * still comfortably inside its ~1hr expiry. Distinct from the install-callback's minting (which
 * also needs the raw JWT to read installation details) — these routes only ever need the exchanged
 * installation token, so they can share this cache across a burst of repo-picker requests instead
 * of minting a new token from GitHub on every call.
 */
async function mintTokenForInstallation(
  deps: GitHubInstallDeps,
  http: IntegrationHttpPort,
  installationId: string,
  cache: InstallationTokenCache
): Promise<MintResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cached = cache.get(installationId);
  if (
    cached !== undefined &&
    cached.expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS > now.getTime()
  ) {
    return { ok: true, token: cached.token };
  }

  const appId = await readAppField(deps.secretsService, "app_id");
  const privateKeyPem = await readAppField(deps.secretsService, "private_key");
  if (!appId || !privateKeyPem) {
    return { ok: false, status: 500, error: "GitHub App is not configured" };
  }

  let appJwt: string;
  try {
    appJwt = signAppJwt(appId, privateKeyPem, deps.now);
  } catch {
    return { ok: false, status: 500, error: "GitHub App JWT signing failed" };
  }

  try {
    const minted = await mintInstallationToken(http, appJwt, installationId);
    cache.set(installationId, { token: minted.token, expiresAt: minted.expiresAt });
    return { ok: true, token: minted.token };
  } catch (err) {
    const reason = err instanceof GitHubCredentialError ? err.reason : "token_exchange_failed";
    return { ok: false, status: statusForCredentialError(reason), error: reason };
  }
}
