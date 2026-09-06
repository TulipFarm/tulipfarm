import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { AuthorizationCheck } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";
import {
  AdhocConnectionError,
  type AdhocInjectionRule,
  createAdhocConnection,
  matchAdhocConnection,
} from "./adhoc-connections";

/**
 * The route behind the confirmation form a person reaches from an `authentication_required` answer.
 *
 * It exists so the credential itself never travels through a model: the Tool reports what the
 * provider asked for and stops, and the value is typed into this route by the person who holds it.
 * Nothing here accepts a value an Agent supplied.
 */

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdhocConnectionRouteDeps {
  readonly connections: ConnectionStore;
  readonly secrets: SecretsService;
  readonly requireAuth: PreHandler;
  /**
   * Decides whether this caller may create an organization-scoped Connection.
   *
   * Separate from creating a personal one: a personal Connection spends only its owner's own
   * credential, while an organization one hands every authorized principal a way to act as the
   * business.
   */
  readonly authorizationCheck: AuthorizationCheck;
  readonly audit?: (
    req: FastifyRequest,
    action: string,
    subject: string,
    detail: Record<string, unknown>
  ) => Promise<void>;
}

const RuleSchema = {
  type: "object",
  required: ["location", "name"],
  properties: {
    location: { type: "string", enum: ["header", "query"] },
    name: { type: "string", minLength: 1, maxLength: 128 },
    valuePrefix: { type: "string", maxLength: 64 },
  },
} as const;

const CreatedSchema = {
  type: "object",
  required: ["connectionId", "origin", "scope"],
  properties: {
    connectionId: { type: "string" },
    origin: { type: "string" },
    scope: { type: "string" },
  },
} as const;

const MatchSchema = {
  type: "object",
  required: ["origin", "state"],
  properties: {
    origin: { type: "string" },
    state: { type: "string", enum: ["none", "match", "ambiguous"] },
    count: { type: "number" },
    label: { type: "string" },
  },
} as const;

interface CreateBody {
  readonly origin: string;
  readonly rule: AdhocInjectionRule;
  readonly secretValue: string;
  readonly label: string;
  readonly scope?: "personal" | "organization";
}

function principalOf(req: FastifyRequest): RequestPrincipal | undefined {
  return (req as FastifyRequest & { principal?: RequestPrincipal }).principal;
}

/** The message a person can act on, for the two ways a confirmation can be unusable. */
const REFUSALS: Record<AdhocConnectionError["code"], string> = {
  session_header:
    "A browser session cannot be stored as a Credential: it delegates the whole session rather than a token whose reach you can see. Use an API token instead.",
  invalid_origin: "That is not a destination this deployment can reach.",
  invalid_rule: "Name the header or query parameter the Credential belongs in.",
};

export function registerAdhocConnectionRoutes(
  app: FastifyInstance,
  deps: AdhocConnectionRouteDeps
): void {
  app.post(
    "/api/v1/connections/adhoc",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description:
          "Store a Credential a person confirmed for one origin, as a destination-bound Connection.",
        tags: ["connections"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["origin", "rule", "secretValue", "label"],
          properties: {
            origin: { type: "string", minLength: 1, maxLength: 2048 },
            rule: RuleSchema,
            secretValue: { type: "string", minLength: 1, maxLength: 8192 },
            label: { type: "string", minLength: 1, maxLength: 128 },
            scope: { type: "string", enum: ["personal", "organization"] },
          },
        },
        response: {
          201: CreatedSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as CreateBody;
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply.code(403).send({ error: "only a signed-in person can confirm a Credential" });
      }
      // Personal is the default because it is the narrower of the two: an operator who meant to
      // share a Credential has to say so, while one who did not cannot widen it by omission.
      const scope = body.scope ?? "personal";
      if (scope === "organization") {
        const allowed = await deps.authorizationCheck(principal, {
          action: "connection.create",
          resourceType: "connection",
          fallback: "admin",
        });
        if (!allowed) {
          return reply
            .code(403)
            .send({ error: "not authorized to create an organization Connection" });
        }
      }

      try {
        const created = await createAdhocConnection(
          { connections: deps.connections, secrets: deps.secrets },
          {
            businessId: principal.businessId,
            origin: body.origin,
            rule: { ...body.rule, valuePrefix: body.rule.valuePrefix ?? "" },
            secretValue: body.secretValue,
            label: body.label,
            owner:
              scope === "organization"
                ? { scope: "organization" }
                : { scope: "personal", principalKind: "user", principalId: principal.id },
          }
        );
        // The value is deliberately absent from the audit detail; what is worth recording is that
        // this person bound a Credential to this destination, not what they bound.
        await deps.audit?.(req, "connection.create", `connection:${created.connectionId}`, {
          origin: created.origin,
          scope,
          location: body.rule.location,
        });
        return reply.code(201).send({ ...created, scope });
      } catch (error) {
        if (error instanceof AdhocConnectionError) {
          return reply.code(422).send({ error: REFUSALS[error.code] });
        }
        throw error;
      }
    }
  );

  app.get(
    "/api/v1/connections/adhoc",
    {
      preHandler: [deps.requireAuth],
      schema: {
        description: "Whether this caller already holds a Connection for an origin.",
        tags: ["connections"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          required: ["origin"],
          properties: { origin: { type: "string", minLength: 1, maxLength: 2048 } },
        },
        response: { 200: MatchSchema, 401: ErrorSchema, 403: ErrorSchema, 500: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { origin } = req.query as { origin: string };
      const principal = principalOf(req);
      if (principal === undefined || principal.kind !== "user") {
        return reply.code(403).send({ error: "only a signed-in person can read this" });
      }
      const match = await matchAdhocConnection(
        { connections: deps.connections },
        { businessId: principal.businessId, origin, principalId: principal.id }
      );
      switch (match.kind) {
        case "none":
          return { origin, state: "none" };
        case "ambiguous":
          return { origin, state: "ambiguous", count: match.count };
        // The label is safe to return and the injection rule is not: naming the header invites a
        // caller to rebuild the request by hand rather than going through the governed Tool.
        case "match":
          return { origin, state: "match", label: match.connection.label };
      }
    }
  );
}
