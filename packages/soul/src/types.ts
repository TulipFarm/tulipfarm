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
}

export interface IntegrationManifest {
  name: string;
  type: "mcp";
  version?: string;
  description?: string;
  maintainer?: string;
  entry: McpEntry;
  required_env?: RequiredEnvVar[];
}

export interface IntegrationConnection {
  enabled: boolean;
  env?: Record<string, string>;
}

export interface SoulIntegration {
  name: string;
  manifest: IntegrationManifest;
  connection?: IntegrationConnection;
}

/** Minimal logger surface (pino/console compatible) shared across soul services. */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}
