import { type Static, Type } from "@sinclair/typebox";
import { SLUG_PATTERN } from "./definitions/enums";
import { TulipFarmValidationError } from "./error";
import { validate } from "./validate";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const name = Type.String({ minLength: 1, maxLength: 256 });
const serverId = Type.String({ minLength: 1, maxLength: 128, pattern: SLUG_PATTERN });

export const McpAuthenticationSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("none"), Type.Literal("token"), Type.Literal("oauth")]),
    environment: Type.Optional(
      Type.Array(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }), {
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
      })
    ),
    sharedAllowed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export const McpTransportSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("streamable-http"),
      url: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://" }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("stdio"),
      image: Type.String({
        maxLength: 512,
        pattern: "^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$",
      }),
      command: Type.String({ minLength: 1, maxLength: 1024, pattern: "^/" }),
      args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
      allowedEgress: Type.Array(
        Type.String({ minLength: 1, maxLength: 253, pattern: "^[a-zA-Z0-9.-]+$" }),
        { maxItems: 32, uniqueItems: true }
      ),
    },
    { additionalProperties: false }
  ),
]);
export type McpTransport = Static<typeof McpTransportSchema>;

export const McpServerDefinitionSchema = Type.Object(
  {
    id: serverId,
    label: name,
    transport: McpTransportSchema,
    authentication: Type.Optional(McpAuthenticationSchema),
  },
  { additionalProperties: false }
);
export type McpServerDefinition = Static<typeof McpServerDefinitionSchema>;

export const McpIdentitySchema = Type.Object(
  {
    serverId,
    accountId: Type.Union([name, Type.Null()]),
    subjectId: name,
    configurationRevision: name,
  },
  { additionalProperties: false }
);
export type McpIdentity = Static<typeof McpIdentitySchema>;

const digest = Type.String({ minLength: 1, maxLength: 128 });
const embeddedSchema = Type.Record(Type.String(), Type.Unknown());

export const McpToolReviewSchema = Type.Object(
  {
    name,
    description: Type.Optional(Type.String({ maxLength: 2_000 })),
    inputSchema: embeddedSchema,
    digest,
    mutating: Type.Boolean(),
    requiresApproval: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const McpResourceReviewSchema = Type.Object(
  { uri: Type.String({ minLength: 1, maxLength: 4096 }), name, digest },
  { additionalProperties: false }
);

export const McpPromptReviewSchema = Type.Object(
  {
    name,
    digest,
    arguments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name,
            description: Type.Optional(Type.String({ maxLength: 2_000 })),
            required: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false }
        ),
        { maxItems: 128 }
      )
    ),
  },
  { additionalProperties: false }
);

export const McpCapabilityReviewSchema = Type.Object(
  {
    tools: Type.Array(McpToolReviewSchema, { maxItems: 512 }),
    resources: Type.Array(McpResourceReviewSchema, { maxItems: 512 }),
    prompts: Type.Array(McpPromptReviewSchema, { maxItems: 512 }),
  },
  { additionalProperties: false }
);

export const McpIntegrationDefinitionSchema = Type.Object(
  {
    server: McpServerDefinitionSchema,
    enabled: Type.Boolean(),
    reviewed: McpCapabilityReviewSchema,
  },
  { additionalProperties: false }
);

export const McpConfigureSchema = Type.Object(
  { server: McpServerDefinitionSchema, enabled: Type.Boolean() },
  { additionalProperties: false }
);

export type McpIntegrationDefinition = Static<typeof McpIntegrationDefinitionSchema>;
export type McpCapabilityReview = Static<typeof McpCapabilityReviewSchema>;
export type McpConfigure = Static<typeof McpConfigureSchema>;

export function validateMcpIntegrationDefinition(input: unknown): McpIntegrationDefinition {
  validate("integration", McpIntegrationDefinitionSchema, input);
  const authentication = input.server.authentication;
  if (
    (authentication?.type === "oauth" && input.server.transport.type !== "streamable-http") ||
    (authentication?.environment !== undefined &&
      (authentication.type !== "token" || input.server.transport.type !== "stdio"))
  ) {
    throw new TulipFarmValidationError(
      "integration",
      "/server/authentication",
      "Credential delivery does not match the MCP transport"
    );
  }
  if (input.server.transport.type === "streamable-http") {
    let endpoint: URL;
    try {
      endpoint = new URL(input.server.transport.url);
    } catch {
      throw new TulipFarmValidationError(
        "integration",
        "/server/transport/url",
        "Invalid MCP endpoint URL"
      );
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      [...endpoint.searchParams.keys()].some((key) =>
        /^(access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|client[_-]?secret|authorization|password)$/i.test(
          key
        )
      )
    ) {
      throw new TulipFarmValidationError(
        "integration",
        "/server/transport/url",
        "MCP endpoints require HTTPS without user information, fragments, or credential query parameters"
      );
    }
  }
  const identifiers = {
    tools: input.reviewed.tools.map((tool) => tool.name),
    resources: input.reviewed.resources.map((resource) => resource.uri),
    prompts: input.reviewed.prompts.map((prompt) => prompt.name),
  };
  for (const [kind, values] of Object.entries(identifiers)) {
    if (new Set(values).size !== values.length) {
      throw new TulipFarmValidationError(
        "integration",
        `/reviewed/${kind}`,
        "Reviewed MCP capability identifiers must be unique"
      );
    }
  }
  return input;
}
