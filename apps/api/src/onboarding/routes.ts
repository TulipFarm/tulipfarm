import type { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { getPersonalizedOrRefresh } from "./personalize";
import { deriveSuggestions } from "./suggestions";

/* The chat landing chips. Personalized when a provider key and cache are available, static
   otherwise. The "Getting started" cards on the web home screen are separate and static: they seed
   a chat prompt directly, and their dismissal lives in user KV `onboarding/getting-started`. */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface OnboardingDeps {
  /** Cache for the personalized chips; absent → static catalog. */
  kvService?: KvService;
  /** Powers LLM personalization; absent → static catalog. */
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
      const personalized = await getPersonalizedOrRefresh(soulLoader, {
        kvService: deps.kvService,
        llmService: deps.llmService,
        logger: req.log,
      });
      return { suggestions: personalized?.suggestions ?? deriveSuggestions(soulLoader) };
    }
  );
}
