/** Model-visible declarations for TulipFarm's governed first-party network Tools. */

export const WEB_FETCH_TOOL_DECLARATION = {
  name: "web_fetch",
  description:
    "Fetch a public HTTPS page and return its full readable content as Markdown, plus the links it carried. HTML, Markdown, text, JSON, and PDF are supported; private networks, images and other binary responses are refused. This Tool reads — it never summarises and never answers. Pass `prompt` to say what you are looking for: a large page is shrunk against it before it reaches you, so a vague prompt loses the detail you wanted. Ask the same URL again with a different prompt whenever you need something else from it — a repeat read is served from cache and costs no request.",
  mutating: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2_000 },
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
        description:
          "What to look for in this page, as a self-contained question. Resolve pronouns first: 'who wrote this article?' rather than 'who wrote it?'.",
      },
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
    "Send a governed REST or GraphQL HTTPS request and return the whole response, headers included, exactly as it came back. Use structured arguments; never run curl or wget. GraphQL subscriptions are unsupported. Nothing is summarised or filtered, so read the response you already have rather than repeating the call to look at a different part of it — a repeat request is never cached and may repeat an effect. Narrow the request itself, with query parameters, pagination or a GraphQL selection, when a response is too large.",
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
