/**
 * Model-visible declarations for the OIM integration authoring Tools.
 *
 * They live here, apart from their handlers, for the same reason the network Tools' do: the
 * offline eval Corpus measures the model against the description a deployment actually sends, and
 * a Case that hand-copied one would go stale the moment the wording moved.
 */
import { OIM_FILE_ROLES } from "./oim";

/** Well past any real manifest, and far below what a Turn can carry as one argument. */
export const OIM_MANIFEST_ARGUMENT_MAX_BYTES = 256 * 1024;
const OIM_COMPANION_ARGUMENT_MAX_BYTES = 256 * 1024;

const SLUG_PATTERN = "^[a-z][a-z0-9-]*$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";

export const INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION = {
  name: "integration_draft_review",
  description:
    "Validate and test a complete drafted OIM package, including digest-covered OpenAPI, GraphQL, guide, and offline fixture companions. Reports exactly what it would be allowed to do and writes nothing. The returned package digest is what integration_draft_create spends.",
  mutating: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["manifest"],
    properties: {
      manifest: {
        type: "string",
        minLength: 1,
        maxLength: OIM_MANIFEST_ARGUMENT_MAX_BYTES,
        description: "The full oim.yml document as YAML.",
      },
      files: {
        type: "array",
        maxItems: 32,
        description:
          "Every and only companion file in the package, with exact contents. If oim.yml omits files, their digest-covered declarations are generated from these path and role values.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "role", "content"],
          properties: {
            path: {
              type: "string",
              minLength: 1,
              maxLength: 512,
              description: "Manifest-relative path; the OIM package validator enforces its shape.",
            },
            role: { type: "string", enum: OIM_FILE_ROLES },
            content: {
              type: "string",
              maxLength: OIM_COMPANION_ARGUMENT_MAX_BYTES,
              description:
                "Exact UTF-8 file contents. Never include credentials; Connections supply them outside Tool arguments.",
            },
          },
        },
      },
      connection_id: {
        type: "string",
        minLength: 1,
        description:
          "Optional existing Connection to run the draft's declared health check with. Only the opaque ID enters this Tool; the host leases credentials outside model-visible arguments.",
      },
    },
  },
} as const;

export const INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION = {
  name: "integration_draft_create",
  description:
    "Publish the exact reviewed OIM package bytes to the soul repo under integrations/<slug>. This approval-gated second phase takes the package digest integration_draft_review returned.",
  mutating: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "package_digest"],
    properties: {
      slug: { type: "string", pattern: SLUG_PATTERN },
      package_digest: {
        type: "string",
        pattern: SHA256_PATTERN,
        description: "The digest reported by integration_draft_review for this exact package.",
      },
      replace: {
        type: "boolean",
        description: "Overwrite an integration of the same slug that is already published.",
      },
    },
  },
} as const;

export const INTEGRATION_GET_TOOL_DECLARATION = {
  name: "integration_get",
  description:
    "Read one published integration package and, for an OIM package, the capability review derived from it.",
  mutating: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: { slug: { type: "string", pattern: SLUG_PATTERN } },
  },
} as const;

export const INTEGRATION_LIST_TOOL_DECLARATION = {
  name: "integration_list",
  description: "List the integration packages published in the soul repo.",
  mutating: false,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
} as const;

export const INTEGRATION_AUTHORING_TOOL_DECLARATIONS = [
  INTEGRATION_DRAFT_REVIEW_TOOL_DECLARATION,
  INTEGRATION_DRAFT_CREATE_TOOL_DECLARATION,
  INTEGRATION_GET_TOOL_DECLARATION,
  INTEGRATION_LIST_TOOL_DECLARATION,
] as const;
