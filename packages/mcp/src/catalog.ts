import { GITHUB_KNOWLEDGE_PRESET, type McpServerDefinition } from "@tulipfarm/schema";

export interface McpCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly url: string;
  readonly publisherEvidence: string;
  readonly authentication: readonly ("oauth" | "token")[];
  readonly requiresOAuthApp?: boolean;
  readonly setup: readonly string[];
  readonly limitations: readonly string[];
  readonly knowledgeSync: "excluded" | "requires-reviewed-adapter";
  readonly localPreset?: McpServerDefinition;
}

/** Publisher-verified candidates; connecting still requires admin approval and live discovery. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    publisher: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    publisherEvidence: "https://github.com/github/github-mcp-server",
    authentication: ["oauth", "token"],
    requiresOAuthApp: true,
    setup: [
      "Use a GitHub personal access token or register a GitHub OAuth/GitHub App for this deployment.",
      "For Knowledge sync, choose GitHub Knowledge (local) to prefill the exact supported pinned image, executable, arguments and GitHub API egress.",
      "The local preset requires an isolated runtime; production needs operator-configured Kata VM isolation on supported Linux/KVM, with no ordinary-container fallback.",
      "Connect your own personal token account using GITHUB_PERSONAL_ACCESS_TOKEN. Shared accounts and the remote GitHub server are not eligible for Knowledge sync.",
      "Discover and explicitly review get_me and get_file_contents as non-mutating Tools without per-call approval, then enable the server. The preset approves nothing.",
      "Under the personal account, open Manage Knowledge sync and select explicit .md or .txt paths on refs/heads/... branches.",
    ],
    limitations: [
      "Scopes and server configuration determine the available Tools, resources, and prompts.",
      "GitHub Enterprise Server needs a local server.",
    ],
    knowledgeSync: "requires-reviewed-adapter",
    localPreset: GITHUB_KNOWLEDGE_PRESET,
  },
  {
    id: "slack",
    name: "Slack",
    publisher: "Slack",
    url: "https://mcp.slack.com/mcp",
    publisherEvidence: "https://docs.slack.dev/ai/slack-mcp-server/",
    authentication: ["oauth"],
    requiresOAuthApp: true,
    setup: [
      "Register an eligible internal or Marketplace/directory-published Slack app with a fixed client ID and secret.",
      "Authorize user scopes; bot credentials are not MCP user credentials.",
    ],
    limitations: [
      "No dynamic client registration. Unlisted apps are not eligible.",
      "Protocol resources and prompts are unverified. Personal user authorization must not be shared between users.",
      "Slack Knowledge sync is excluded; search results cannot be persisted.",
    ],
    knowledgeSync: "excluded",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    publisher: "Google",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    publisherEvidence:
      "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
    authentication: ["oauth"],
    requiresOAuthApp: true,
    setup: [
      "Enable drive.googleapis.com and drivemcp.googleapis.com in a Google Cloud project.",
      "Configure OAuth consent and client credentials with drive.readonly or drive.file scope.",
      "Configure the prompt/response screening required by Google's MCP security guidance.",
    ],
    limitations: [
      "Preview service. Protocol resources, prompts, service accounts, and dynamic registration are unverified.",
      "File eligibility and context-access policies apply; search is not a complete inventory.",
    ],
    knowledgeSync: "requires-reviewed-adapter",
  },
  {
    id: "notion",
    name: "Notion",
    publisher: "Notion",
    url: "https://mcp.notion.com/mcp",
    publisherEvidence: "https://developers.notion.com/guides/mcp/overview",
    authentication: ["oauth"],
    setup: ["Use interactive OAuth authorization with PKCE and dynamic client registration."],
    limitations: [
      "Hosted service does not support non-interactive initial authorization.",
      "Some Tools are plan-gated; resources/prompts are unverified.",
      "Notion's older local server is no longer actively supported and is not the hosted service.",
    ],
    knowledgeSync: "requires-reviewed-adapter",
  },
  {
    id: "linear",
    name: "Linear",
    publisher: "Linear",
    url: "https://mcp.linear.app/mcp",
    publisherEvidence: "https://linear.app/docs/mcp",
    authentication: ["oauth", "token"],
    setup: [
      "Use OAuth with dynamic client registration, or a Linear API key/OAuth bearer token.",
      "Create a separate account binding for each workspace.",
    ],
    limitations: [
      "Protocol resources and prompts are unverified.",
      "The /mcp/readonly endpoint narrows Tools; it does not replace host authorization.",
      "mcp-remote is a client bridge, not a local Linear server.",
    ],
    knowledgeSync: "requires-reviewed-adapter",
  },
];
