import type { McpServerDefinition } from "./mcp";

export const GITHUB_KNOWLEDGE_SERVER_REVISION = "85598ba6e1256f7ebf4867b95d63b833c4549264";
export const GITHUB_KNOWLEDGE_IMAGE =
  "ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6";

export const GITHUB_KNOWLEDGE_PRESET = {
  id: "github-knowledge",
  label: "GitHub Knowledge (local)",
  transport: {
    type: "stdio",
    image: GITHUB_KNOWLEDGE_IMAGE,
    command: "/server/github-mcp-server",
    args: ["stdio"],
    allowedEgress: ["api.github.com"],
  },
  authentication: {
    type: "token",
    environment: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    sharedAllowed: false,
  },
} satisfies McpServerDefinition;
