import type { FastifyInstance } from "fastify";

export interface OimIngressRouteRequest {
  readonly route: {
    readonly integrationKey: string;
    readonly connectionId: string;
  };
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type OimIngressRouteResult =
  | { readonly kind: "handshake"; readonly body: unknown }
  | { readonly kind: "accepted"; readonly deliveryId: string; readonly duplicate: boolean }
  | { readonly kind: "discarded"; readonly reason: string }
  | { readonly kind: "unverified"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface OimIngressRoutesDeps {
  readonly receive: (request: OimIngressRouteRequest) => Promise<OimIngressRouteResult>;
}

const ACKNOWLEDGED = { received: true };

export async function registerOimIngressRoutes(
  app: FastifyInstance,
  deps: OimIngressRoutesDeps
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );

    scope.post(
      "/api/v1/hooks/oim/:integrationKey/:connectionId",
      {
        schema: {
          description:
            "Receive one authenticated OIM delivery for an exact Integration major and Connection.",
          tags: ["ingress"],
          params: {
            type: "object",
            required: ["integrationKey", "connectionId"],
            properties: {
              integrationKey: { type: "string", minLength: 1, maxLength: 128 },
              connectionId: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
          body: {
            oneOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
          },
          response: {
            200: {
              oneOf: [
                {
                  type: "object",
                  required: ["received"],
                  properties: { received: { type: "boolean" } },
                },
                { type: "object", additionalProperties: true },
                { type: "string" },
              ],
            },
            401: {
              type: "object",
              required: ["error"],
              properties: { error: { type: "string" } },
            },
          },
        },
      },
      async (request, reply) => {
        const { integrationKey, connectionId } = request.params as {
          integrationKey: string;
          connectionId: string;
        };
        const result = await deps.receive({
          route: { integrationKey, connectionId },
          rawBody: request.body as Buffer,
          headers: request.headers,
        });
        if (result.kind === "handshake") return reply.code(200).send(result.body);
        if (result.kind === "unverified") {
          return reply.code(401).send({ error: "invalid signature" });
        }
        return reply.code(200).send(ACKNOWLEDGED);
      }
    );
  });
}
