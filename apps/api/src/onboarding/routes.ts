import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import type { GitSyncService, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { isSoulWriteError, soulWriteHttpError } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditService } from "../audit/service";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { RequireAuthorization } from "../authz/route-gate";
import { mergeSoulConfig } from "../setup/soul-config";
import { commitActorFromRequest } from "../soul/commit-actor";
import { buildChecklist } from "./checklist";
import { getPersonalizedOrRefresh, getProfileGaps } from "./personalize";
import { buildQuests, type Quest, TIER1_BUSINESS_DESCRIPTION, TIER1_BUSINESS_NAME } from "./quests";
import { deriveSuggestions } from "./suggestions";

/* ONB-V1 read-only suggestions route. ONB-V2 adds the quest ladder (tier 1 gate / tier 2
   checklist / tier 3 AI profile gaps), dismissal in user KV `onboarding/quests-dismissed`, and a
   tier-1-only answer sink that reuses the `PUT /api/v1/business` soul-write pattern directly.
   The "Getting started" system-suggestion cards on the web home screen are static and seed a
   chat prompt directly — no backend checklist route backs them; dismissal lives in user KV
   `onboarding/getting-started`. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const KV_NAMESPACE = "onboarding";
const QUESTS_DISMISSED_KEY = "quests-dismissed";

const QuestSchema = {
  type: "object",
  required: ["id", "tier", "label", "action"],
  properties: {
    id: { type: "string" },
    tier: { type: "number", enum: [1, 2, 3] },
    label: { type: "string" },
    hint: { type: "string" },
    action: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["form", "link", "chat"] },
        field: { type: "string", enum: ["name", "description"] },
        href: { type: "string" },
        prompt: { type: "string" },
      },
    },
  },
} as const;

interface OnboardingDeps {
  /** Cheap "any active knowledge page?" check for the knowledge step (absent → treated as none). */
  hasAnyKnowledgePage?: () => Promise<boolean>;
  /** User-scoped dismissed flag store; checklist route registers only when present. */
  kvService?: KvService;
  /** Powers LLM personalization; absent → static catalog/rules fallback. */
  llmService?: LlmService;
  /** Soul git sync, to re-emit `soul.synced` after the tier-1 answer sink writes. */
  gitSync?: GitSyncService;
  /** Soul write gateway (ADR-007) — the only door for the tier-1 answer sink's soul.yaml patch. */
  soulWriter?: SoulWriter;
  /** Optional audit trail for the tier-1 direct soul write. */
  auditService?: AuditService;
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  deps: OnboardingDeps = {}
): void {
  app.get(
    "/api/v1/onboarding/suggestions",
    {
      preHandler: requireAuth,
      schema: {
        description: "Adaptive onboarding suggestions derived from the current soul state.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["suggestions"],
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "label", "prompt"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    prompt: { type: "string" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req) => {
      const personalized = await getPersonalizedOrRefresh(soulLoader, {
        kvService: deps.kvService,
        llmService: deps.llmService,
        logger: req.log,
      });
      return { suggestions: personalized?.suggestions ?? deriveSuggestions(soulLoader) };
    }
  );

  const { kvService } = deps;
  if (!kvService) return;

  const questsGitSync = deps.gitSync;
  const questsSoulWriter = deps.soulWriter;
  const auditWrite = makeSoulAuditWriter(deps.auditService);

  app.get(
    "/api/v1/onboarding/quests",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "The Companion's quest ladder: tier 1 gate (provider key, business name/description), " +
          "tier 2 checklist, and tier 3 AI-generated profile gaps once tier 1 is answered.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["quests"],
            properties: { quests: { type: "array", items: QuestSchema } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req): Promise<{ quests: Quest[] }> => {
      const ownerId = (req.user as UserDoc)._id;
      const dismissedEntry = await kvService.get(
        "user",
        ownerId,
        KV_NAMESPACE,
        QUESTS_DISMISSED_KEY
      );
      const dismissedList = Array.isArray(dismissedEntry?.value)
        ? (dismissedEntry.value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];

      const businessName =
        typeof soulLoader.manifest?.businessName === "string" &&
        soulLoader.manifest.businessName.length > 0
          ? soulLoader.manifest.businessName
          : undefined;
      const businessDescription =
        typeof soulLoader.manifest?.businessDescription === "string" &&
        soulLoader.manifest.businessDescription.length > 0
          ? soulLoader.manifest.businessDescription
          : undefined;
      const hasProviderKey = deps.llmService?.isConfigured() ?? false;
      const hasKnowledge = (await deps.hasAnyKnowledgePage?.()) ?? false;

      const gateOpen = hasProviderKey && businessName !== undefined;
      const profileGaps = gateOpen
        ? await getProfileGaps(soulLoader, {
            llmService: deps.llmService,
            kvService,
            logger: req.log,
          })
        : [];

      const quests = buildQuests({
        soul: soulLoader,
        hasKnowledge,
        hasProviderKey,
        businessName,
        businessDescription,
        profileGaps,
        dismissed: new Set(dismissedList),
      });
      return { quests };
    }
  );

  app.post(
    "/api/v1/onboarding/quests/:id/answer",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "onboarding.quest.answer",
          resourceType: "onboarding",
          fallback: "admin",
        }),
      ],
      schema: {
        description:
          "Answers a tier-1 quest inline (business name or description; admin only). Writes " +
          "soul.yaml the same way `PUT /api/v1/business` does and re-emits soul.synced. Tier 2/3 " +
          "quests are answered through chat instead, not this route.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string", minLength: 1, maxLength: 2000 } },
        },
        response: {
          200: {
            type: "object",
            required: ["id", "answered"],
            properties: { id: { type: "string" }, answered: { type: "boolean" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!questsGitSync || !questsSoulWriter) {
        return reply.code(400).send({ error: "soul git sync unavailable" });
      }
      const { id } = req.params as { id: string };
      const { value } = req.body as { value: string };
      const trimmed = value.trim();
      if (!trimmed) return reply.code(400).send({ error: "value is required" });
      if (id !== TIER1_BUSINESS_NAME && id !== TIER1_BUSINESS_DESCRIPTION) {
        return reply.code(400).send({ error: `quest ${id} is not answerable via this route` });
      }
      if (id === TIER1_BUSINESS_NAME && trimmed.length > 200) {
        return reply.code(400).send({ error: "value must be 200 characters or fewer" });
      }

      const next = mergeSoulConfig(
        questsSoulWriter.read("Settings"),
        id === TIER1_BUSINESS_NAME ? { businessName: trimmed } : { businessDescription: trimmed }
      );
      try {
        await questsSoulWriter.apply({
          subject: "chore: update business profile",
          source: "api",
          actor: commitActorFromRequest(req),
          businessId: DEPLOYMENT_BUSINESS_ID,
          changes: [{ op: "put", target: { kind: "Settings" }, content: next }],
        });
      } catch (e) {
        if (isSoulWriteError(e)) {
          const m = soulWriteHttpError(e);
          return reply.code(m.status).send(m.body);
        }
        throw e;
      }
      questsGitSync.emit("soul.synced");
      await auditWrite(req, "soul-config.update", "soul:business-profile", { quest: id });

      return reply.send({ id, answered: true });
    }
  );

  app.post(
    "/api/v1/onboarding/quests/:id/dismiss",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Dismisses a single quest for the current user. Dismissal is per-user, not global.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["id", "dismissed"],
            properties: { id: { type: "string" }, dismissed: { type: "boolean" } },
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const ownerId = (req.user as UserDoc)._id;
      const { id } = req.params as { id: string };
      const entry = await kvService.get("user", ownerId, KV_NAMESPACE, QUESTS_DISMISSED_KEY);
      const existing = Array.isArray(entry?.value)
        ? (entry.value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const next = existing.includes(id) ? existing : [...existing, id];
      await kvService.set("user", ownerId, KV_NAMESPACE, QUESTS_DISMISSED_KEY, next);
      return reply.send({ id, dismissed: true });
    }
  );
}
