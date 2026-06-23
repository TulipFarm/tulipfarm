export interface SoulAgent {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulSkill {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface SoulResource {
  name: string;
  schema: Record<string, unknown>;
  hasHooks: boolean;
  hookSource?: string;
  hookHash?: string;
  hooksEnabled: boolean;
}

export interface SoulRoutine {
  name: string;
  config: Record<string, unknown>;
  hasHooks: boolean;
}

export type McpEntry =
  | { transport: "stdio"; command: string; args?: string[] }
  | { transport: "sse"; url: string; headers?: Record<string, string> };

export interface RequiredEnvVar {
  name: string;
  label: string;
  description?: string;
  secret?: boolean;
  setup_url?: string;
  steps?: string[];
}

export interface OAuthConfig {
  authorization_url: string;
  token_url: string;
  scopes: string[];
  client_id_env: string;
  client_secret_env: string;
  token_env: string;
  token_response_path?: string;
}

export interface IntegrationManifest {
  name: string;
  type: "mcp";
  version?: string;
  description?: string;
  maintainer?: string;
  entry: McpEntry;
  required_env?: RequiredEnvVar[];
  setup_guide_path?: string;
  oauth?: OAuthConfig;
}

export interface IntegrationConnection {
  enabled: boolean;
  env?: Record<string, string>;
}

export interface SoulIntegration {
  name: string;
  manifest: IntegrationManifest;
  connection?: IntegrationConnection;
  setupGuide?: string;
}

/** Minimal logger surface (pino/console compatible) shared across soul services. */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
