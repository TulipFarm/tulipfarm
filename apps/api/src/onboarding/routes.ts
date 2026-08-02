import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { KvService } from "../kv/service";
import { buildChecklist } from "./checklist";
import { getPersonalizedOnboarding } from "./personalize";
import { deriveSuggestions } from "./suggestions";

/*
 * Read-only HTTP surface for the normal-chat onboarding layer (ONBOARDING ONB-V1).
 *
 * - `/suggestions` — the adaptive empty-state chips, derived from the soul resource set (a candidate
 *   is omitted once the resource it would create already exists). No persistence.
 * - `/checklist` — the "Getting started" card: the core build-block steps (status auto-derived from
 *   real soul/knowledge state) plus deterministic "recommended next" items, plus the user's
 *   dismissed flag (persisted in the user-scoped KV store, namespace `onboarding`, key `checklist`).
 *   Registered only when a KvService is wired so the suggestions route stays dependency-light.
 *
 * Non-blocking by design: the chat landing surface renders whatever these return.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const KV_NAMESPACE = "onboarding";
const KV_KEY = "checklist";

interface OnboardingDeps {
  /** Cheap "any active knowledge page?" check for the knowledge step (absent → treated as none). */
  hasAnyKnowledgePage?: () => Promise<boolean>;
  /** User-scoped store for the dismissed flag; the checklist route is registered only when present. */
  kvService?: KvService;
  /** Powers LLM personalization; absent → static catalog/rules fallback. */
  llmService?: LlmService;
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  requireAuth: PreHandler,
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
      const personalized = await getPersonalizedOnboarding(soulLoader, {
        kvService: deps.kvService,
        llmService: deps.llmService,
        logger: req.log,
      });
      return { suggestions: personalized?.suggestions ?? deriveSuggestions(soulLoader) };
    }
  );

  const { kvService } = deps;
  if (!kvService) return;

  app.get(
    "/api/v1/onboarding/checklist",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Getting-started checklist: core build-block steps (status auto-derived from real state), " +
          "deterministic next-step recommendations, and the user's dismissed flag.",
        tags: ["onboarding"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["dismissed", "steps", "recommendations"],
            properties: {
              dismissed: { type: "boolean" },
              businessName: { type: "string" },
              steps: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "label", "status"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    status: { type: "string", enum: ["done", "todo", "coming-soon"] },
                    prompt: { type: "string" },
                  },
                },
              },
              recommendations: {
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
      const ownerId = (req.user as UserDoc)._id;
      const entry = await kvService.get("user", ownerId, KV_NAMESPACE, KV_KEY);
      const value = entry?.value as { dismissed?: unknown } | undefined;
      const dismissed = value?.dismissed === true;
      const hasKnowledge = (await deps.hasAnyKnowledgePage?.()) ?? false;
      const businessName =
        typeof soulLoader.manifest?.businessName === "string"
          ? soulLoader.manifest.businessName
          : undefined;
      const { steps, recommendations } = buildChecklist(soulLoader, hasKnowledge, businessName);
      const personalized = await getPersonalizedOnboarding(soulLoader, {
        kvService,
        llmService: deps.llmService,
        logger: req.log,
      });
      return {
        dismissed,
        businessName,
        steps,
        recommendations: personalized?.recommendations ?? recommendations,
      };
    }
  );
}
