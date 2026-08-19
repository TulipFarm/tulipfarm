import { PublicOriginError, type PublicOriginsService } from "@tulipfarm/integrations";
import type { KvService } from "@tulipfarm/kv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditService } from "../audit/service";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization } from "../authz/route-gate";
import { isNewerVersion, runningVersion } from "./version";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** GitHub repo whose releases feed the update notice. */
const RELEASES_REPO = "tulipfarm/tulipfarm";
const RELEASES_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
/** Latest-release lookups are cached in kv for a day — the notice is advisory, not real-time. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KV_NAMESPACE = "system";
const KV_KEY = "latest-release";

interface CachedRelease {
  latest: string | null;
  checkedAt: string;
}

export interface SystemRoutesDeps {
  kv?: KvService;
  publicOrigins?: PublicOriginsService;
  audit?: AuditService;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const PublicOriginsSchema = {
  type: "object",
  required: ["webOrigin", "apiOrigin", "callbackUrl", "source", "locked"],
  properties: {
    webOrigin: { type: "string" },
    apiOrigin: { type: "string" },
    callbackUrl: { type: "string" },
    source: { type: "string", enum: ["database", "environment", "default"] },
    locked: { type: "boolean" },
  },
};

/** Update-check route reports newer stable GitHub releases; updates stay manual. */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: SystemRoutesDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  app.get(
    "/api/v1/system/update-check",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Report the running TulipFarm version and whether a newer stable release exists " +
          "(GitHub releases, cached for 24h). Updates are always applied manually.",
        tags: ["system"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["version", "updateAvailable"],
            properties: {
              version: { type: "string" },
              latest: { type: "string", nullable: true },
              updateAvailable: { type: "boolean" },
              checkedAt: { type: "string", nullable: true },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req) => {
      const version = runningVersion();
      const cached = await readCache(deps);
      if (cached) {
        return {
          version,
          latest: cached.latest,
          updateAvailable: cached.latest ? isNewerVersion(version, cached.latest) : false,
          checkedAt: cached.checkedAt,
        };
      }

      let latest: string | null = null;
      try {
        const fetchImpl = deps.fetchImpl ?? fetch;
        const res = await fetchImpl(RELEASES_URL, {
          headers: { accept: "application/vnd.github+json", "user-agent": "tulipfarm" },
        });
        if (res.ok) {
          const data = (await res.json()) as { tag_name?: unknown };
          latest = typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : null;
        }
      } catch (err) {
        req.log.warn({ err }, "update check: GitHub releases lookup failed");
      }
      const checkedAt = new Date().toISOString();
      await writeCache(deps, { latest, checkedAt });
      return {
        version,
        latest,
        updateAvailable: latest ? isNewerVersion(version, latest) : false,
        checkedAt,
      };
    }
  );

  const publicOrigins = deps.publicOrigins;
  if (!publicOrigins) return;

  app.get(
    "/api/v1/system/public-origins",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Read the public web/API origins used for OAuth callbacks, webhooks, and generated links.",
        tags: ["system"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: PublicOriginsSchema, 401: ErrorSchema },
      },
    },
    async () => publicOrigins.refresh()
  );

  app.put(
    "/api/v1/system/public-origins",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "deployment.public_origins.write",
          resourceType: "deployment.public_origins",
          fallback: "admin",
        }),
      ],
      schema: {
        description:
          "Save deployment-local public origins. The API origin defaults to the web origin.",
        tags: ["system"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["webOrigin"],
          additionalProperties: false,
          properties: {
            webOrigin: { type: "string", minLength: 1, maxLength: 500 },
            apiOrigin: { type: "string", nullable: true, maxLength: 500 },
          },
        },
        response: {
          200: PublicOriginsSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { webOrigin: string; apiOrigin?: string | null };
      try {
        const origins = await publicOrigins.save(body);
        await auditPublicOriginChange(deps.audit, req, "deployment.public_origins.update");
        return origins;
      } catch (error) {
        if (error instanceof PublicOriginError) {
          return reply
            .code(error.code === "environment_locked" ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.delete(
    "/api/v1/system/public-origins",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "deployment.public_origins.write",
          resourceType: "deployment.public_origins",
          fallback: "admin",
        }),
      ],
      schema: {
        description: "Clear the saved public origins and return to environment configuration.",
        tags: ["system"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: PublicOriginsSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const origins = await publicOrigins.reset();
        await auditPublicOriginChange(deps.audit, req, "deployment.public_origins.reset");
        return origins;
      } catch (error) {
        if (error instanceof PublicOriginError && error.code === "environment_locked") {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
  );
}

async function auditPublicOriginChange(
  audit: AuditService | undefined,
  req: FastifyRequest,
  action: string
): Promise<void> {
  await audit?.recordOrWarn({
    actorId: (req.user as UserDoc | undefined)?._id ?? null,
    action,
    target: "deployment:public-origins",
  });
}

async function readCache(deps: SystemRoutesDeps): Promise<CachedRelease | null> {
  if (!deps.kv) return null;
  const entry = await deps.kv.get("system", undefined, KV_NAMESPACE, KV_KEY);
  const value = entry?.value as CachedRelease | undefined;
  return value && typeof value.checkedAt === "string" ? value : null;
}

async function writeCache(deps: SystemRoutesDeps, value: CachedRelease): Promise<void> {
  if (!deps.kv) return;
  await deps.kv.set(
    "system",
    undefined,
    KV_NAMESPACE,
    KV_KEY,
    value,
    new Date(Date.now() + CACHE_TTL_MS)
  );
}
