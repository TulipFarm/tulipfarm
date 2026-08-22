/** Model-visible declarations for TulipFarm's governed first-party network Tools. */

export const WEB_FETCH_TOOL_DECLARATION = {
  name: "web_fetch",
  description:
    "Fetch a public HTTPS page and extract only the information requested. HTML, Markdown, text, and JSON are supported; private networks and binary responses are refused.",
  mutating: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url", "prompt"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2_000 },
      prompt: { type: "string", minLength: 1, maxLength: 4_000 },
    },
  },
} as const;

const HEADER_SCHEMA = {
  type: "object",
  maxProperties: 32,
  propertyNames: { pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$" },
  additionalProperties: { type: "string", maxLength: 8_192 },
} as const;

const CREDENTIAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["secret", "header"],
  properties: {
    secret: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
    header: { type: "string", pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$" },
    format: { type: "string", minLength: 7, maxLength: 256, pattern: "\\{token\\}" },
  },
} as const;

export const API_REQUEST_TOOL_DECLARATION = {
  name: "api_request",
  description:
    "Send a governed REST or GraphQL HTTPS request. Use structured arguments; never run curl or wget. GraphQL subscriptions are unsupported.",
  /** Conservative scheduling declaration; the Tool Host classifies each validated call exactly. */
  mutating: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url", "method"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2_000 },
      method: {
        type: "string",
        enum: ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"],
      },
      headers: HEADER_SCHEMA,
      body: {},
      graphql: {
        type: "object",
        additionalProperties: false,
        required: ["document"],
        properties: {
          document: { type: "string", minLength: 1, maxLength: 100_000 },
          operationName: { type: "string", minLength: 1, maxLength: 256 },
          variables: { type: "object", additionalProperties: true },
        },
      },
      credential: CREDENTIAL_SCHEMA,
    },
  },
} as const;

export const NETWORK_TOOL_DECLARATIONS = [
  WEB_FETCH_TOOL_DECLARATION,
  API_REQUEST_TOOL_DECLARATION,
] as const;
