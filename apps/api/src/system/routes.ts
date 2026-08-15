import type { KvService } from "@tulipfarm/kv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
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
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Update-check route reports newer stable GitHub releases; updates stay manual. */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: SystemRoutesDeps,
  requireAuth: PreHandler
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
