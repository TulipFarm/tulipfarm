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
import { type InstalledRepository, listInstalledRepositories } from "./github-install";

/*
 * What a business can do with GitHub *after* it is connected: inspect its installations, pick a
 * Soul repository, and disconnect.
 *
 * Acquiring the credentials is not here. `integrations/github/manifest.yml` declares the App
 * creation and installation as ordinary `app_manifest` and `install` steps, executed by the
 * generic auth broker (`auth-broker.ts`) that every integration shares, and the installation is
 * recorded by `ensureGitHubInstallation` (`github-install.ts`) from the shared `onConnected` hook.
 * There is no TulipFarm-owned App: each deployment creates its own.
 *
 * The Soul-repo step is genuinely GitHub-specific and stays: once an installation exists, the
 * customer either connects one of its already-granted repos (`connected_existing`) or has the App
 * create a fresh one (`created_via_app`, which needs `administration: write` — requested only as
 * an incremental re-auth via GitHub's "update permissions" URL, never in the base install). Either
 * path writes one row to `soul_repositories` (`SoulRepositoryStore`, one business -> one Soul repo).
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

/**
 * Throws on a non-2xx GitHub response rather than returning `[]` — there is no periodic resync of
 * an installation's repo grant, so silently treating an API error as "zero repos" would have
 * persisted that empty state permanently instead of surfacing the failure to the caller.
 */

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
